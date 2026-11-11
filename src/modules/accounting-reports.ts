/** گزارش‌های مالی و حسابداری
 * گزارش‌ها فقط از اسناد قطعی و گردش‌های ذخیره‌شده خوانده می‌شوند؛ داده عملیاتی تغییر نمی‌کند.
 */
import { loadAccountingData, type AccountingData } from './accounting';
import { loadCommerceData, invoiceOutstanding, type CommerceData } from './accounting-commerce';
import { loadInventoryCostData, buildNrvAnalysis, type InventoryCostData } from './inventory-costing';
import { products } from './state';
import { enhanceDateFields } from './date-picker';
import { enhanceSelectWithSearch } from './searchable-select';
import { toast } from './ui';
import { downloadFile, dateStr, printHtmlSafely, shareFileContent } from '@/utils/helpers';

type DateRange = { from?: string; to?: string; fiscalPeriodId?: string };
type Totals = { debitRial: number; creditRial: number; balanceRial: number };
export interface AccountReportRow extends Totals { accountId: string; code: string; title: string; nature: 'debit'|'credit'; }
export interface LedgerReportRow { date: string; entryNumber: string; description: string; debitRial: number; creditRial: number; balanceRial: number; }
export interface PartyReportRow { partyId: string; partyName: string; debitRial: number; creditRial: number; balanceRial: number; }
export interface InventoryValueRow {
  productId: string;
  productName: string;
  warehouse: string;
  quantityMilli: number;
  valueRial: number;
  averageUnitCostRial: number;
  nrvUnitRial?: number;
  nrvValueRial?: number;
  reportedValueRial?: number;
  writeDownRial?: number;
  hasSellingPrice?: boolean;
}
const inRange = (date: string, range: DateRange) => (!range.from || date >= range.from) && (!range.to || date <= range.to);
const validRange = (range: DateRange) => { if (range.from && !/^\d{4}\/\d{2}\/\d{2}$/.test(range.from)) throw new Error('تاریخ شروع باید به شکل سال/ماه/روز شمسی باشد.'); if (range.to && !/^\d{4}\/\d{2}\/\d{2}$/.test(range.to)) throw new Error('تاریخ پایان باید به شکل سال/ماه/روز شمسی باشد.'); if (range.from && range.to && range.from > range.to) throw new Error('تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.'); };
function postedEntries(data: AccountingData, range: DateRange) { validRange(range); return data.journalEntries.filter(e => e.status === 'posted' && (!range.fiscalPeriodId || e.fiscalPeriodId === range.fiscalPeriodId) && inRange(e.date, range)); }
function sumLines(lines: Array<{ debitRial: number; creditRial: number }>) { return lines.reduce((s,l)=>({debitRial:s.debitRial+l.debitRial,creditRial:s.creditRial+l.creditRial}),{debitRial:0,creditRial:0}); }
export function buildTrialBalance(data: AccountingData, range: DateRange = {}): AccountReportRow[] {
  const map = new Map<string, AccountReportRow>();
  for (const entry of postedEntries(data,range)) for (const line of entry.lines) {
    const account = data.accounts.find(a=>a.id===line.accountId); if (!account) continue;
    const row = map.get(account.id) || {accountId:account.id,code:line.accountCodeSnapshot||account.code,title:line.accountTitleSnapshot||account.title,nature:account.nature,debitRial:0,creditRial:0,balanceRial:0};
    row.debitRial += line.debitRial; row.creditRial += line.creditRial; map.set(account.id,row);
  }
  return [...map.values()].map(r=>({...r,balanceRial:r.nature==='debit'?r.debitRial-r.creditRial:r.creditRial-r.debitRial})).sort((a,b)=>a.code.localeCompare(b.code,'en'));
}
/** مانده اول دوره یک حساب (اسناد قطعی قبل از تاریخ شروع بازه) */
export function buildAccountOpeningBalance(data: AccountingData, accountId: string, range: DateRange = {}): number {
  const account = data.accounts.find(a=>a.id===accountId);
  if (!account) return 0;
  if (!range.from) return 0;
  let balance = 0;
  for (const entry of postedBefore(data, range)) {
    for (const line of entry.lines.filter(l => l.accountId === accountId)) {
      balance += account.nature === 'debit' ? line.debitRial - line.creditRial : line.creditRial - line.debitRial;
    }
  }
  return balance;
}

export function buildGeneralLedger(data: AccountingData, accountId: string, range: DateRange = {}): LedgerReportRow[] {
  const account = data.accounts.find(a=>a.id===accountId); if (!account) throw new Error('حساب انتخاب‌شده پیدا نشد.');
  const opening = buildAccountOpeningBalance(data, accountId, range);
  let balance = opening;
  const rows: LedgerReportRow[] = [];
  // سطر استاندارد مانده اول دوره — فقط وقتی بازه از تاریخ مشخصی شروع شده باشد
  if (range.from) {
    rows.push({
      date: range.from,
      entryNumber: '—',
      description: 'مانده اول دوره',
      debitRial: 0,
      creditRial: 0,
      balanceRial: opening,
    });
  }
  for (const entry of postedEntries(data,range).sort((a,b)=>a.date.localeCompare(b.date)||a.number.localeCompare(b.number,'en'))) {
    for (const line of entry.lines.filter(l=>l.accountId===accountId)) {
      balance += account.nature==='debit' ? line.debitRial-line.creditRial : line.creditRial-line.debitRial;
      rows.push({date:entry.date,entryNumber:entry.number,description:line.description||entry.description,debitRial:line.debitRial,creditRial:line.creditRial,balanceRial:balance});
    }
  }
  return rows;
}
/**
 * صورت سود و زیان چندمرحله‌ای (Multi-step Income Statement)
 * منطبق با رویه رایج بین‌المللی (IAS 1 presentation + الگوی متداول بازرگانی):
 *   فروش ناخالص → کسر برگشت/تخفیف → فروش خالص
 *   − بهای تمام‌شده کالای فروش‌رفته → سود ناخالص
 *   − هزینه‌های عملیاتی → سود عملیاتی
 *   ± سایر درآمدهای عملیاتی
 *   ± درآمد/هزینه مالی → سود قبل از مالیات
 *   − مالیات بر درآمد → سود / زیان خالص
 * فیلدهای قدیمی (revenueRial, costOfGoodsSoldRial, ...) برای سازگاری با سایر بخش‌ها حفظ شده‌اند.
 *
 * قرارداد کدینگ:
 *   41 فروش · 4102 برگشت · 42 سایر درآمد عملیاتی · 43 درآمد مالی
 *   5 بهای تمام‌شده
 *   61 هزینه عملیاتی · 62 هزینه مالی · 63 مالیات بر درآمد
 */
export interface IncomeStatementLine {
  key: string;
  label: string;
  amountRial: number;
  level: 'header' | 'item' | 'subtotal' | 'total';
  isContra?: boolean;
}
export interface IncomeStatementResult {
  /** سازگاری با کدهای قبلی */
  revenueRial: number;
  costOfGoodsSoldRial: number;
  grossProfitRial: number;
  expensesRial: number;
  netProfitRial: number;
  /** فیلدهای استاندارد چندمرحله‌ای */
  grossSalesRial: number;
  salesReturnsRial: number;
  netSalesRial: number;
  otherIncomeRial: number;
  operatingExpensesRial: number;
  operatingIncomeRial: number;
  financeIncomeRial: number;
  financeExpenseRial: number;
  netFinanceRial: number;
  profitBeforeTaxRial: number;
  incomeTaxRial: number;
  lines: IncomeStatementLine[];
}
export function buildIncomeStatement(data: AccountingData, range: DateRange = {}): IncomeStatementResult {
  const rows = buildTrialBalance(data, range);
  const netOf = (codePrefix: string, nature: 'credit' | 'debit') =>
    rows
      .filter(r => r.code.startsWith(codePrefix))
      .reduce((s, r) => s + (nature === 'credit' ? r.creditRial - r.debitRial : r.debitRial - r.creditRial), 0);

  // فروش کالا/خدمات (۴۱ به‌جز برگشت) — مانده بستانکار
  const salesRows = rows.filter(r => r.code.startsWith('41') && !r.code.startsWith('4102'));
  const grossSalesRial = salesRows.reduce((s, r) => s + (r.creditRial - r.debitRial), 0);
  // برگشت از فروش و تخفیفات (۴۱۰۲) — ماهیت بدهکار، به‌عنوان کاهنده فروش
  const salesReturnsRial = Math.max(0, netOf('4102', 'debit'));
  const netSalesRial = grossSalesRial - salesReturnsRial;

  // سایر درآمدهای عملیاتی (۴۲) و درآمد مالی (۴۳)
  const otherIncomeRial = netOf('42', 'credit');
  const financeIncomeRial = netOf('43', 'credit');
  // کل درآمد گروه ۴ برای سازگاری قدیمی
  const revenueRial = netOf('4', 'credit');

  // بهای تمام‌شده (گروه ۵)
  const costOfGoodsSoldRial = netOf('5', 'debit');
  const grossProfitRial = netSalesRial - costOfGoodsSoldRial;

  // تفکیک هزینه‌ها: ۶۱ عملیاتی · ۶۲ مالی · ۶۳ مالیات
  const mapExpense = (prefix: string) =>
    rows
      .filter(r => r.code.startsWith(prefix))
      .map(r => ({ code: r.code, title: r.title, amount: r.debitRial - r.creditRial }))
      .filter(r => r.amount !== 0)
      .sort((a, b) => a.code.localeCompare(b.code, 'en'));

  const operatingExpenseRows = mapExpense('61');
  // حساب‌های گروه ۶ که هنوز زیر ۶۱/۶۲/۶۳ نیستند (سازگاری با داده قدیمی) در عملیاتی لحاظ می‌شوند
  const legacyExpenseRows = rows
    .filter(r => r.code.startsWith('6') && !r.code.startsWith('61') && !r.code.startsWith('62') && !r.code.startsWith('63'))
    .map(r => ({ code: r.code, title: r.title, amount: r.debitRial - r.creditRial }))
    .filter(r => r.amount !== 0);
  const allOperatingRows = [...operatingExpenseRows, ...legacyExpenseRows].sort((a, b) => a.code.localeCompare(b.code, 'en'));
  const financeExpenseRows = mapExpense('62');
  const taxExpenseRows = mapExpense('63');

  const operatingExpensesRial = allOperatingRows.reduce((s, r) => s + r.amount, 0);
  const financeExpenseRial = financeExpenseRows.reduce((s, r) => s + r.amount, 0);
  const incomeTaxRial = taxExpenseRows.reduce((s, r) => s + r.amount, 0);
  // سازگاری: expensesRial = همه هزینه‌های گروه ۶ به‌جز مالیات (عملیاتی + مالی)
  const expensesRial = operatingExpensesRial + financeExpenseRial;

  const operatingIncomeRial = grossProfitRial - operatingExpensesRial + otherIncomeRial;
  const netFinanceRial = financeIncomeRial - financeExpenseRial;
  const profitBeforeTaxRial = operatingIncomeRial + netFinanceRial;
  const netProfitRial = profitBeforeTaxRial - incomeTaxRial;

  const lines: IncomeStatementLine[] = [];
  lines.push({ key: 'gross_sales', label: 'فروش ناخالص کالا و خدمات', amountRial: grossSalesRial, level: 'item' });
  if (salesReturnsRial > 0) {
    lines.push({ key: 'sales_returns', label: 'کسر: برگشت از فروش و تخفیفات', amountRial: salesReturnsRial, level: 'item', isContra: true });
  }
  lines.push({ key: 'net_sales', label: 'فروش خالص', amountRial: netSalesRial, level: 'subtotal' });
  lines.push({ key: 'cogs', label: 'بهای تمام‌شده کالای فروش‌رفته', amountRial: costOfGoodsSoldRial, level: 'item', isContra: true });
  lines.push({ key: 'gross_profit', label: 'سود ناخالص', amountRial: grossProfitRial, level: 'subtotal' });

  if (allOperatingRows.length) {
    lines.push({ key: 'opex_header', label: 'هزینه‌های عملیاتی', amountRial: 0, level: 'header' });
    for (const e of allOperatingRows) {
      lines.push({ key: `opex_${e.code}`, label: e.title, amountRial: e.amount, level: 'item', isContra: true });
    }
  }
  lines.push({ key: 'opex_total', label: 'جمع هزینه‌های عملیاتی', amountRial: operatingExpensesRial, level: 'subtotal', isContra: true });
  if (otherIncomeRial !== 0) {
    lines.push({ key: 'other_income', label: 'سایر درآمدهای عملیاتی', amountRial: otherIncomeRial, level: 'item' });
  }
  lines.push({ key: 'operating_income', label: 'سود عملیاتی', amountRial: operatingIncomeRial, level: 'subtotal' });

  // بخش مالی
  if (financeIncomeRial !== 0 || financeExpenseRial !== 0) {
    lines.push({ key: 'finance_header', label: 'اقلام مالی', amountRial: 0, level: 'header' });
    if (financeIncomeRial !== 0) {
      lines.push({ key: 'finance_income', label: 'درآمد مالی', amountRial: financeIncomeRial, level: 'item' });
    }
    if (financeExpenseRows.length) {
      for (const e of financeExpenseRows) {
        lines.push({ key: `finex_${e.code}`, label: e.title, amountRial: e.amount, level: 'item', isContra: true });
      }
    } else if (financeExpenseRial !== 0) {
      lines.push({ key: 'finance_expense', label: 'هزینه مالی', amountRial: financeExpenseRial, level: 'item', isContra: true });
    }
    lines.push({ key: 'net_finance', label: 'خالص درآمد / هزینه مالی', amountRial: netFinanceRial, level: 'subtotal', isContra: netFinanceRial < 0 });
  }

  lines.push({ key: 'profit_before_tax', label: 'سود / زیان قبل از مالیات', amountRial: profitBeforeTaxRial, level: 'subtotal' });
  if (incomeTaxRial !== 0 || taxExpenseRows.length) {
    if (taxExpenseRows.length) {
      for (const e of taxExpenseRows) {
        lines.push({ key: `tax_${e.code}`, label: e.title, amountRial: e.amount, level: 'item', isContra: true });
      }
    } else {
      lines.push({ key: 'income_tax', label: 'مالیات بر درآمد', amountRial: incomeTaxRial, level: 'item', isContra: true });
    }
  } else {
    lines.push({ key: 'income_tax', label: 'مالیات بر درآمد', amountRial: 0, level: 'item', isContra: true });
  }
  lines.push({ key: 'net_profit', label: 'سود / زیان خالص دوره', amountRial: netProfitRial, level: 'total' });

  return {
    revenueRial,
    costOfGoodsSoldRial,
    grossProfitRial,
    expensesRial,
    netProfitRial,
    grossSalesRial,
    salesReturnsRial,
    netSalesRial,
    otherIncomeRial,
    operatingExpensesRial,
    operatingIncomeRial,
    financeIncomeRial,
    financeExpenseRial,
    netFinanceRial,
    profitBeforeTaxRial,
    incomeTaxRial,
    lines,
  };
}
export function buildBalanceSheet(data: AccountingData, range: DateRange = {}) {
  // ترازنامه مانده تجمعی تا تاریخ پایان است؛ تاریخ شروع برای آن اعمال نمی‌شود.
  const rows=buildTrialBalance(data,{...range,from:undefined});
  const assets=rows.filter(r=>r.code.startsWith('1')).reduce((s,r)=>s+r.debitRial-r.creditRial,0);
  const liabilities=rows.filter(r=>r.code.startsWith('2')).reduce((s,r)=>s+r.creditRial-r.debitRial,0);
  const equity=rows.filter(r=>r.code.startsWith('3')).reduce((s,r)=>s+r.creditRial-r.debitRial,0);
  return {assetsRial:assets,liabilitiesRial:liabilities,equityRial:equity,liabilitiesAndEquityRial:liabilities+equity,differenceRial:assets-liabilities-equity};
}
export function buildPartyLedger(commerce: CommerceData, accounting: AccountingData, range: DateRange = {}): PartyReportRow[] {
  const entries=postedEntries(accounting,range); const byParty=new Map<string,{debitRial:number;creditRial:number}>();
  for(const entry of entries) for(const line of entry.lines) if(line.partyId){const v=byParty.get(line.partyId)||{debitRial:0,creditRial:0};v.debitRial+=line.debitRial;v.creditRial+=line.creditRial;byParty.set(line.partyId,v)}
  return commerce.parties.filter(p=>byParty.has(p.id)).map(p=>{const v=byParty.get(p.id)!;return {partyId:p.id,partyName:p.name,...v,balanceRial:v.debitRial-v.creditRial}}).sort((a,b)=>a.partyName.localeCompare(b.partyName));
}
export function buildCashReport(commerce: CommerceData, range: DateRange = {}) {
  validRange(range); const tx=commerce.cashTransactions.filter(t=>(!range.fiscalPeriodId||t.fiscalPeriodId===range.fiscalPeriodId)&&inRange(t.date,range));
  const receipts=tx.filter(t=>t.type==='receipt').reduce((s,t)=>s+t.amountRial,0),payments=tx.filter(t=>t.type==='payment').reduce((s,t)=>s+t.amountRial,0);
  return {receiptsRial:receipts,paymentsRial:payments,netCashRial:receipts-payments,transactions:tx.slice().sort((a,b)=>a.date.localeCompare(b.date))};
}
export function buildInventoryValuation(costing: InventoryCostData, opts?: { sellingCostPercent?: number }): InventoryValueRow[] {
  const nrvMap = new Map(
    buildNrvAnalysis(costing, products, { sellingCostPercent: opts?.sellingCostPercent ?? 0 })
      .map(r => [`${r.productId}::${r.warehouse}`, r] as const),
  );
  return costing.balances
    .filter(b => b.qtyMilli > 0)
    .map(b => {
      const nrv = nrvMap.get(`${b.productId}::${b.warehouse}`);
      return {
        productId: b.productId,
        productName: products.find(p => p.id === b.productId)?.name || b.productId,
        warehouse: b.warehouse,
        quantityMilli: b.qtyMilli,
        valueRial: b.valueRial,
        averageUnitCostRial: b.averageUnitCostRial,
        nrvUnitRial: nrv?.nrvUnitRial,
        nrvValueRial: nrv?.nrvValueRial,
        reportedValueRial: nrv?.reportedValueRial ?? b.valueRial,
        writeDownRial: nrv?.writeDownRial ?? 0,
        hasSellingPrice: nrv?.hasSellingPrice,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName, 'fa'));
}

/** اسناد قطعی قبل از تاریخ شروع (برای مانده افتتاحیه) */
function postedBefore(data: AccountingData, range: DateRange) {
  validRange(range);
  return data.journalEntries.filter(e =>
    e.status === 'posted' &&
    (!range.fiscalPeriodId || e.fiscalPeriodId === range.fiscalPeriodId) &&
    (!!range.from && e.date < range.from)
  );
}
function trialFromEntries(data: AccountingData, entries: AccountingData['journalEntries']): AccountReportRow[] {
  const map = new Map<string, AccountReportRow>();
  for (const entry of entries) for (const line of entry.lines) {
    const account = data.accounts.find(a => a.id === line.accountId); if (!account) continue;
    const row = map.get(account.id) || {accountId:account.id,code:line.accountCodeSnapshot||account.code,title:line.accountTitleSnapshot||account.title,nature:account.nature,debitRial:0,creditRial:0,balanceRial:0};
    row.debitRial += line.debitRial; row.creditRial += line.creditRial; map.set(account.id, row);
  }
  return [...map.values()].map(r => ({...r, balanceRial: r.nature==='debit' ? r.debitRial-r.creditRial : r.creditRial-r.debitRial})).sort((a,b)=>a.code.localeCompare(b.code,'en'));
}

/** تراز آزمایشی ۸ ستونی: افتتاحیه + گردش دوره + اختتامیه */
export function buildTrialBalance8(data: AccountingData, range: DateRange = {}) {
  const openingRaw = range.from ? trialFromEntries(data, postedBefore(data, range)) : [] as AccountReportRow[];
  const periodRaw = buildTrialBalance(data, range);
  const ids = new Set([...openingRaw.map(r=>r.accountId), ...periodRaw.map(r=>r.accountId)]);
  const openingMap = new Map(openingRaw.map(r=>[r.accountId,r]));
  const periodMap = new Map(periodRaw.map(r=>[r.accountId,r]));
  return [...ids].map(id => {
    const o = openingMap.get(id);
    const p = periodMap.get(id);
    const account = data.accounts.find(a=>a.id===id)!;
    const openDebit = o?.debitRial || 0, openCredit = o?.creditRial || 0;
    const perDebit = p?.debitRial || 0, perCredit = p?.creditRial || 0;
    const closeDebit = openDebit + perDebit, closeCredit = openCredit + perCredit;
    const nature = account?.nature || p?.nature || o?.nature || 'debit';
    const closeBalance = nature==='debit' ? closeDebit-closeCredit : closeCredit-closeDebit;
    return {
      accountId: id,
      code: p?.code || o?.code || account?.code || '',
      title: p?.title || o?.title || account?.title || '',
      nature,
      openDebitRial: openDebit, openCreditRial: openCredit,
      periodDebitRial: perDebit, periodCreditRial: perCredit,
      closeDebitRial: closeDebit, closeCreditRial: closeCredit,
      balanceRial: closeBalance,
    };
  }).sort((a,b)=>a.code.localeCompare(b.code,'en'));
}

/** دفتر روزنامه — همه آرتیکل‌های اسناد قطعی به ترتیب تاریخ */
export function buildJournalBook(data: AccountingData, range: DateRange = {}) {
  const rows: Array<{date:string;number:string;accountCode:string;accountTitle:string;description:string;debitRial:number;creditRial:number;partyId?:string}> = [];
  for (const entry of postedEntries(data, range).sort((a,b)=>a.date.localeCompare(b.date)||a.number.localeCompare(b.number,'en'))) {
    for (const line of entry.lines) {
      const account = data.accounts.find(a=>a.id===line.accountId);
      rows.push({
        date: entry.date,
        number: entry.number,
        accountCode: line.accountCodeSnapshot || account?.code || '',
        accountTitle: line.accountTitleSnapshot || account?.title || '',
        description: line.description || entry.description,
        debitRial: line.debitRial,
        creditRial: line.creditRial,
        partyId: line.partyId,
      });
    }
  }
  return rows;
}

/** فهرست اسناد حسابداری */
export function buildVoucherList(data: AccountingData, range: DateRange = {}) {
  return postedEntries(data, range).sort((a,b)=>a.date.localeCompare(b.date)||a.number.localeCompare(b.number,'en')).map(e => {
    const totals = sumLines(e.lines);
    return {
      id: e.id,
      number: e.number,
      date: e.date,
      description: e.description,
      source: e.source,
      lineCount: e.lines.length,
      debitRial: totals.debitRial,
      creditRial: totals.creditRial,
    };
  });
}

/** مانده حساب‌ها در همه سطوح کدینگ (تجمیع از تفصیلی به بالا) */
export function buildAccountBalancesByLevel(data: AccountingData, range: DateRange = {}) {
  const detail = buildTrialBalance(data, range);
  const byId = new Map(detail.map(r => [r.accountId, r]));
  // attach parent rollups
  const result: Array<AccountReportRow & {level:string}> = [];
  for (const acc of [...data.accounts].filter(a=>a.isActive).sort((a,b)=>a.code.localeCompare(b.code,'en'))) {
    if (acc.level === 'detail') {
      const row = byId.get(acc.id);
      if (row) result.push({...row, level: acc.level});
      continue;
    }
    // sum children whose code starts with this code
    const children = detail.filter(r => r.code.startsWith(acc.code));
    if (!children.length) continue;
    const debitRial = children.reduce((s,r)=>s+r.debitRial,0);
    const creditRial = children.reduce((s,r)=>s+r.creditRial,0);
    result.push({
      accountId: acc.id, code: acc.code, title: acc.title, nature: acc.nature,
      debitRial, creditRial,
      balanceRial: acc.nature==='debit' ? debitRial-creditRial : creditRial-debitRial,
      level: acc.level,
    });
  }
  return result;
}
const digits=(s:string)=>s.replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const fa=(n:number)=>new Intl.NumberFormat('fa-IR').format(n);
const money=(n:number)=>`${fa(n)} ریال`;
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
let acc:AccountingData|null=null, commerce:CommerceData|null=null, costing:InventoryCostData|null=null;
const el=<T extends HTMLElement>(q:string)=>document.querySelector<T>(q);
function range():DateRange{return {from:digits(el<HTMLInputElement>('#arFrom')?.value||'')||undefined,to:digits(el<HTMLInputElement>('#arTo')?.value||'')||undefined,fiscalPeriodId:el<HTMLSelectElement>('#arPeriod')?.value||undefined};}
function selectedParty():string{return el<HTMLSelectElement>('#arParty')?.value||'';}
function selectedProduct():string{return el<HTMLSelectElement>('#arProduct')?.value||'';}
function selectedMethod():string{return el<HTMLSelectElement>('#arMethod')?.value||'';}
function reportInvoices(r:DateRange,types?:string[]){
  const party=selectedParty();
  return postedInvoicesInRange(r,types).filter(i=>!party||i.partyId===party);
}

function table(headers:string[], rows:string[][]):string{
  return `<div class="table-wrap ar-table-scroll"><table class="data-table ar-report-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${headers.length}">داده‌ای برای این گزارش وجود ندارد.</td></tr>`}</tbody></table></div>`;
}

/** استایل محدوده نتایج تا صفحه بی‌نهایت بلند نشود */
function ensureReportResultStyles():void{
  if(document.getElementById('ar-report-result-styles'))return;
  const style=document.createElement('style');
  style.id='ar-report-result-styles';
  style.textContent=`
#arResult{display:flex;flex-direction:column;gap:10px;margin-top:4px;color:var(--text,#12483d)}
#arResult .ar-result-toolbar{position:sticky;top:0;z-index:3;background:var(--card,#fff);padding:6px 0 8px;border-bottom:1px solid var(--border-light,#dceee0);color:var(--text,#12483d)}
#arResult .ar-summary{flex-shrink:0}
#arResult .ar-summary-card{background:var(--primary-soft,#e5f3e8)!important;border:1px solid var(--border,#b9ddc2)!important;border-radius:10px;padding:10px 12px;color:var(--text,#12483d)}
#arResult .ar-summary-card span{color:var(--text-soft,#617d70)!important}
#arResult .ar-summary-card b{color:var(--primary-dark,#075c4d)!important}
#arResult .ar-table-scroll{
  max-height:min(52vh, 480px);
  overflow:auto;
  border:1px solid var(--border,#b9ddc2);
  border-radius:10px;
  background:var(--card,#fff);
  color:var(--text,#12483d);
  -webkit-overflow-scrolling:touch;
}
#arResult .ar-report-table{margin:0;width:100%;border-collapse:separate;border-spacing:0;color:var(--text,#12483d)}
#arResult .ar-report-table thead th{
  position:sticky;top:0;z-index:2;
  background:var(--primary-soft,#e5f3e8)!important;
  color:var(--primary-dark,#075c4d)!important;
  box-shadow:0 1px 0 var(--border,#b9ddc2);
}
#arResult .ar-report-table th,#arResult .ar-report-table td{
  padding:8px 7px;
  color:var(--text,#12483d)!important;
  border-bottom:1px solid var(--border-light,#dceee0);
  background:transparent;
}
#arResult .ar-report-table tbody tr:nth-child(even) td{background:var(--bg2,#edf7ef)}
#arResult .hint{color:var(--text-soft,#617d70)!important}
@media (max-width:640px){
  #arResult .ar-table-scroll{max-height:min(48vh, 380px)}
}
@media print{
  #arResult .ar-table-scroll{max-height:none!important;overflow:visible!important;border:none}
  #arResult .ar-result-toolbar{display:none!important}
}
`;
  document.head.appendChild(style);
}
function invTypeLabel(t:string):string{
  return t==='sale'?'فروش':t==='purchase'?'خرید':t==='return-sale'?'برگشت از فروش':t==='return-purchase'?'برگشت از خرید':t==='proforma'?'پیش‌فاکتور':t;
}
function sourceLabel(s:string):string{
  return ({manual:'دستی',opening:'افتتاحیه',sales:'فروش',purchase:'خرید',receipt:'دریافت',payment:'پرداخت',inventory:'موجودی',closing:'اختتامیه'} as Record<string,string>)[s]||s;
}
function levelLabel(l:string):string{
  return ({group:'گروه',general:'کل',subsidiary:'معین',detail:'تفصیلی'} as Record<string,string>)[l]||l;
}
function openInvoicesFor(kind:'receivable'|'payable'){
  if(!commerce)return [];
  return (commerce.invoices||[]).filter(i=>{
    if(i.status!=='posted')return false;
    const outstanding=invoiceOutstanding(i.id,commerce!);
    if(outstanding<=0)return false;
    if(kind==='receivable')return i.type==='sale'||i.type==='return-purchase';
    return i.type==='purchase'||i.type==='return-sale';
  }).map(i=>({invoice:i,outstanding:invoiceOutstanding(i.id,commerce!),party:commerce!.parties.find(p=>p.id===i.partyId)}));
}
function agingBucket(due:string, asOf:string):string{
  if(!due)return 'بدون سررسید';
  if(due>=asOf)return 'جاری / نرسیده';
  // approximate day diff from Jalali YYYY/MM/DD strings is not exact; use month-based bands via string compare helpers
  const [y1,m1,d1]=due.split('/').map(Number);
  const [y2,m2,d2]=asOf.split('/').map(Number);
  const days=((y2-y1)*365)+((m2-m1)*30)+(d2-d1);
  if(days<=30)return '۱ تا ۳۰ روز';
  if(days<=60)return '۳۱ تا ۶۰ روز';
  if(days<=90)return '۶۱ تا ۹۰ روز';
  return 'بیش از ۹۰ روز';
}
function reportHead(items:Array<[string,string]>):string{
  if(!items.length) return '';
  return `<div class="ar-summary">${items.map(([label,value])=>`<div class="ar-summary-card"><span>${label}</span><b>${value}</b></div>`).join('')}</div>`;
}
function chequeStatusLabel(s?:string):string{
  return s==='pending'?'در جریان':s==='cleared'?'وصول‌شده':s==='bounced'?'برگشتی':s==='void'?'باطل':(s||'—');
}
function lineAmountRial(line:{quantityMilli?:number;unitPriceRial?:number;discountRial?:number;totalRial?:number}):number{
  if(typeof line.totalRial==='number' && Number.isFinite(line.totalRial)) return line.totalRial;
  const qty=(line.quantityMilli||0)/1000;
  return Math.max(0, Math.round((line.unitPriceRial||0)*qty - (line.discountRial||0)));
}
function postedInvoicesInRange(r:DateRange, types?:string[]){
  return (commerce?.invoices||[]).filter(i=>{
    if(i.status!=='posted') return false;
    if(types && !types.includes(i.type)) return false;
    if(r.fiscalPeriodId && i.fiscalPeriodId!==r.fiscalPeriodId) return false;
    if(!inRange(i.date,r)) return false;
    return true;
  }).slice().sort((a,b)=>b.date.localeCompare(a.date)||b.number.localeCompare(a.number,'en'));
}
function openInvoicesInRange(kind:'receivable'|'payable', r:DateRange){
  return openInvoicesFor(kind).filter(x=>{
    if(r.fiscalPeriodId && x.invoice.fiscalPeriodId!==r.fiscalPeriodId) return false;
    return inRange(x.invoice.date, r);
  });
}
function renderReport():void{
  if(!acc||!commerce||!costing)return; const type=el<HTMLSelectElement>('#arType')?.value||'trial'; const r=range(); const host=el<HTMLDivElement>('#arResult');if(!host)return;
  try{
    if(type==='trial'){
      const rows=buildTrialBalance(acc,r);const total=sumLines(rows);
      host.innerHTML=reportHead([
        ['تعداد حساب',fa(rows.length)],
        ['جمع بدهکار',money(total.debitRial)],
        ['جمع بستانکار',money(total.creditRial)],
        ['اختلاف',money(Math.abs(total.debitRial-total.creditRial))],
      ])+table(['کد','حساب','جمع بدهکار','جمع بستانکار','مانده طبیعی'],
        rows.map(x=>[esc(x.code),esc(x.title),money(x.debitRial),money(x.creditRial),money(x.balanceRial)])
          .concat([['جمع کل','',money(total.debitRial),money(total.creditRial),'']]));
    }
    else if(type==='trial8'){
      const rows=buildTrialBalance8(acc,r);
      const tot=(key:keyof typeof rows[0])=>rows.reduce((s,x)=>s+Number(x[key]||0),0);
      host.innerHTML=reportHead([
        ['تعداد حساب',fa(rows.length)],
        ['بدهکار دوره',money(tot('periodDebitRial'))],
        ['بستانکار دوره',money(tot('periodCreditRial'))],
        ['بدهکار اختتامیه',money(tot('closeDebitRial'))],
        ['بستانکار اختتامیه',money(tot('closeCreditRial'))],
      ])+table(
        ['کد','حساب','بدهکار افتتاحیه','بستانکار افتتاحیه','بدهکار دوره','بستانکار دوره','بدهکار اختتامیه','بستانکار اختتامیه','مانده'],
        rows.map(x=>[esc(x.code),esc(x.title),money(x.openDebitRial),money(x.openCreditRial),money(x.periodDebitRial),money(x.periodCreditRial),money(x.closeDebitRial),money(x.closeCreditRial),money(x.balanceRial)])
          .concat([['جمع کل','',money(tot('openDebitRial')),money(tot('openCreditRial')),money(tot('periodDebitRial')),money(tot('periodCreditRial')),money(tot('closeDebitRial')),money(tot('closeCreditRial')),'']])
      );
    }
    else if(type==='journal'){
      const rows=buildJournalBook(acc,r);
      const debit=rows.reduce((s,x)=>s+x.debitRial,0);
      const credit=rows.reduce((s,x)=>s+x.creditRial,0);
      host.innerHTML=reportHead([
        ['تعداد آرتیکل',fa(rows.length)],
        ['جمع بدهکار',money(debit)],
        ['جمع بستانکار',money(credit)],
      ])+table(['تاریخ','شماره سند','کد حساب','عنوان حساب','شرح','بدهکار','بستانکار'],
        rows.map(x=>[esc(x.date),esc(x.number),esc(x.accountCode),esc(x.accountTitle),esc(x.description),money(x.debitRial),money(x.creditRial)]));
    }
    else if(type==='vouchers'){
      const rows=buildVoucherList(acc,r);
      const debit=rows.reduce((s,x)=>s+x.debitRial,0);
      const credit=rows.reduce((s,x)=>s+x.creditRial,0);
      host.innerHTML=reportHead([
        ['تعداد سند',fa(rows.length)],
        ['جمع بدهکار',money(debit)],
        ['جمع بستانکار',money(credit)],
      ])+table(['تاریخ','شماره','منبع','شرح','تعداد آرتیکل','بدهکار','بستانکار'],
        rows.map(x=>[esc(x.date),esc(x.number),sourceLabel(x.source),esc(x.description),fa(x.lineCount),money(x.debitRial),money(x.creditRial)]));
    }
    else if(type==='account_balances'){
      const rows=buildAccountBalancesByLevel(acc,r);
      const debit=rows.reduce((s,x)=>s+x.debitRial,0);
      const credit=rows.reduce((s,x)=>s+x.creditRial,0);
      host.innerHTML=reportHead([
        ['تعداد حساب',fa(rows.length)],
        ['جمع بدهکار',money(debit)],
        ['جمع بستانکار',money(credit)],
      ])+table(['سطح','کد','حساب','بدهکار','بستانکار','مانده'],
        rows.map(x=>[levelLabel(x.level),esc(x.code),esc(x.title),money(x.debitRial),money(x.creditRial),money(x.balanceRial)]));
    }
    else if(type==='income'){
      const x=buildIncomeStatement(acc,r);
      const lineRows=x.lines.map(l=>{
        const amount=l.level==='header'?'':(l.isContra?`(${money(l.amountRial)})`:money(l.amountRial));
        const style=l.level==='total'?'font-weight:800':l.level==='subtotal'?'font-weight:700':l.level==='header'?'font-weight:700;color:var(--text-soft)':'';
        return [`<span style="${style}">${esc(l.label)}</span>`, `<span style="${style}">${amount}</span>`];
      });
      host.innerHTML=reportHead([
        ['فروش خالص',money(x.netSalesRial)],
        ['سود ناخالص',money(x.grossProfitRial)],
        ['سود عملیاتی',money(x.operatingIncomeRial)],
        ['سود قبل از مالیات',money(x.profitBeforeTaxRial)],
        ['سود / زیان خالص',money(x.netProfitRial)],
      ])+`<p class="hint" style="margin:8px 0 12px">صورت سود و زیان چندمرحله‌ای: فروش خالص → سود ناخالص → سود عملیاتی → اقلام مالی → قبل از مالیات → مالیات → سود خالص. کدینگ: ۶۱ عملیاتی · ۶۲ مالی · ۶۳ مالیات · ۴۳ درآمد مالی. فقط اسناد قطعی در بازه لحاظ شده‌اند.</p>`
      +table(['شرح','مبلغ'], lineRows);
    }
    else if(type==='balance'){
      const x=buildBalanceSheet(acc,r);
      host.innerHTML=reportHead([
        ['دارایی‌ها',money(x.assetsRial)],
        ['بدهی‌ها',money(x.liabilitiesRial)],
        ['حقوق مالکانه',money(x.equityRial)],
        ['تراز (دارایی − بدهی − سرمایه)',money(x.assetsRial-x.liabilitiesRial-x.equityRial)],
      ])+table(['شرح','مبلغ'],[
        ['جمع دارایی‌ها',money(x.assetsRial)],
        ['جمع بدهی‌ها',money(x.liabilitiesRial)],
        ['حقوق مالکانه',money(x.equityRial)],
      ]);
    }
    else if(type==='ledger'){
      const accountId=el<HTMLSelectElement>('#arAccount')?.value||'';
      if(!accountId){
        host.innerHTML='<p class="hint">برای دفتر معین، از فهرست بالا یک <b>حساب تفصیلی</b> انتخاب کنید (مثلاً صندوق، بانک، اشخاص دریافتنی).</p>';
        return;
      }
      const account=acc.accounts.find(a=>a.id===accountId);
      const rows=buildGeneralLedger(acc,accountId,r);
      const movementRows=rows.filter(x=>x.description!=='مانده اول دوره');
      const debit=movementRows.reduce((s,x)=>s+x.debitRial,0);
      const credit=movementRows.reduce((s,x)=>s+x.creditRial,0);
      const opening=rows.length && rows[0].description==='مانده اول دوره' ? rows[0].balanceRial : 0;
      const lastBal=rows.length?rows[rows.length-1].balanceRial:0;
      const headItems: Array<[string,string]>=[
        ['حساب',esc(account?`${account.code} — ${account.title}`:accountId)],
        ['تعداد گردش',fa(movementRows.length)],
        ['جمع بدهکار دوره',money(debit)],
        ['جمع بستانکار دوره',money(credit)],
        ['مانده پایانی',money(lastBal)],
      ];
      if(r.from) headItems.splice(1,0,['مانده اول دوره',money(opening)]);
      host.innerHTML=withResultToolbar(
        reportHead(headItems)+table(['تاریخ','شماره سند','شرح','بدهکار','بستانکار','مانده'],
          rows.length?rows.map(x=>{
            const isOpen=x.description==='مانده اول دوره';
            return [
              esc(x.date),
              esc(x.entryNumber),
              isOpen?`<b>${esc(x.description)}</b>`:esc(x.description),
              isOpen?'—':money(x.debitRial),
              isOpen?'—':money(x.creditRial),
              money(x.balanceRial),
            ];
          }):[['—','—','گردشی در این بازه ثبت نشده است.','','','']])
      );
    }

    else if(type==='party'){
      const rows=buildPartyLedger(commerce,acc,r).filter(x=>!selectedParty()||x.partyId===selectedParty());
      const tot=rows.reduce((s,x)=>({d:s.d+x.debitRial,c:s.c+x.creditRial,b:s.b+x.balanceRial}),{d:0,c:0,b:0});
      host.innerHTML=reportHead([
        ['تعداد طرف حساب',fa(rows.length)],
        ['جمع بدهکار',money(tot.d)],
        ['جمع بستانکار',money(tot.c)],
        ['خالص مانده',money(tot.b)],
      ])+table(['طرف حساب','بدهکار','بستانکار','مانده'],
        rows.map(x=>[esc(x.partyName),money(x.debitRial),money(x.creditRial),money(x.balanceRial)])
          .concat(rows.length?[['جمع',money(tot.d),money(tot.c),money(tot.b)]]:[]));
    }
    else if(type==='receivables'||type==='payables'){
      const kind=type==='receivables'?'receivable':'payable';
      const open=openInvoicesInRange(kind,r).filter(x=>!selectedParty()||x.invoice.partyId===selectedParty());
      const byParty=new Map<string,{name:string;count:number;amount:number}>();
      for(const row of open){
        const id=row.invoice.partyId;
        const cur=byParty.get(id)||{name:row.party?.name||'—',count:0,amount:0};
        cur.count+=1; cur.amount+=row.outstanding; byParty.set(id,cur);
      }
      const partyRows=[...byParty.values()].sort((a,b)=>b.amount-a.amount);
      const total=open.reduce((s,x)=>s+x.outstanding,0);
      host.innerHTML=reportHead([
        [kind==='receivable'?'مطالبات باز':'بدهی‌های باز',money(total)],
        ['تعداد فاکتور',fa(open.length)],
        ['تعداد طرف حساب',fa(partyRows.length)],
      ])
        +table(['طرف حساب','تعداد فاکتور باز','مانده'],partyRows.map(x=>[esc(x.name),fa(x.count),money(x.amount)]).concat(partyRows.length?[['جمع',fa(open.length),money(total)]]:[]))
        +table(['شماره','نوع','تاریخ','سررسید','طرف حساب','مانده'],open.map(x=>[
          esc(x.invoice.number),invTypeLabel(x.invoice.type),esc(x.invoice.date),esc(x.invoice.dueDate||'—'),esc(x.party?.name||'—'),money(x.outstanding)
        ]));
    }
    else if(type==='aging'){
      const asOf=r.to||r.from||'9999/12/29';
      const all=[...openInvoicesInRange('receivable',r).filter(x=>!selectedParty()||x.invoice.partyId===selectedParty()).map(x=>({...x,kind:'مطالبات'})),...openInvoicesInRange('payable',r).filter(x=>!selectedParty()||x.invoice.partyId===selectedParty()).map(x=>({...x,kind:'بدهی'}))];
      const buckets=new Map<string,number>();
      const rows=all.map(x=>{
        const due=x.invoice.dueDate||x.invoice.date;
        const bucket=agingBucket(due,asOf);
        buckets.set(bucket,(buckets.get(bucket)||0)+x.outstanding);
        return [x.kind,esc(x.invoice.number),esc(x.party?.name||'—'),esc(x.invoice.date),esc(due),bucket,money(x.outstanding)];
      });
      const total=all.reduce((s,x)=>s+x.outstanding,0);
      host.innerHTML=reportHead([['تعداد اسناد',fa(all.length)],['جمع مانده',money(total)]])
        +table(['طبقه سررسید','جمع مانده'],[...buckets.entries()].map(([k,v])=>[esc(k),money(v)]))
        +table(['نوع','شماره فاکتور','طرف حساب','تاریخ','سررسید','طبقه','مانده'],rows);
    }
    else if(type==='vat'){
      const invs=reportInvoices(r).filter(i=>i.type!=='proforma');
      let outputTax=0,inputTax=0,saleNet=0,purchaseNet=0;
      const detail:string[][]=[];
      for(const i of invs){
        const p=commerce.parties.find(x=>x.id===i.partyId);
        const isOut=i.type==='sale'||i.type==='return-purchase';
        const isIn=i.type==='purchase'||i.type==='return-sale';
        const sign=i.type.startsWith('return')?-1:1;
        if(isOut){outputTax+=sign*i.taxRial; saleNet+=sign*i.netRial;}
        if(isIn){inputTax+=sign*i.taxRial; purchaseNet+=sign*i.netRial;}
        if(i.taxRial){
          detail.push([esc(i.date),esc(i.number),invTypeLabel(i.type),esc(p?.name||'—'),money(i.netRial),money(i.taxRial),money(i.grossRial)]);
        }
      }
      host.innerHTML=reportHead([
        ['مالیات فروش (خروجی)',money(outputTax)],
        ['مالیات خرید (ورودی)',money(inputTax)],
        ['خالص مالیات',money(outputTax-inputTax)],
        ['فروش خالص',money(saleNet)],
        ['خرید خالص',money(purchaseNet)],
      ])+table(['تاریخ','شماره','نوع','طرف حساب','خالص','مالیات','مبلغ نهایی'],detail);
    }
    else if(type==='sale_by_party'||type==='purchase_by_party'){
      const isSale=type==='sale_by_party';
      const types=isSale?['sale','return-sale']:['purchase','return-purchase'];
      const map=new Map<string,{name:string;count:number;net:number;tax:number;gross:number}>();
      for(const i of reportInvoices(r, types)){
        const sign=i.type.startsWith('return')?-1:1;
        const p=commerce.parties.find(x=>x.id===i.partyId);
        const cur=map.get(i.partyId)||{name:p?.name||'—',count:0,net:0,tax:0,gross:0};
        cur.count+=1; cur.net+=sign*i.netRial; cur.tax+=sign*i.taxRial; cur.gross+=sign*i.grossRial;
        map.set(i.partyId,cur);
      }
      const rows=[...map.values()].sort((a,b)=>b.gross-a.gross);
      const tot=rows.reduce((s,x)=>({count:s.count+x.count,net:s.net+x.net,tax:s.tax+x.tax,gross:s.gross+x.gross}),{count:0,net:0,tax:0,gross:0});
      host.innerHTML=reportHead([
        [isSale?'فروش نهایی':'خرید نهایی',money(tot.gross)],
        ['خالص',money(tot.net)],
        ['مالیات',money(tot.tax)],
        ['تعداد فاکتور',fa(tot.count)],
        ['تعداد طرف حساب',fa(rows.length)],
      ])+table([isSale?'مشتری':'تأمین‌کننده','تعداد فاکتور','خالص','مالیات','مبلغ نهایی'],
        rows.map(x=>[esc(x.name),fa(x.count),money(x.net),money(x.tax),money(x.gross)])
          .concat(rows.length?[['جمع',fa(tot.count),money(tot.net),money(tot.tax),money(tot.gross)]]:[]));
    }
    else if(type==='product_sales'){
      const map=new Map<string,{name:string;qty:number;amount:number;discount:number}>();
      for(const i of reportInvoices(r, ['sale','return-sale'])){
        const sign=i.type==='return-sale'?-1:1;
        for(const line of i.lines||[]){
          if(selectedProduct() && line.productId!==selectedProduct()) continue;
          const key=line.productId||line.description||'—';
          const name=line.productId?(products.find(p=>p.id===line.productId)?.name||line.description):line.description;
          const cur=map.get(key)||{name:name||'—',qty:0,amount:0,discount:0};
          const qty=(line.quantityMilli||0)/1000;
          const grossLine=(line.unitPriceRial||0)*qty;
          cur.qty+=sign*qty;
          cur.amount+=sign*grossLine;
          cur.discount+=sign*(line.discountRial||0);
          map.set(key,cur);
        }
      }
      const rows=[...map.values()].sort((a,b)=>b.amount-a.amount);
      const tot=rows.reduce((s,x)=>({qty:s.qty+x.qty,amount:s.amount+x.amount,discount:s.discount+x.discount}),{qty:0,amount:0,discount:0});
      host.innerHTML=reportHead([
        ['تعداد اقلام',fa(rows.length)],
        ['جمع تعداد',fa(tot.qty)],
        ['جمع مبلغ',money(tot.amount)],
        ['جمع تخفیف',money(tot.discount)],
        ['خالص',money(tot.amount-tot.discount)],
      ])+table(['کالا / خدمت','تعداد','مبلغ','تخفیف','خالص'],
        rows.map(x=>[esc(x.name),fa(x.qty),money(x.amount),money(x.discount),money(x.amount-x.discount)])
          .concat(rows.length?[['جمع',fa(tot.qty),money(tot.amount),money(tot.discount),money(tot.amount-tot.discount)]]:[]));
    }
    else if(type==='returns'){
      const invs=reportInvoices(r, ['return-sale','return-purchase']);
      const tot=invs.reduce((s,i)=>({net:s.net+i.netRial,tax:s.tax+i.taxRial,gross:s.gross+i.grossRial}),{net:0,tax:0,gross:0});
      host.innerHTML=reportHead([
        ['تعداد برگشت',fa(invs.length)],
        ['خالص',money(tot.net)],
        ['مالیات',money(tot.tax)],
        ['مبلغ نهایی',money(tot.gross)],
      ])+table(['تاریخ','شماره','نوع','طرف حساب','خالص','مالیات','مبلغ نهایی'],
        invs.map(i=>{
          const p=commerce!.parties.find(x=>x.id===i.partyId);
          return [esc(i.date),esc(i.number),invTypeLabel(i.type),esc(p?.name||'—'),money(i.netRial),money(i.taxRial),money(i.grossRial)];
        }));
    }
    else if(type==='cheques_recv'||type==='cheques_pay'||type==='cheques'){
      const want=type==='cheques_recv'?'receipt':type==='cheques_pay'?'payment':null;
      const cheques=(commerce.cashTransactions||[]).filter(t=>
        t.method==='cheque' && (!want||t.type===want) && (!selectedParty()||t.partyId===selectedParty()) &&
        (!r.fiscalPeriodId||t.fiscalPeriodId===r.fiscalPeriodId) && inRange(t.date,r)
      ).slice().sort((a,b)=>(b.chequeDueDate||b.date).localeCompare(a.chequeDueDate||a.date));
      const byStatus=new Map<string,number>();
      let sum=0;
      for(const t of cheques){
        const st=chequeStatusLabel(t.chequeStatus);
        byStatus.set(st,(byStatus.get(st)||0)+1);
        sum+=t.amountRial;
      }
      host.innerHTML=reportHead([
        ['تعداد چک',fa(cheques.length)],
        ['جمع مبلغ',money(sum)],
        ...[...byStatus.entries()].map(([k,v])=>[k,fa(v)] as [string,string]),
      ])+table(['تاریخ ثبت','شماره سند','طرف حساب','مبلغ','شماره چک','بانک','سررسید','وضعیت'],cheques.map(t=>{
        const p=commerce!.parties.find(x=>x.id===t.partyId);
        return [esc(t.date),esc(t.number),esc(p?.name||'—'),money(t.amountRial),esc(t.chequeNumber||'—'),esc(t.chequeBank||'—'),esc(t.chequeDueDate||'—'),chequeStatusLabel(t.chequeStatus)];
      }));
    }
    else if(type==='purchase_detail'||type==='sale_detail'){
      const isSale=type==='sale_detail';
      const types=isSale?['sale','return-sale']:['purchase','return-purchase'];
      const productId=selectedProduct();
      const invs=reportInvoices(r, types);
      const invRows:string[][]=[];
      const lineRows:string[][]=[];
      let sumNet=0,sumTax=0,sumGross=0,sumLines=0,matchedInvoices=0;
      for(const inv of invs){
        const p=commerce.parties.find(x=>x.id===inv.partyId);
        const sign=inv.type.startsWith('return')?-1:1;
        // اگر کالا انتخاب شده، فقط اقلام همان کالا و فقط فاکتورهایی که حداقل یک قلم منطبق دارند
        const matchedLines=(inv.lines||[]).filter(line=>!productId||line.productId===productId);
        if(productId && matchedLines.length===0) continue;
        matchedInvoices++;
        // با فیلتر کالا، جمع فاکتور از روی اقلام منطبق حساب می‌شود (نه کل فاکتور)
        let invNet=0, invTax=0, invGross=0;
        if(productId){
          for(const line of matchedLines){
            const lineTotal=lineAmountRial(line);
            invNet+=lineTotal;
          }
          // مالیات متناسب تقریبی بر اساس سهم خالص از فاکتور
          const ratio=inv.netRial>0?invNet/inv.netRial:0;
          invTax=Math.round((inv.taxRial||0)*ratio);
          invGross=invNet+invTax;
        }else{
          invNet=inv.netRial; invTax=inv.taxRial; invGross=inv.grossRial;
        }
        sumNet+=sign*invNet; sumTax+=sign*invTax; sumGross+=sign*invGross;
        invRows.push([esc(inv.date),esc(inv.number),invTypeLabel(inv.type),esc(p?.name||'—'),money(invNet),money(invTax),money(invGross)]);
        for(const line of matchedLines){
          const qty=(line.quantityMilli||0)/1000;
          const lineTotal=lineAmountRial(line);
          sumLines+=sign*lineTotal;
          lineRows.push([
            esc(inv.date),esc(inv.number),esc(p?.name||'—'),esc(line.description||'—'),
            esc(line.unit||'عدد'),fa(qty),money(line.unitPriceRial||0),money(line.discountRial||0),money(lineTotal)
          ]);
        }
      }
      host.innerHTML=reportHead([
        ['تعداد فاکتور',fa(matchedInvoices)],
        ['خالص',money(sumNet)],
        ['مالیات',money(sumTax)],
        ['مبلغ نهایی',money(sumGross)],
        ['جمع اقلام',money(sumLines)],
      ])
        +`<h4 class="ar-section-title">خلاصه فاکتورها</h4>`
        +table(['تاریخ','شماره','نوع','طرف حساب','خالص','مالیات','مبلغ نهایی'],invRows)
        +`<h4 class="ar-section-title">ریز اقلام</h4>`
        +table(['تاریخ','شماره','طرف حساب','شرح کالا/خدمت','واحد','تعداد','فی','تخفیف','مبلغ'],lineRows);
    }

    else if(type==='monthly'){
      const map=new Map<string,{sale:number;purchase:number;receipt:number;payment:number}>();
      const bump=(date:string,key:'sale'|'purchase'|'receipt'|'payment',amount:number)=>{
        const m=date.slice(0,7); if(!/^\d{4}\/\d{2}$/.test(m))return;
        const row=map.get(m)||{sale:0,purchase:0,receipt:0,payment:0}; row[key]+=amount; map.set(m,row);
      };
      for(const i of commerce.invoices||[]){
        if(i.status!=='posted'||(r.fiscalPeriodId&&i.fiscalPeriodId!==r.fiscalPeriodId)||!inRange(i.date,r))continue;
        if(i.type==='sale')bump(i.date,'sale',i.grossRial);
        if(i.type==='purchase')bump(i.date,'purchase',i.grossRial);
      }
      for(const t of commerce.cashTransactions||[]){
        if((r.fiscalPeriodId&&t.fiscalPeriodId!==r.fiscalPeriodId)||!inRange(t.date,r))continue;
        if(t.chequeStatus==='bounced'||t.chequeStatus==='void')continue;
        if(t.type==='receipt')bump(t.date,'receipt',t.amountRial);
        if(t.type==='payment')bump(t.date,'payment',t.amountRial);
      }
      const months=[...map.keys()].sort();
      const tot=months.reduce((s,m)=>{const x=map.get(m)!;return {sale:s.sale+x.sale,purchase:s.purchase+x.purchase,receipt:s.receipt+x.receipt,payment:s.payment+x.payment};},{sale:0,purchase:0,receipt:0,payment:0});
      host.innerHTML=reportHead([
        ['تعداد ماه',fa(months.length)],
        ['جمع فروش',money(tot.sale)],
        ['جمع خرید',money(tot.purchase)],
        ['جمع دریافت',money(tot.receipt)],
        ['جمع پرداخت',money(tot.payment)],
        ['خالص نقد',money(tot.receipt-tot.payment)],
      ])+table(['ماه','فروش','خرید','دریافت','پرداخت','خالص نقد'],months.map(m=>{
        const x=map.get(m)!;
        return [esc(m),money(x.sale),money(x.purchase),money(x.receipt),money(x.payment),money(x.receipt-x.payment)];
      }).concat(months.length?[['جمع',money(tot.sale),money(tot.purchase),money(tot.receipt),money(tot.payment),money(tot.receipt-tot.payment)]]:[]));
    }
    else if(type==='daily'){
      const map=new Map<string,{sale:number;purchase:number;receipt:number;payment:number}>();
      const bump=(date:string,key:'sale'|'purchase'|'receipt'|'payment',amount:number)=>{
        const row=map.get(date)||{sale:0,purchase:0,receipt:0,payment:0}; row[key]+=amount; map.set(date,row);
      };
      for(const i of commerce.invoices||[]){
        if(i.status!=='posted'||(r.fiscalPeriodId&&i.fiscalPeriodId!==r.fiscalPeriodId)||!inRange(i.date,r))continue;
        if(i.type==='sale')bump(i.date,'sale',i.grossRial);
        if(i.type==='purchase')bump(i.date,'purchase',i.grossRial);
      }
      for(const t of commerce.cashTransactions||[]){
        if((r.fiscalPeriodId&&t.fiscalPeriodId!==r.fiscalPeriodId)||!inRange(t.date,r))continue;
        if(t.chequeStatus==='bounced'||t.chequeStatus==='void')continue;
        if(t.type==='receipt')bump(t.date,'receipt',t.amountRial);
        if(t.type==='payment')bump(t.date,'payment',t.amountRial);
      }
      const days=[...map.keys()].sort();
      const tot=days.reduce((s,d)=>{const x=map.get(d)!;return {sale:s.sale+x.sale,purchase:s.purchase+x.purchase,receipt:s.receipt+x.receipt,payment:s.payment+x.payment};},{sale:0,purchase:0,receipt:0,payment:0});
      host.innerHTML=reportHead([
        ['تعداد روز',fa(days.length)],
        ['جمع فروش',money(tot.sale)],
        ['جمع خرید',money(tot.purchase)],
        ['جمع دریافت',money(tot.receipt)],
        ['جمع پرداخت',money(tot.payment)],
        ['خالص نقد',money(tot.receipt-tot.payment)],
      ])+table(['تاریخ','فروش','خرید','دریافت','پرداخت','خالص نقد'],days.map(d=>{
        const x=map.get(d)!;
        return [esc(d),money(x.sale),money(x.purchase),money(x.receipt),money(x.payment),money(x.receipt-x.payment)];
      }).concat(days.length?[['جمع',money(tot.sale),money(tot.purchase),money(tot.receipt),money(tot.payment),money(tot.receipt-tot.payment)]]:[]));
    }
    else if(type==='revenues'||type==='expenses'){
      const wantExpense=type==='expenses';
      const byAcc=new Map<string,{code:string;title:string;debit:number;credit:number}>();
      for(const entry of (acc.journalEntries||[]).filter(e=>e.status==='posted'&&(!r.fiscalPeriodId||e.fiscalPeriodId===r.fiscalPeriodId)&&inRange(e.date,r))){
        for(const line of entry.lines||[]){
          const a=acc.accounts.find(x=>x.id===line.accountId);
          if(!a||a.level!=='detail')continue;
          const match=wantExpense
            ? (/^6/.test(a.code) || /هزینه/.test(a.title))
            : (/^[478]/.test(a.code) || /درآمد|فروش/.test(a.title));
          if(!match || (el<HTMLSelectElement>('#arFilterAccount')?.value && a.id!==el<HTMLSelectElement>('#arFilterAccount')?.value))continue;
          const row=byAcc.get(a.id)||{code:a.code,title:a.title,debit:0,credit:0};
          row.debit+=line.debitRial; row.credit+=line.creditRial; byAcc.set(a.id,row);
        }
      }
      const rows=[...byAcc.values()].sort((a,b)=>a.code.localeCompare(b.code,'en'));
      const total=rows.reduce((s,x)=>s+(wantExpense?x.debit-x.credit:x.credit-x.debit),0);
      host.innerHTML=reportHead([
        ['تعداد حساب',fa(rows.length)],
        [wantExpense?'جمع هزینه‌ها':'جمع درآمدها',money(total)],
      ])+table(['کد','حساب','بدهکار','بستانکار','خالص'],rows.map(x=>[esc(x.code),esc(x.title),money(x.debit),money(x.credit),money(wantExpense?x.debit-x.credit:x.credit-x.debit)]))
        +table(['شرح','مبلغ'],[[wantExpense?'جمع هزینه‌ها':'جمع درآمدها',money(total)]]);
    }
    else if(type==='advanced'){
      const trial=buildTrialBalance(acc,r); const total=sumLines(trial);
      const inc=buildIncomeStatement(acc,r);
      const bal=buildBalanceSheet(acc,r);
      const cash=buildCashReport(commerce,r);
      const parties=buildPartyLedger(commerce,acc,r);
      const topParties=parties.slice().sort((a,b)=>Math.abs(b.balanceRial)-Math.abs(a.balanceRial)).slice(0,15);
      const ar=openInvoicesInRange('receivable',r).reduce((s,x)=>s+x.outstanding,0);
      const ap=openInvoicesInRange('payable',r).reduce((s,x)=>s+x.outstanding,0);
      host.innerHTML=reportHead([
        ['سود / زیان خالص',money(inc.netProfitRial)],
        ['دارایی‌ها',money(bal.assetsRial)],
        ['مطالبات باز',money(ar)],
        ['بدهی‌های باز',money(ap)],
        ['خالص جریان نقدی',money(cash.netCashRial)],
      ])
        +table(['شاخص','مبلغ'],[
          ['فروش خالص',money(inc.netSalesRial)],
          ['بهای تمام‌شده',money(inc.costOfGoodsSoldRial)],
          ['سود ناخالص',money(inc.grossProfitRial)],
          ['هزینه‌های عملیاتی',money(inc.operatingExpensesRial)],
          ['سود عملیاتی',money(inc.operatingIncomeRial)],
          ['درآمد مالی',money(inc.financeIncomeRial)],
          ['هزینه مالی',money(inc.financeExpenseRial)],
          ['سود قبل از مالیات',money(inc.profitBeforeTaxRial)],
          ['مالیات بر درآمد',money(inc.incomeTaxRial)],
          ['سود / زیان خالص',money(inc.netProfitRial)],
          ['دارایی‌ها',money(bal.assetsRial)],
          ['بدهی‌ها',money(bal.liabilitiesRial)],
          ['حقوق مالکانه',money(bal.equityRial)],
          ['مطالبات باز',money(ar)],
          ['بدهی‌های باز',money(ap)],
          ['دریافت‌ها',money(cash.receiptsRial)],
          ['پرداخت‌ها',money(cash.paymentsRial)],
          ['خالص جریان نقدی',money(cash.netCashRial)],
          ['جمع بدهکار تراز',money(total.debitRial)],
          ['جمع بستانکار تراز',money(total.creditRial)],
        ])
        +table(['طرف حساب (بیشترین مانده)','مانده'],topParties.map(x=>[esc(x.partyName),money(x.balanceRial)]));
    }
    else if(type==='cash'){
      const x=buildCashReport(commerce,r);
      const cashRows=x.transactions.filter(t=>(!selectedParty()||t.partyId===selectedParty())&&(!selectedMethod()||t.method===selectedMethod()));
      const receipts=cashRows.filter(t=>t.type==='receipt').reduce((a,t)=>a+t.amountRial,0);
      const payments=cashRows.filter(t=>t.type==='payment').reduce((a,t)=>a+t.amountRial,0);
      host.innerHTML=reportHead([
        ['دریافت‌ها',money(receipts)],
        ['پرداخت‌ها',money(payments)],
        ['خالص جریان نقدی',money(receipts-payments)],
        ['تعداد تراکنش',fa(cashRows.length)],
      ])+table(['تاریخ','شماره','نوع','روش','طرف حساب','مبلغ'],cashRows.map(t=>{
        const method=t.method==='cheque'?'چک':t.method==='card'?'کارت':t.method==='bank'||t.method==='transfer'?'بانک':'نقد';
        return [esc(t.date),esc(t.number),t.type==='receipt'?'دریافت':'پرداخت',method,esc(commerce!.parties.find(p=>p.id===t.partyId)?.name||'—'),money(t.amountRial)];
      }));
    }
    else if(type==='inventory'){
      const rows=buildInventoryValuation(costing).filter(x=>(!selectedProduct()||x.productId===selectedProduct())&&(!el<HTMLSelectElement>('#arWarehouse')?.value||x.warehouse===el<HTMLSelectElement>('#arWarehouse')?.value));
      const qty=rows.reduce((s,x)=>s+x.quantityMilli,0)/1000;
      const value=rows.reduce((s,x)=>s+x.valueRial,0);
      const reported=rows.reduce((s,x)=>s+(x.reportedValueRial??x.valueRial),0);
      const writeDown=rows.reduce((s,x)=>s+(x.writeDownRial||0),0);
      host.innerHTML=reportHead([
        ['تعداد ردیف',fa(rows.length)],
        ['جمع موجودی',fa(qty)],
        ['ارزش بهای تمام‌شده',money(value)],
        ['ارزش پس از NRV',money(reported)],
        ['کاهش ارزش پیشنهادی',money(writeDown)],
      ])+`<p class="hint" style="margin:8px 0">طبق IAS 2 ارزش گزارش‌شده = حداقل بهای تمام‌شده و خالص ارزش فروش (قیمت فروش منهای هزینه فروش برآوردی). ثبت رسمی کاهش ارزش از بخش انبار → NRV انجام می‌شود.</p>`
      +table(['کالا','انبار','موجودی','بهای تمام‌شده','NRV','ارزش گزارش‌شده','کاهش ارزش'],
        rows.map(x=>[esc(x.productName),esc(x.warehouse),fa(x.quantityMilli/1000),money(x.valueRial),x.hasSellingPrice?money(x.nrvValueRial||0):'قیمت فروش ندارد',money(x.reportedValueRial??x.valueRial),money(x.writeDownRial||0)])
          .concat(rows.length ? [['جمع','',fa(qty),money(value),'',money(reported),money(writeDown)]] : []));
    }
    else {
      host.innerHTML='<p class="hint">این نوع گزارش پشتیبانی نشده است.</p>';
    }

    // نوار جستجو برای همه گزارش‌های دارای جدول (دفتر معین خودش از قبل دارد)
    if (host.querySelector('table') && !host.querySelector('#arSearch')) {
      host.innerHTML = withResultToolbar(host.innerHTML);
    }
    ensureReportResultStyles();
    bindResultSearch();
    // اسکرول نرم به ابتدای نتایج؛ بدون کش آمدن کل صفحه
    queueMicrotask(()=>{
      host.scrollIntoView({behavior:'smooth', block:'nearest'});
      const scroller=host.querySelector<HTMLElement>('.ar-table-scroll');
      if(scroller) scroller.scrollTop=0;
    });

  }catch(e){host.innerHTML=`<p class="hint">${esc(e instanceof Error?e.message:'خطا در تهیه گزارش')}</p>`;}
}

/** نوار جستجوی سریع روی نتایج جدول */
function withResultToolbar(bodyHtml: string): string {
  return `<div class="ar-result-toolbar" style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:0 0 12px">
    <label class="field" style="margin:0;flex:1;min-width:200px">
      <span>جستجو در نتایج</span>
      <input type="search" id="arSearch" placeholder="کد، عنوان، شرح، شماره سند، طرف‌حساب..." autocomplete="off">
    </label>
    <span class="hint" id="arSearchMeta" style="padding-bottom:8px;white-space:nowrap"></span>
  </div>${bodyHtml}`;
}

function bindResultSearch(): void {
  const input = el<HTMLInputElement>('#arSearch');
  const meta = el<HTMLElement>('#arSearchMeta');
  const host = el<HTMLDivElement>('#arResult');
  if (!input || !host) return;
  const apply = () => {
    const q = digits(input.value).trim().toLowerCase();
    const rows = [...host.querySelectorAll<HTMLTableRowElement>('table tbody tr')];
    let visible = 0;
    for (const tr of rows) {
      const text = digits(tr.textContent || '').toLowerCase();
      const show = !q || text.includes(q);
      tr.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    if (meta) {
      meta.textContent = q
        ? `${fa(visible)} از ${fa(rows.length)} ردیف`
        : (rows.length ? `${fa(rows.length)} ردیف` : '');
    }
  };
  input.addEventListener('input', apply);
  input.addEventListener('search', apply);
  apply();
}

function exportCsv():void{
  const host=el<HTMLDivElement>('#arResult');
  if(!host)return;
  const tables=[...host.querySelectorAll('table')];
  if(!tables.length){
    toast('ابتدا گزارش را تهیه کنید','error');
    return;
  }
  // همه جدول‌های نتیجهٔ فعلی (نه فقط جدول اول) + فقط ردیف‌های قابل‌نمایش
  const blocks:string[]=[];
  for(const tableEl of tables){
    const rows=[...tableEl.querySelectorAll('tr')].filter(tr=>{
      const d=(tr as HTMLElement).style?.display;
      return d!=='none';
    }).map(tr=>
      [...tr.querySelectorAll('th,td')].map(td=>'"'+(td.textContent||'').replace(/"/g,'""')+'"').join(',')
    );
    if(rows.length) blocks.push(rows.join('\r\n'));
  }
  if(!blocks.length){
    toast('داده‌ای برای خروجی وجود ندارد','error');
    return;
  }
  const title=reportTitle(activeReportId||'report');
  const filename=`anbarin-${activeReportId||'report'}-${dateStr()}.csv`;
  downloadFile('\ufeff'+blocks.join('\r\n\r\n'), filename, 'text/csv;charset=utf-8');
  toast(`خروجی «${title}» آماده شد`,'success');
}

function buildPrintHtml():string|null{
  const host=el<HTMLDivElement>('#arResult');
  if(!host)return null;
  // فقط نتیجهٔ فعلی گزارش — همه جدول‌ها و عنوان‌ها، نه فقط جدول اول
  const tables=[...host.querySelectorAll('table')];
  if(!tables.length && !host.querySelector('.ar-summary')){
    toast('ابتدا گزارش را تهیه کنید','error');
    return null;
  }
  const title=reportTitle(activeReportId||'report');
  const metaParts:string[]=[];
  const period=el<HTMLSelectElement>('#arPeriod');
  if(period?.value){
    const opt=period.selectedOptions[0];
    if(opt)metaParts.push(`سال مالی: ${opt.textContent||''}`);
  }
  const from=el<HTMLInputElement>('#arFrom')?.value?.trim();
  const to=el<HTMLInputElement>('#arTo')?.value?.trim();
  if(from||to)metaParts.push(`بازه: ${from||'—'} تا ${to||'—'}`);
  const partySel=el<HTMLSelectElement>('#arParty');
  if(partySel?.value){const o=partySel.selectedOptions[0]; if(o)metaParts.push(`طرف حساب: ${o.textContent||''}`);}
  const productSel=el<HTMLSelectElement>('#arProduct');
  if(productSel?.value){const o=productSel.selectedOptions[0]; if(o)metaParts.push(`کالا: ${o.textContent||''}`);}

  // کل محتوای نتیجهٔ فعلی (خلاصه + عنوان‌ها + همه جدول‌ها) — ردیف‌های مخفی جستجو حذف شوند
  const clone=host.cloneNode(true) as HTMLElement;
  clone.querySelector('.ar-result-toolbar')?.remove();
  clone.querySelectorAll('tr').forEach(tr=>{
    const style=(tr as HTMLElement).style?.display;
    if(style==='none') tr.remove();
  });
  const bodyContent=clone.innerHTML;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — انبارین پرو</title><style>
@page{size:A4 landscape;margin:10mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#17231e;font-family:Tahoma,Arial,sans-serif;direction:rtl;font-size:11px}
h1{font-size:18px;margin:0 0 8px;color:#176b4b}
.meta{padding:8px 10px;border:1px solid #cbd5d0;border-radius:6px;margin-bottom:10px;line-height:1.9;font-size:11px;color:#334}
.hint{color:#555;font-size:10px;margin:6px 0 10px}
table{width:100%;border-collapse:collapse;margin-top:8px;table-layout:auto}
thead{display:table-header-group}
tr{break-inside:avoid;page-break-inside:avoid}
th,td{border:1px solid #aebbb4;padding:6px 5px;text-align:right;vertical-align:top;overflow-wrap:anywhere;font-size:10px}
th{background:#e8f3ed;font-weight:700}
tbody tr:nth-child(even){background:#f7faf8}
.footer{margin-top:12px;text-align:left;color:#666;font-size:9px}
.ar-summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.ar-summary-card{border:1px solid #c5d5cc;border-radius:6px;padding:8px 10px;min-width:120px;background:#f4faf6}
.ar-summary-card span{display:block;font-size:10px;color:#555;margin-bottom:4px}
.ar-summary-card b{font-size:12px}
.report-head,.report-summary,.kpi-row,.summary-row{margin-bottom:10px}
@media screen{body{padding:16px;max-width:1100px;margin:auto}}
@media print{body{padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}button{display:none!important}}
</style></head><body>
<h1>${esc(title)} — انبارین پرو</h1>
<div class="meta">${esc(metaParts.join(' | ')||'بدون فیلتر خاص')}<br>تاریخ تهیه: ${esc(new Date().toLocaleString('fa-IR'))}</div>
<p class="hint">گزارش فقط‌خواندنی از اسناد و فاکتورهای قطعی؛ داده عملیاتی تغییر نمی‌کند.</p>
${bodyContent}
<div class="footer">انبارین پرو · گزارش حسابداری</div>
</body></html>`;
}

function printReport():void{
  const html=buildPrintHtml();
  if(!html)return;
  const title=reportTitle(activeReportId||'report');
  printHtmlSafely(html, `گزارش-${activeReportId||'accounting'}`, {
    onSuccess: () => toast('پنجره چاپ باز شد؛ پس از اتمام به همین گزارش برمی‌گردید', 'success'),
    onError: () => toast('باز کردن چاپ ناموفق بود؛ دوباره تلاش کنید', 'error'),
  });
}

/** اشتراک همان نتیجهٔ فعلی گزارش (نه گزارش قبلی) */
async function shareReport():Promise<void>{
  const html=buildPrintHtml();
  if(!html)return;
  const title=reportTitle(activeReportId||'report');
  const safe=(activeReportId||'report').replace(/[^\w\u0600-\u06FF-]+/g,'_');
  const fileName=`anbarin-report-${safe}-${dateStr()}.html`;
  const mime='text/html;charset=utf-8';
  const shareResult=await shareFileContent(html,fileName,mime,{
    title: `${title} — انبارین پرو`,
    text: `گزارش ${title}`,
  });
  if(shareResult==='shared'){
    toast('گزارش آماده ارسال است؛ پیام‌رسان یا Drive را انتخاب کنید','success');
    return;
  }
  if(shareResult==='cancelled')return;
  // اگر اشتراک در دسترس نبود، ذخیره به‌عنوان جایگزین
  const saved=await downloadFile(html,fileName,mime);
  if(saved==='saved') toast('اشتراک در دسترس نبود؛ فایل گزارش ذخیره شد','success');
  else if(saved!=='cancelled') toast('اشتراک‌گذاری در این دستگاه پشتیبانی نشد','error');
}

/** ذخیره همان نتیجهٔ فعلی گزارش روی دستگاه */
async function saveReport():Promise<void>{
  const html=buildPrintHtml();
  if(!html)return;
  const title=reportTitle(activeReportId||'report');
  const safe=(activeReportId||'report').replace(/[^\w\u0600-\u06FF-]+/g,'_');
  const fileName=`anbarin-report-${safe}-${dateStr()}.html`;
  const saved=await downloadFile(html,fileName,'text/html;charset=utf-8');
  if(saved==='saved') toast(`گزارش «${title}» ذخیره شد`,'success');
  else if(saved!=='cancelled') toast('ذخیره گزارش ناموفق بود','error');
}

const REPORT_CATALOG: Array<{group:string;items:Array<{id:string;title:string;desc:string}>}> = [
  {group:'دفاتر و اسناد',items:[
    {id:'journal',title:'دفتر روزنامه',desc:'آرتیکل‌های اسناد قطعی'},
    {id:'vouchers',title:'فهرست اسناد',desc:'لیست اسناد حسابداری'},
    {id:'ledger',title:'دفتر معین',desc:'گردش یک حساب'},
    {id:'trial',title:'تراز آزمایشی',desc:'مانده حساب‌های تفصیلی'},
    {id:'trial8',title:'تراز ۸ ستونی',desc:'افتتاحیه، گردش، اختتامیه'},
    {id:'account_balances',title:'مانده حساب‌ها',desc:'همه سطوح کدینگ'},
  ]},
  {group:'صورت‌های مالی',items:[
    {id:'income',title:'سود و زیان',desc:'چندمرحله‌ای کامل: عملیاتی → مالی → مالیات → خالص'},
    {id:'balance',title:'ترازنامه',desc:'دارایی، بدهی، سرمایه'},
    {id:'advanced',title:'داشبورد مدیریتی',desc:'خلاصه شاخص‌های کلیدی'},
  ]},
  {group:'بازرگانی و اشخاص',items:[
    {id:'sale_detail',title:'ریز فروش',desc:'اقلام فاکتورهای فروش'},
    {id:'purchase_detail',title:'ریز خرید',desc:'اقلام فاکتورهای خرید'},
    {id:'sale_by_party',title:'فروش به تفکیک مشتری',desc:'خلاصه هر مشتری'},
    {id:'purchase_by_party',title:'خرید به تفکیک تأمین‌کننده',desc:'خلاصه هر تأمین‌کننده'},
    {id:'product_sales',title:'فروش به تفکیک کالا',desc:'تعداد و مبلغ هر کالا'},
    {id:'returns',title:'برگشت‌ها',desc:'برگشت از فروش و خرید'},
    {id:'party',title:'گردش طرف حساب',desc:'بدهکار و بستانکار اشخاص'},
    {id:'receivables',title:'بدهکاران',desc:'مطالبات باز'},
    {id:'payables',title:'بستانکاران',desc:'بدهی‌های باز'},
    {id:'aging',title:'تحلیل سررسید',desc:'طبقات سررسید مطالبات و بدهی'},
  ]},
  {group:'نقد، بانک و چک',items:[
    {id:'cash',title:'دریافت و پرداخت',desc:'جریان نقدی ثبت‌شده'},
    {id:'cheques_recv',title:'چک‌های دریافتی',desc:'وضعیت چک‌های دریافتی'},
    {id:'cheques_pay',title:'چک‌های پرداختی',desc:'وضعیت چک‌های پرداختی'},
    {id:'daily',title:'گزارش روزانه',desc:'فروش، خرید، نقد روزانه'},
    {id:'monthly',title:'گزارش ماهیانه',desc:'جمع ماهانه عملیات'},
  ]},
  {group:'مالیات، هزینه و موجودی',items:[
    {id:'vat',title:'مالیات ارزش افزوده',desc:'مالیات فروش و خرید'},
    {id:'revenues',title:'درآمدها',desc:'حساب‌های درآمد'},
    {id:'expenses',title:'هزینه‌ها',desc:'حساب‌های هزینه'},
    {id:'inventory',title:'ارزش موجودی',desc:'بهای تمام‌شده و NRV (IAS 2)'},
  ]},
];

let activeReportId: string | null = null;

function reportTitle(id:string):string{
  for(const g of REPORT_CATALOG){const it=g.items.find(x=>x.id===id);if(it)return it.title;}
  return 'گزارش';
}

function bindReportRunner():void{
  queueMicrotask(()=>enhanceDateFields(document));
  el<HTMLButtonElement>('#arRun')?.addEventListener('click',()=>{
    try{renderReport();toast('گزارش به‌روز شد','success');}catch(e){/* renderReport خودش خطا را نشان می‌دهد */}
  });
  el<HTMLButtonElement>('#arCsv')?.addEventListener('click',exportCsv);
  el<HTMLButtonElement>('#arPrint')?.addEventListener('click',printReport);
  el<HTMLButtonElement>('#arShare')?.addEventListener('click',()=>{void shareReport();});
  el<HTMLButtonElement>('#arSave')?.addEventListener('click',()=>{void saveReport();});
  el<HTMLSelectElement>('#arAccount')?.addEventListener('change',()=>{if(activeReportId==='ledger')renderReport();});
  ['#arParty','#arProduct','#arMethod','#arFilterAccount','#arWarehouse'].forEach(q=>el<HTMLSelectElement>(q)?.addEventListener('change',renderReport));
  el<HTMLButtonElement>('#arBackCatalog')?.addEventListener('click',()=>{activeReportId=null;renderReportsCatalog();});

  // کادرهای طولانی (طرف‌حساب / کالا / حساب) جستجوپذیر شوند — بدون اسکرول ۱۰۰۰تایی
  enhanceSelectWithSearch(el<HTMLSelectElement>('#arParty'), { placeholder: 'جستجوی طرف حساب...', minOptions: 6 });
  enhanceSelectWithSearch(el<HTMLSelectElement>('#arProduct'), { placeholder: 'جستجوی کالا (نام / بارکد)...', minOptions: 6 });
  enhanceSelectWithSearch(el<HTMLSelectElement>('#arAccount'), { placeholder: 'جستجوی حساب...', minOptions: 6 });
  enhanceSelectWithSearch(el<HTMLSelectElement>('#arFilterAccount'), { placeholder: 'جستجوی حساب...', minOptions: 6 });
  enhanceSelectWithSearch(el<HTMLSelectElement>('#arWarehouse'), { placeholder: 'جستجوی انبار...', minOptions: 6 });
}

function renderReportRunner(reportId:string):void{
 if(!acc||!commerce||!costing)return;
  const root=el<HTMLDivElement>('#accountingReportsWorkspace');if(!root)return;
  activeReportId=reportId;
  root.innerHTML=`
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:8px">
      <div>
        <p class="hint" style="margin:0 0 4px">گزارش‌ها</p>
        <h3 style="margin:0;border:0;padding:0">${esc(reportTitle(reportId))}</h3>
      </div>
      <button type="button" class="btn btn-secondary" id="arBackCatalog">همه گزارش‌ها</button>
    </div>
    <p class="hint">فقط اسناد و فاکتورهای قطعی؛ داده عملیاتی تغییر نمی‌کند.</p>
    <input type="hidden" id="arType" value="${esc(reportId)}">
    <div class="form-grid" id="arFilters">
      <label class="field">سال مالی<select id="arPeriod"><option value="">همه سال‌های مالی</option>${acc.fiscalPeriods.map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}</select></label>
      <label class="field">از تاریخ شمسی<input id="arFrom" placeholder="1405/01/01"></label>
      <label class="field">تا تاریخ شمسی<input id="arTo" placeholder="1405/12/29"></label>
      ${reportId==='ledger' ? `<label class="field" id="arAccountWrap"><span>حساب تفصیلی (دفتر معین)</span><select id="arAccount"><option value="">یک حساب انتخاب کنید</option>${acc.accounts.filter(a=>a.isActive&&a.level==='detail').map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('')}</select></label>
      <p class="hint" id="arAccountHint" style="grid-column:1/-1;margin:0">این گزارش گردش یک حساب مشخص را نشان می‌دهد؛ ابتدا حساب را انتخاب کنید.</p>` : ''}
      ${['party','sale_by_party','purchase_by_party','sale_detail','purchase_detail','returns','receivables','payables','aging','vat','cash','cheques_recv','cheques_pay'].includes(reportId) ? `<label class="field"><span>طرف حساب</span><select id="arParty"><option value="">همه طرف‌حساب‌ها</option>${commerce.parties.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
      ${['product_sales','sale_detail','purchase_detail','inventory'].includes(reportId) ? `<label class="field"><span>کالا</span><select id="arProduct"><option value="">همه کالاها</option>${products.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}${p.code?` — ${esc(String(p.code))}`:''}</option>`).join('')}</select></label>` : ''}
      ${reportId==='cash' ? `<label class="field"><span>روش پرداخت</span><select id="arMethod"><option value="">همه روش‌ها</option><option value="cash">نقد</option><option value="card">کارت</option><option value="bank">بانک</option><option value="transfer">انتقال</option><option value="cheque">چک</option></select></label>` : ''}
      ${['revenues','expenses'].includes(reportId) ? `<label class="field"><span>حساب</span><select id="arFilterAccount"><option value="">همه حساب‌ها</option>${acc.accounts.filter(a=>a.isActive&&a.level==='detail').map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('')}</select></label>` : ''}
      ${reportId==='inventory' ? `<label class="field"><span>انبار</span><select id="arWarehouse"><option value="">همه انبارها</option>${[...new Set(costing.balances.map(b=>b.warehouse).filter(Boolean))].sort().map(w=>`<option value="${esc(w)}">${esc(w)}</option>`).join('')}</select></label>` : ''}
    </div>
    <div class="ar-actions-bar" role="group" aria-label="عملیات گزارش">
      <button type="button" class="btn btn-primary ar-action-btn ar-action-primary" id="arRun">تهیه گزارش</button>
      <div class="ar-actions-secondary">
        <button type="button" class="btn btn-secondary ar-action-btn" id="arCsv">خروجی CSV</button>
        <button type="button" class="btn btn-secondary ar-action-btn" id="arPrint">چاپ / PDF</button>
        <button type="button" class="btn btn-secondary ar-action-btn" id="arShare">اشتراک</button>
        <button type="button" class="btn btn-secondary ar-action-btn" id="arSave">ذخیره</button>
      </div>
    </div>
    <div id="arResult" class="ar-result-panel"><p class="hint">بازه و فیلترها را مشخص کنید و «تهیه گزارش» را بزنید. نتایج در کادر اسکرول‌شونده نمایش داده می‌شوند تا صفحه طولانی نشود.</p></div>
  </div>`;
  ensureReportResultStyles();
  bindReportRunner();
  if(reportId!=='ledger')renderReport();
}

function renderReportsCatalog():void{
  const root=el<HTMLDivElement>('#accountingReportsWorkspace');if(!root)return;
  activeReportId=null;
  root.innerHTML=`
  <div class="card">
    <h3>گزارش‌ها</h3>
    <p class="hint">همه گزارش‌های حسابداری، بازرگانی، اشخاص، نقد و موجودی از این بخش در دسترس هستند.</p>
    ${REPORT_CATALOG.map(g=>`
      <div style="margin-top:18px">
        <h4 style="margin:0 0 10px;color:var(--primary-dark);font-size:0.95rem">${esc(g.group)}</h4>
        <div class="accounting-home-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
          ${g.items.map(it=>`
            <button type="button" class="accounting-home-tile" data-report-id="${esc(it.id)}" style="min-height:96px">
              <strong>${esc(it.title)}</strong>
              <span class="hint">${esc(it.desc)}</span>
            </button>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
  queueMicrotask(()=>enhanceDateFields(root));
  root.querySelectorAll<HTMLButtonElement>('[data-report-id]').forEach(btn=>{
    btn.addEventListener('click',()=>renderReportRunner(btn.dataset.reportId||'trial'));
  });
}

export async function initAccountingReportsUI():Promise<void>{
  try{
    [acc,commerce,costing]=await Promise.all([loadAccountingData(),loadCommerceData(),loadInventoryCostData()]);
    const root=el<HTMLDivElement>('#accountingReportsWorkspace');if(!root)return;
    renderReportsCatalog();
    window.addEventListener('accounting:data-updated',async()=>{
      [acc,commerce,costing]=await Promise.all([loadAccountingData(),loadCommerceData(),loadInventoryCostData()]);
      if(activeReportId)renderReport();
      else renderReportsCatalog();
    });
  }catch(e){
    console.error('[Anbarin] accounting reports init failed',e);
    toast('بارگذاری گزارش‌های مالی انجام نشد','error');
  }
}
