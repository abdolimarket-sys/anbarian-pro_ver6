/** گردش تجاری حسابداری و اتصال فاکتور به موجودی و بهای تمام‌شده. */
import { idbGet, idbPut } from './storage';
import { products, save as saveAppState, flushSave, logAudit } from './state';
import { loadInventoryCostData, saveInventoryCostData, receiveStock, issueStock, seedOpeningStock, getCostBalance, applyNrvWriteDown, buildNrvAnalysis } from './inventory-costing';
import { ensureProductStock, getWarehouseQty, setWarehouseQty, warehouseName } from './warehouse-stock';
import {
  loadAccountingData, saveAccountingData, upsertJournalEntry, postJournalEntry,
  type AccountingData, type JournalEntry, type JournalLine,
} from './accounting';

export type PartyType = 'customer' | 'supplier' | 'both';
export type InvoiceType = 'sale' | 'purchase' | 'return-sale' | 'return-purchase' | 'proforma';
export const isSaleInvoiceType = (type: InvoiceType): boolean => type === 'sale' || type === 'return-sale' || type === 'proforma';
export const isPurchaseInvoiceType = (type: InvoiceType): boolean => type === 'purchase' || type === 'return-purchase';
export const isReturnInvoiceType = (type: InvoiceType): boolean => type === 'return-sale' || type === 'return-purchase';
export type CommercialStatus = 'draft' | 'posted';
export interface AccountingParty {
  id: string; type: PartyType; name: string; nationalId: string; phone: string; address: string;
  economicCode?: string; registrationNumber?: string; postalCode?: string;
  isActive: boolean; createdAt: string; updatedAt: string;
}
export interface CommercialInvoiceLine {
  id: string; description: string; quantityMilli: number; unitPriceRial: number; totalRial: number; productId?: string; warehouse?: string; unit?: string; discountRial?: number;
  /** سهم تخصیص‌یافته از هزینه‌های جانبی خرید (ریال) — فقط پس از ثبت/قطعی‌سازی پر می‌شود */
  allocatedLandedRial?: number;
}
export interface InvoicePaymentPart { method:'cash'|'card'|'cheque'|'credit'; amountRial:number; chequeNumber?:string; chequeBank?:string; chequeAccount?:string; chequeDueDate?:string; note?:string; }
/** هزینه‌های جانبی خرید (Landed Cost) طبق IAS 2 — به بهای موجودی اضافه می‌شود */
export interface InvoiceLandedCosts {
  freightRial?: number;
  customsRial?: number;
  insuranceRial?: number;
  otherRial?: number;
  note?: string;
}
export interface CommercialInvoice {
  id: string; type: InvoiceType; number: string; date: string; fiscalPeriodId: string; partyId: string;
  description: string; lines: CommercialInvoiceLine[]; netRial: number; taxRial: number; grossRial: number; taxRateBps?: number;
  dueDate?: string; paymentTerms?: string; paymentParts?:InvoicePaymentPart[]; notes?: string;
  /** فقط برای فاکتور خرید معنادار است */
  landedCosts?: InvoiceLandedCosts;
  status: CommercialStatus; journalEntryId?: string; createdAt: string; updatedAt: string;
}
export function totalLandedCostRial(lc?: InvoiceLandedCosts | null): number {
  if (!lc) return 0;
  const parts = [lc.freightRial, lc.customsRial, lc.insuranceRial, lc.otherRial].map(n => Math.max(0, Math.round(Number(n) || 0)));
  return parts.reduce((s, n) => s + n, 0);
}
export type SettlementMethod = 'cash'|'bank'|'card'|'transfer'|'cheque';
export type ChequeStatus = 'pending'|'cleared'|'bounced'|'void';
export interface InvoiceAllocation { invoiceId: string; amountRial: number; }
export interface CashTransaction {
  id: string; type: 'receipt' | 'payment'; number: string; date: string; fiscalPeriodId: string;
  partyId: string; cashAccountId: string; amountRial: number; description: string;
  journalEntryId: string; createdAt: string;
  method?: SettlementMethod; allocations?: InvoiceAllocation[];
  chequeNumber?: string; chequeBank?: string; chequeAccount?:string; chequeNote?:string; chequeDueDate?: string; chequeStatus?: ChequeStatus;
  clearingJournalEntryId?: string;
}
export interface ChequeEndorsement { id:string; transactionId:string; toPartyId:string; invoiceId:string; date:string; amountRial:number; note:string; journalEntryId:string; createdAt:string; }
export interface CommerceData {
  schemaVersion: 1; parties: AccountingParty[]; invoices: CommercialInvoice[]; cashTransactions: CashTransaction[]; chequeEndorsements?: ChequeEndorsement[];
  companyProfile?: { name:string; nationalId:string; economicCode:string; registrationNumber:string; phone:string; address:string; postalCode:string };
}

const KEY = 'accounting_phase22_commerce';
const BACKUP = 'accounting_phase22_commerce_backup';
const now = () => new Date().toISOString();
const makeId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const isSafeMoney = (n: number) => Number.isSafeInteger(n) && n >= 0;

// سری‌سازی عملیات حساس در یک تب برای جلوگیری از ثبت هم‌زمان تکراری.
let commerceMutationTail: Promise<void> = Promise.resolve();
async function withCommerceMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = commerceMutationTail;
  let release!: () => void;
  commerceMutationTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

export const DEFAULT_CUSTOMER_PARTY_ID = 'party_default_customer';
export const DEFAULT_SUPPLIER_PARTY_ID = 'party_default_supplier';

export function emptyCommerceData(): CommerceData { return { schemaVersion: 1, parties: [], invoices: [], cashTransactions: [] }; }

/** اطمینان از وجود طرف‌حساب‌های پیش‌فرض (خریدار / فروشنده) */
export function ensureDefaultParties(data: CommerceData): CommerceData {
  const parties = [...(data.parties || [])];
  let changed = false;
  const stamp = now();
  if (!parties.some(p => p.id === DEFAULT_CUSTOMER_PARTY_ID)) {
    parties.unshift({
      id: DEFAULT_CUSTOMER_PARTY_ID,
      type: 'customer',
      name: 'خریدار پیش‌فرض',
      nationalId: '',
      phone: '',
      address: '',
      isActive: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
    changed = true;
  }
  if (!parties.some(p => p.id === DEFAULT_SUPPLIER_PARTY_ID)) {
    parties.unshift({
      id: DEFAULT_SUPPLIER_PARTY_ID,
      type: 'supplier',
      name: 'فروشنده پیش‌فرض',
      nationalId: '',
      phone: '',
      address: '',
      isActive: true,
      createdAt: stamp,
      updatedAt: stamp,
    });
    changed = true;
  }
  return changed ? { ...data, parties } : data;
}


export function checkDefaultPartyPolicy(type: InvoiceType, partyId: string, settings: { allowDefaultCustomerSales?: boolean; allowDefaultSupplierPurchases?: boolean }): void {
  if (isSaleInvoiceType(type) && partyId === DEFAULT_CUSTOMER_PARTY_ID && settings.allowDefaultCustomerSales === false) {
    throw new Error('فروش به «خریدار پیش‌فرض» در تنظیمات حسابداری غیرفعال است.');
  }
  if (isPurchaseInvoiceType(type) && partyId === DEFAULT_SUPPLIER_PARTY_ID && settings.allowDefaultSupplierPurchases === false) {
    throw new Error('خرید از «فروشنده پیش‌فرض» در تنظیمات حسابداری غیرفعال است.');
  }
}

export async function assertDefaultPartyAllowed(type: InvoiceType, partyId: string): Promise<void> {
  const acc = await loadAccountingData();
  checkDefaultPartyPolicy(type, partyId, acc.settings);
}

function validCommerceData(v: unknown): v is CommerceData {
  if (!v || typeof v !== 'object') return false;
  const x = v as Partial<CommerceData>;
  return x.schemaVersion === 1 && Array.isArray(x.parties) && Array.isArray(x.invoices) && Array.isArray(x.cashTransactions);
}
export async function loadCommerceData(): Promise<CommerceData> {
  let data: CommerceData | null = null;
  try { const v = await idbGet<unknown>(KEY); if (validCommerceData(v)) data = v; } catch (e) { console.warn('commerce read failed', e); }
  if (!data) {
    try { const v = await idbGet<unknown>(BACKUP); if (validCommerceData(v)) data = v; } catch (e) { console.warn('commerce backup read failed', e); }
  }
  if (!data) data = emptyCommerceData();
  const withDefaults = ensureDefaultParties(data);
  if (withDefaults !== data) {
    try { await saveCommerceData(withDefaults); } catch (e) { console.warn('persist default parties failed', e); }
  }
  return withDefaults;
}
export async function saveCommerceData(v: CommerceData): Promise<void> {
  if (!validCommerceData(v)) throw new Error('ساختار اطلاعات فاکتور و دریافت‌وپرداخت معتبر نیست.');
  await idbPut(BACKUP, v); await idbPut(KEY, v);
}

/** افزودن حساب‌های سیستمی حتی اگر کدینگ قبلاً مقداردهی شده باشد. */
export async function ensureCommerceAccounts(): Promise<AccountingData> {
  const data = await loadAccountingData();
  // همه حساب‌های لازم برای فاکتور/تسویه/چک — با والدین به‌ترتیب از بالا به پایین
  const additions: Array<{id:string;code:string;title:string;level:'group'|'general'|'subsidiary'|'detail';nature:'debit'|'credit';parentId:string|null}> = [
    // دارایی‌ها
    { id:'grp-assets', code:'1', title:'دارایی‌ها', level:'group', nature:'debit', parentId:null },
    { id:'acc-current-assets', code:'11', title:'دارایی‌های جاری', level:'general', nature:'debit', parentId:'grp-assets' },
    { id:'sub-cash-bank', code:'1101', title:'موجودی نقد و بانک', level:'subsidiary', nature:'debit', parentId:'acc-current-assets' },
    { id:'det-cash', code:'110101', title:'صندوق', level:'detail', nature:'debit', parentId:'sub-cash-bank' },
    { id:'det-bank', code:'110102', title:'بانک', level:'detail', nature:'debit', parentId:'sub-cash-bank' },
    { id:'sub-receivables', code:'1102', title:'حساب‌ها و اسناد دریافتنی', level:'subsidiary', nature:'debit', parentId:'acc-current-assets' },
    { id:'det-customers', code:'110201', title:'اشخاص دریافتنی', level:'detail', nature:'debit', parentId:'sub-receivables' },
    { id:'sub-inventory', code:'1103', title:'موجودی کالا', level:'subsidiary', nature:'debit', parentId:'acc-current-assets' },
    { id:'det-inventory', code:'110301', title:'موجودی کالای انبار', level:'detail', nature:'debit', parentId:'sub-inventory' },
    { id:'sub-input-tax', code:'1104', title:'مالیات و عوارض ارزش افزوده خرید', level:'subsidiary', nature:'debit', parentId:'acc-current-assets' },
    { id:'det-input-tax', code:'110401', title:'مالیات ارزش افزوده خرید', level:'detail', nature:'debit', parentId:'sub-input-tax' },
    { id:'sub-cheques-receivable', code:'1105', title:'اسناد دریافتنی', level:'subsidiary', nature:'debit', parentId:'acc-current-assets' },
    { id:'det-cheques-receivable', code:'110501', title:'چک‌های دریافتنی نزد صندوق', level:'detail', nature:'debit', parentId:'sub-cheques-receivable' },
    // بدهی‌ها
    { id:'grp-liabilities', code:'2', title:'بدهی‌ها', level:'group', nature:'credit', parentId:null },
    { id:'acc-current-liabilities', code:'21', title:'بدهی‌های جاری', level:'general', nature:'credit', parentId:'grp-liabilities' },
    { id:'sub-payables', code:'2101', title:'حساب‌ها و اسناد پرداختنی', level:'subsidiary', nature:'credit', parentId:'acc-current-liabilities' },
    { id:'det-suppliers', code:'210101', title:'اشخاص پرداختنی', level:'detail', nature:'credit', parentId:'sub-payables' },
    { id:'det-landed-payable', code:'210102', title:'هزینه‌های جانبی خرید پرداختنی', level:'detail', nature:'credit', parentId:'sub-payables' },
    { id:'sub-output-tax', code:'2102', title:'مالیات و عوارض ارزش افزوده فروش', level:'subsidiary', nature:'credit', parentId:'acc-current-liabilities' },
    { id:'det-output-tax', code:'210201', title:'مالیات ارزش افزوده فروش', level:'detail', nature:'credit', parentId:'sub-output-tax' },
    { id:'sub-cheques-payable', code:'2103', title:'اسناد پرداختنی', level:'subsidiary', nature:'credit', parentId:'acc-current-liabilities' },
    { id:'det-cheques-payable', code:'210301', title:'چک‌های پرداختنی', level:'detail', nature:'credit', parentId:'sub-cheques-payable' },
    // درآمد / فروش
    { id:'grp-revenue', code:'4', title:'درآمدها', level:'group', nature:'credit', parentId:null },
    { id:'acc-sales', code:'41', title:'فروش کالا و خدمات', level:'general', nature:'credit', parentId:'grp-revenue' },
    { id:'sub-sales-goods', code:'4101', title:'فروش کالا', level:'subsidiary', nature:'credit', parentId:'acc-sales' },
    { id:'det-sales-goods', code:'410101', title:'فروش کالای اصلی', level:'detail', nature:'credit', parentId:'sub-sales-goods' },
    // بهای تمام‌شده / خرید
    { id:'grp-cogs', code:'5', title:'بهای تمام‌شده', level:'group', nature:'debit', parentId:null },
    { id:'acc-cogs', code:'51', title:'بهای تمام‌شده کالای فروش‌رفته', level:'general', nature:'debit', parentId:'grp-cogs' },
    { id:'sub-cogs-goods', code:'5101', title:'بهای تمام‌شده کالای فروش‌رفته', level:'subsidiary', nature:'debit', parentId:'acc-cogs' },
    { id:'det-cogs-goods', code:'510101', title:'بهای تمام‌شده کالای اصلی', level:'detail', nature:'debit', parentId:'sub-cogs-goods' },
    { id:'sub-purchases', code:'5102', title:'خرید کالا', level:'subsidiary', nature:'debit', parentId:'acc-cogs' },
    { id:'det-purchases', code:'510201', title:'خرید کالا و مواد', level:'detail', nature:'debit', parentId:'sub-purchases' },
    { id:'det-purchase-discounts', code:'510202', title:'تخفیفات خرید کالا', level:'detail', nature:'credit', parentId:'sub-purchases' },
    // هزینه‌ها
    { id:'grp-expenses', code:'6', title:'هزینه‌ها', level:'group', nature:'debit', parentId:null },
    { id:'acc-operating-expenses', code:'61', title:'هزینه‌های عملیاتی', level:'general', nature:'debit', parentId:'grp-expenses' },
    { id:'sub-bank-expenses', code:'6102', title:'هزینه‌های بانکی', level:'subsidiary', nature:'debit', parentId:'acc-operating-expenses' },
    { id:'det-bank-fees', code:'610201', title:'کارمزد و هزینه خدمات بانکی', level:'detail', nature:'debit', parentId:'sub-bank-expenses' },
    // درآمد/هزینه مالی و مالیات بر درآمد (برای صورت سود و زیان استاندارد)
    { id:'acc-finance-income', code:'43', title:'درآمدهای مالی', level:'general', nature:'credit', parentId:'grp-revenue' },
    { id:'sub-finance-income', code:'4301', title:'سود و درآمدهای مالی', level:'subsidiary', nature:'credit', parentId:'acc-finance-income' },
    { id:'det-finance-income', code:'430101', title:'درآمد سود سپرده و تسهیلات', level:'detail', nature:'credit', parentId:'sub-finance-income' },
    { id:'acc-finance-expenses', code:'62', title:'هزینه‌های مالی', level:'general', nature:'debit', parentId:'grp-expenses' },
    { id:'sub-finance-expenses', code:'6201', title:'سود و کارمزد تسهیلات', level:'subsidiary', nature:'debit', parentId:'acc-finance-expenses' },
    { id:'det-finance-interest', code:'620101', title:'هزینه سود تسهیلات بانکی', level:'detail', nature:'debit', parentId:'sub-finance-expenses' },
    { id:'det-finance-fees', code:'620102', title:'کارمزد و هزینه خدمات مالی', level:'detail', nature:'debit', parentId:'sub-finance-expenses' },
    { id:'acc-income-tax', code:'63', title:'مالیات بر درآمد', level:'general', nature:'debit', parentId:'grp-expenses' },
    { id:'sub-income-tax', code:'6301', title:'مالیات عملکرد', level:'subsidiary', nature:'debit', parentId:'acc-income-tax' },
    { id:'det-income-tax', code:'630101', title:'هزینه مالیات بر درآمد', level:'detail', nature:'debit', parentId:'sub-income-tax' },
    { id:'sub-inventory-impairment', code:'6104', title:'کاهش ارزش موجودی', level:'subsidiary', nature:'debit', parentId:'acc-operating-expenses' },
    { id:'det-inventory-impairment', code:'610401', title:'زیان کاهش ارزش موجودی کالا', level:'detail', nature:'debit', parentId:'sub-inventory-impairment' },
    { id:'sub-cost-variances', code:'5103', title:'انحرافات بهای تمام‌شده', level:'subsidiary', nature:'debit', parentId:'acc-cogs' },
    { id:'det-purchase-price-variance', code:'510301', title:'انحراف قیمت خرید (بهای استاندارد)', level:'detail', nature:'debit', parentId:'sub-cost-variances' },
  ];
  const timestamp = now();
  let changed = false;
  for (const a of additions) {
    const existing = data.accounts.find(x => x.id === a.id);
    if (existing) {
      // اگر وجود دارد ولی غیرفعال یا سطح اشتباه است، برای سیستم‌های ضروری فعال کن
      if (!existing.isActive || existing.level !== a.level) {
        existing.isActive = true;
        existing.level = a.level as typeof existing.level;
        existing.updatedAt = timestamp;
        changed = true;
      }
      continue;
    }
    // اگر همان کد قبلاً با id دیگر ثبت شده، از همان استفاده کن (alias نرم)
    const byCode = data.accounts.find(x => x.code === a.code);
    if (byCode) {
      if (!byCode.isActive) { byCode.isActive = true; byCode.updatedAt = timestamp; changed = true; }
      continue;
    }
    // والد باید موجود باشد (یا null برای group)
    if (a.parentId && !data.accounts.some(x => x.id === a.parentId)) {
      // والد را در همین حلقه بعداً اضافه می‌کنیم — ترتیب از بالاست؛ اگر نبود، یک‌بار دیگر تلاش بعد از افزودن والدین
      continue;
    }
    data.accounts.push({
      id: a.id,
      code: a.code,
      title: a.title,
      level: a.level,
      nature: a.nature,
      parentId: a.parentId,
      isActive: true,
      isSystem: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    changed = true;
  }
  // پاس دوم برای مواردی که والد در پاس اول تازه اضافه شده
  for (const a of additions) {
    if (data.accounts.some(x => x.id === a.id)) continue;
    if (data.accounts.some(x => x.code === a.code)) continue;
    if (a.parentId && !data.accounts.some(x => x.id === a.parentId)) continue;
    data.accounts.push({
      id: a.id, code: a.code, title: a.title, level: a.level, nature: a.nature, parentId: a.parentId,
      isActive: true, isSystem: true, createdAt: timestamp, updatedAt: timestamp,
    });
    changed = true;
  }
  if (changed) await saveAccountingData(data);
  return data;
}

/**
 * ثبت کاهش ارزش موجودی (IAS 2 / NRV):
 * بدهکار: زیان کاهش ارزش موجودی · بستانکار: موجودی کالا
 * همزمان ارزش دفتر بهای تمام‌شده (و لایه‌های FIFO) کاهش می‌یابد؛ تعداد موجودی ثابت می‌ماند.
 */
export async function postInventoryNrvWriteDown(input: {
  productId: string;
  warehouse: string;
  writeDownRial: number;
  date: string;
  fiscalPeriodId: string;
  note?: string;
}): Promise<{ journalEntryId: string }> {
  if (!Number.isSafeInteger(input.writeDownRial) || input.writeDownRial <= 0) {
    throw new Error('مبلغ کاهش ارزش باید عدد صحیح ریال و بیشتر از صفر باشد.');
  }
  const product = products.find(p => p.id === input.productId);
  if (!product) throw new Error('کالا پیدا نشد.');
  const warehouse = warehouseName(input.warehouse || product.warehouse);
  let accounting = await ensureCommerceAccounts();
  requireAccount(accounting, 'det-inventory', 'موجودی کالا');
  requireAccount(accounting, 'det-inventory-impairment', 'زیان کاهش ارزش موجودی کالا');
  validateDateAndPeriod(input.date, input.fiscalPeriodId, accounting);

  const costing = await loadInventoryCostData();
  const before = getCostBalance(costing, product.id, warehouse);
  if (before.qtyMilli <= 0) throw new Error(`کالای «${product.name}» در انبار «${warehouse}» موجودی ندارد.`);
  if (input.writeDownRial > before.valueRial) {
    throw new Error(`مبلغ کاهش ارزش از ارزش دفتری (${before.valueRial} ریال) بیشتر است.`);
  }
  applyNrvWriteDown(costing, { productId: product.id, warehouse, writeDownRial: input.writeDownRial });
  await saveInventoryCostData(costing);

  const sourceId = `nrv-wd:${product.id}:${warehouse}:${input.date}:${input.writeDownRial}:${Date.now()}`;
  const desc = (input.note || '').trim() || `کاهش ارزش موجودی «${product.name}» تا سطح NRV — انبار ${warehouse}`;
  const lines = [
    journalLine('det-inventory-impairment', desc, input.writeDownRial, 0),
    journalLine('det-inventory', desc, 0, input.writeDownRial),
  ];
  const journalEntryId = await persistPostedJournal(
    accounting,
    journalBase(sourceId, 'NRV', input.fiscalPeriodId, input.date, desc, 'inventory', lines),
  );
  logAudit('inventory_nrv_write_down', {
    productId: product.id,
    warehouse,
    writeDownRial: input.writeDownRial,
    journalEntryId,
    beforeValueRial: before.valueRial,
  });
  saveAppState(true);
  await flushSave();
  return { journalEntryId };
}

export function upsertParty(data: CommerceData, input: Omit<AccountingParty,'id'|'createdAt'|'updatedAt'> & {id?:string}): CommerceData {
  const name = input.name.trim();
  if (!name) throw new Error('نام مشتری یا تأمین‌کننده الزامی است.');
  const nationalId = input.nationalId.trim();
  if (nationalId && !/^[0-9]{10,14}$/.test(nationalId)) throw new Error('شناسه ملی/کد اقتصادی باید ۱۰ تا ۱۴ رقم باشد.');
  if (nationalId && data.parties.some(p => p.id !== input.id && p.nationalId === nationalId)) throw new Error('این شناسه قبلاً برای شخص دیگری ثبت شده است.');
  const existing = input.id ? data.parties.find(p => p.id === input.id) : undefined;
  if (input.id && !existing) throw new Error('شخص موردنظر پیدا نشد.');
  const timestamp = now();
  const party: AccountingParty = { ...input, id:existing?.id || makeId('party'), name, nationalId, phone:input.phone.trim(), address:input.address.trim(), economicCode:(input.economicCode||'').trim(), registrationNumber:(input.registrationNumber||'').trim(), postalCode:(input.postalCode||'').trim(), createdAt:existing?.createdAt || timestamp, updatedAt:timestamp };
  return { ...data, parties: existing ? data.parties.map(p=>p.id===party.id?party:p) : [...data.parties,party] };
}

function validateDateAndPeriod(date: string, periodId: string, accounting: AccountingData): void {
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) throw new Error('تاریخ باید به شکل سال/ماه/روز شمسی باشد.');
  const period = accounting.fiscalPeriods.find(p=>p.id===periodId);
  if (!period || period.status !== 'open') throw new Error('سال مالی معتبر و باز انتخاب کنید.');
  if (date < period.startDate || date > period.endDate) throw new Error('تاریخ سند خارج از محدوده سال مالی است.');
}
function requireAccount(accounting: AccountingData, id: string, title: string): void {
  let a = accounting.accounts.find(x=>x.id===id && x.isActive && x.level==='detail');
  if (!a) {
    // فعال‌سازی حساب سیستم در صورت وجود ولی غیرفعال
    const any = accounting.accounts.find(x=>x.id===id);
    if (any && any.level==='detail') {
      any.isActive = true;
      a = any;
    }
  }
  if (!a) throw new Error(`حساب تفصیلی فعال «${title}» در کدینگ پیدا نشد. یک‌بار از بخش حسابداری کدینگ پیش‌فرض را بررسی کنید یا برنامه را تازه کنید.`);
}
function journalLine(accountId: string, description: string, debitRial: number, creditRial: number, partyId?: string): JournalLine {
  return { id:makeId('line'), accountId, description, debitRial, creditRial, ...(partyId?{partyId}:{}) };
}
function journalBase(id: string, number: string, periodId: string, date: string, description: string, source: JournalEntry['source'], lines: JournalLine[]): JournalEntry {
  return { id:makeId('je'), number:`${number}-${Date.now().toString().slice(-5)}-${Math.random().toString(36).slice(2,5)}`,  fiscalPeriodId:periodId, date, description, status:'draft', source, sourceDocumentId:id, lines, createdAt:now(), updatedAt:now() };
}
async function persistPostedJournal(accounting: AccountingData, entry: JournalEntry): Promise<string> {
  const already = accounting.journalEntries.find(j=>j.sourceDocumentId===entry.sourceDocumentId && j.status==='posted');
  if (already) return already.id;
  const withDraft = upsertJournalEntry(accounting, entry);
  const posted = postJournalEntry(withDraft, entry.id);
  await saveAccountingData(posted);
  return entry.id;
}

/**
 * ثبت سریع هزینه یا درآمد متفرقه در بازرگانی.
 * هزینه: بدهکار حساب هزینه / بستانکار صندوق یا بانک
 * درآمد: بدهکار صندوق یا بانک / بستانکار حساب درآمد
 */
export async function recordOperatingEntry(input: {
  kind: 'expense' | 'income';
  date: string;
  fiscalPeriodId: string;
  amountRial: number;
  operatingAccountId: string;
  cashAccountId: string;
  description: string;
  partyId?: string;
}): Promise<{ journalEntryId: string }> {
  if (!['expense', 'income'].includes(input.kind)) throw new Error('نوع ثبت باید هزینه یا درآمد باشد.');
  if (!Number.isSafeInteger(input.amountRial) || input.amountRial <= 0) throw new Error('مبلغ باید عددی مثبت و معتبر باشد.');
  const description = (input.description || '').trim();
  if (!description) throw new Error('شرح سند الزامی است.');
  const accounting = await loadAccountingData();
  validateDateAndPeriod(input.date, input.fiscalPeriodId, accounting);
  const opAcc = accounting.accounts.find(a => a.id === input.operatingAccountId && a.isActive && a.level === 'detail');
  if (!opAcc) throw new Error('حساب هزینه/درآمد معتبر انتخاب کنید.');
  const cashAcc = accounting.accounts.find(a => a.id === input.cashAccountId && a.isActive && a.level === 'detail');
  if (!cashAcc) throw new Error('حساب صندوق یا بانک معتبر انتخاب کنید.');
  if (input.kind === 'expense' && !opAcc.code.startsWith('6')) throw new Error('برای هزینه، حساب از گروه هزینه‌ها (کد ۶) انتخاب کنید.');
  if (input.kind === 'income' && !opAcc.code.startsWith('4')) throw new Error('برای درآمد، حساب از گروه درآمدها (کد ۴) انتخاب کنید.');
  const partyId = input.partyId?.trim() || undefined;
  if (partyId) {
    const commerceData = await loadCommerceData();
    const party = commerceData.parties.find(p => p.id === partyId && p.isActive);
    if (!party) throw new Error('طرف حساب انتخاب‌شده فعال نیست.');
  }
  const sourceKey = `operating:${input.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const prefix = input.kind === 'expense' ? 'EX' : 'IN';
  const lines = input.kind === 'expense'
    ? [
        journalLine(opAcc.id, description, input.amountRial, 0, partyId),
        journalLine(cashAcc.id, description, 0, input.amountRial),
      ]
    : [
        journalLine(cashAcc.id, description, input.amountRial, 0),
        journalLine(opAcc.id, description, 0, input.amountRial, partyId),
      ];
  const entry = journalBase(sourceKey, prefix, input.fiscalPeriodId, input.date, description, 'manual', lines);
  const journalEntryId = await persistPostedJournal(accounting, entry);
  return { journalEntryId };
}

/** فهرست اسناد هزینه/درآمد ثبت‌شده از بازرگانی */
export function listOperatingEntries(accounting: AccountingData, kind?: 'expense' | 'income', limit = 50) {
  return accounting.journalEntries
    .filter(e => e.status === 'posted' && typeof e.sourceDocumentId === 'string' && e.sourceDocumentId.startsWith('operating:'))
    .filter(e => !kind || e.sourceDocumentId!.startsWith(`operating:${kind}:`))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number, 'en'))
    .slice(0, limit)
    .map(e => {
      const amount = e.lines.reduce((s, l) => s + l.debitRial, 0);
      const isExpense = e.sourceDocumentId!.includes(':expense:');
      const opLine = isExpense
        ? e.lines.find(l => l.debitRial > 0)
        : e.lines.find(l => l.creditRial > 0);
      const account = accounting.accounts.find(a => a.id === opLine?.accountId);
      return {
        id: e.id,
        number: e.number,
        date: e.date,
        description: e.description,
        amountRial: amount,
        kind: (isExpense ? 'expense' : 'income') as 'expense' | 'income',
        accountTitle: account?.title || opLine?.accountTitleSnapshot || '—',
        accountCode: account?.code || opLine?.accountCodeSnapshot || '',
      };
    });
}

export function buildInvoice(input: {
  type: InvoiceType; number: string; date: string; fiscalPeriodId: string; partyId: string;
  description: string; lines: Array<{description:string; quantityMilli:number; unitPriceRial:number; productId?:string; warehouse?:string; unit?:string; discountRial?:number}>; taxRial:number; taxRateBps?:number; dueDate?:string; paymentTerms?:string; paymentParts?:InvoicePaymentPart[]; notes?:string;
  landedCosts?: InvoiceLandedCosts;
}, parties: AccountingParty[]): CommercialInvoice {
  const party = parties.find(p=>p.id===input.partyId && p.isActive);
  if (!party || !(party.type==='both' || (isSaleInvoiceType(input.type)?party.type==='customer':party.type==='supplier'))) throw new Error('طرف حساب فعال و متناسب با نوع فاکتور انتخاب کنید.');
  const number = input.number.trim(); if (!number) throw new Error('شماره فاکتور الزامی است.');
  if (!input.lines.length) throw new Error('فاکتور باید حداقل یک ردیف کالا یا خدمت داشته باشد.');
  const lines: CommercialInvoiceLine[] = input.lines.map(l=>{
    const description=l.description.trim();
    if (!description) throw new Error('شرح ردیف فاکتور الزامی است.');
    if (!Number.isSafeInteger(l.quantityMilli) || l.quantityMilli<=0) throw new Error('تعداد باید بیشتر از صفر و حداکثر سه رقم اعشار داشته باشد.');
    if (!isSafeMoney(l.unitPriceRial) || l.unitPriceRial<=0) throw new Error('قیمت واحد باید عدد صحیح ریال و بیشتر از صفر باشد.');
    const product = l.quantityMilli * l.unitPriceRial;
    if (!Number.isSafeInteger(product)) throw new Error('حاصل تعداد در قیمت از محدوده مجاز محاسبات خارج است.');
    const grossLineRial = Math.floor((product + 500) / 1000);
    const discountRial = l.discountRial || 0;
    if (!isSafeMoney(discountRial) || discountRial >= grossLineRial) throw new Error('تخفیف ردیف باید کمتر از مبلغ ردیف باشد.');
    const totalRial = grossLineRial - discountRial;
    if (!isSafeMoney(totalRial) || totalRial<=0) throw new Error('مبلغ ردیف معتبر نیست.');
    return {id:makeId('item'),description,quantityMilli:l.quantityMilli,unitPriceRial:l.unitPriceRial,totalRial,unit:(l.unit||'عدد').trim()||'عدد',discountRial,...(l.productId?{productId:l.productId,warehouse:l.warehouse||'انبار اصلی'}:{})};
  });
  const netRial=lines.reduce((s,l)=>s+l.totalRial,0);
  if (!Number.isSafeInteger(netRial) || !isSafeMoney(input.taxRial)) throw new Error('مبلغ کل یا مالیات از محدوده مجاز خارج است.');
  const grossRial=netRial+input.taxRial;
  if (!Number.isSafeInteger(grossRial) || grossRial<=0) throw new Error('جمع نهایی فاکتور معتبر نیست.');
  if (input.taxRateBps !== undefined && (!Number.isSafeInteger(input.taxRateBps) || input.taxRateBps < 0 || input.taxRateBps > 10000)) throw new Error('نرخ مالیات باید بین صفر تا صد درصد باشد.');
  if (input.dueDate && !/^\d{4}\/\d{2}\/\d{2}$/.test(input.dueDate)) throw new Error('تاریخ سررسید باید به شکل سال/ماه/روز شمسی باشد.');
  if (input.dueDate && input.dueDate < input.date) throw new Error('تاریخ سررسید نمی‌تواند قبل از تاریخ فاکتور باشد.');
  const paymentParts=(input.paymentParts||[]).map(part=>{if(!['cash','card','cheque','credit'].includes(part.method)||!isSafeMoney(part.amountRial)||part.amountRial<=0)throw new Error('روش یا مبلغ یکی از بخش‌های پرداخت معتبر نیست.');if(part.method==='cheque'){if(!part.chequeNumber?.trim()||!part.chequeBank?.trim()||!part.chequeAccount?.trim()||!part.chequeDueDate||!/^\d{4}\/\d{2}\/\d{2}$/.test(part.chequeDueDate))throw new Error('برای هر چک، مبلغ، شماره چک، بانک، شماره صیادی و تاریخ سررسید معتبر الزامی است.');if(part.chequeDueDate<input.date)throw new Error('سررسید چک نمی‌تواند قبل از تاریخ فاکتور باشد.');}return {...part};});
  const allocatedPayments=paymentParts.reduce((sum,x)=>sum+x.amountRial,0);
  if(allocatedPayments>grossRial)throw new Error('جمع پرداخت‌ها نباید از مبلغ نهایی فاکتور بیشتر شود.');
  // پیش‌نویس بدون تسویه مجاز است؛ سررسید اعتباری در برگه تسویه/قطعی‌سازی الزامی می‌شود
  if(input.type!=='proforma'&&allocatedPayments<grossRial)paymentParts.push({method:'credit',amountRial:grossRial-allocatedPayments,note:'مانده بدهی/مطالبه فاکتور'});
  // هزینه‌های جانبی خرید فقط روی فاکتور خرید معنا دارد و باید عدد صحیح غیرمنفی ریال باشد
  let landedCosts: InvoiceLandedCosts | undefined;
  if (input.landedCosts && input.type === 'purchase') {
    const norm = (n?: number) => Math.max(0, Math.round(Number(n) || 0));
    landedCosts = {
      freightRial: norm(input.landedCosts.freightRial),
      customsRial: norm(input.landedCosts.customsRial),
      insuranceRial: norm(input.landedCosts.insuranceRial),
      otherRial: norm(input.landedCosts.otherRial),
      note: (input.landedCosts.note || '').trim() || undefined,
    };
    const totalLc = totalLandedCostRial(landedCosts);
    if (totalLc > 0 && !lines.some(l => l.productId)) {
      throw new Error('هزینه جانبی خرید فقط وقتی قابل ثبت است که حداقل یک ردیف کالای انباری در فاکتور باشد.');
    }
    for (const key of ['freightRial', 'customsRial', 'insuranceRial', 'otherRial'] as const) {
      const v = landedCosts[key] || 0;
      if (!isSafeMoney(v)) throw new Error('مبالغ هزینه‌های جانبی خرید باید عدد صحیح ریال و معتبر باشند.');
    }
    if (!totalLc) landedCosts = undefined;
  }
  return {id:makeId('invoice'),type:input.type,number,date:input.date,fiscalPeriodId:input.fiscalPeriodId,partyId:party.id,description:input.description.trim(),lines,netRial,taxRial:input.taxRial,grossRial,taxRateBps:input.taxRateBps??0,dueDate:input.dueDate||'',paymentTerms:(input.paymentTerms||'').trim(),paymentParts,notes:(input.notes||'').trim(),...(landedCosts?{landedCosts}:{}),status:'draft',createdAt:now(),updatedAt:now()};
}

/** ویرایش کنترل‌شده پیش‌نویس؛ فاکتور قطعی قابل بازنویسی نیست. */
export function updateDraftInvoice(invoiceId: string, input: Parameters<typeof buildInvoice>[0], commerce: CommerceData): CommerceData {
  const existing = commerce.invoices.find(i => i.id === invoiceId);
  if (!existing) throw new Error('فاکتور برای ویرایش پیدا نشد.');
  if (existing.status !== 'draft') throw new Error('فاکتور قطعی قابل ویرایش مستقیم نیست؛ برای حفظ سوابق باید اصلاحیه مستقل ثبت شود.');
  if (commerce.invoices.some(i => i.id !== invoiceId && i.type === input.type && i.number === input.number.trim())) throw new Error('شماره فاکتور در این نوع فاکتور تکراری است.');
  const validated = buildInvoice(input, commerce.parties);
  const updated: CommercialInvoice = { ...validated, id: existing.id, status: 'draft', createdAt: existing.createdAt, updatedAt: now() };
  logAudit('accounting_invoice_draft_edited', { invoiceId, number: updated.number, type: updated.type, oldGrossRial: existing.grossRial, newGrossRial: updated.grossRial });
  return { ...commerce, invoices: commerce.invoices.map(i => i.id === invoiceId ? updated : i) };
}

/**
 * به‌روزرسانی قیمت خرید/فروش روی کارت کالا پس از قطعی‌سازی خرید.
 * - بهای تمام‌شده انبار (costing) تغییر نمی‌کند؛ فقط فیلدهای کاتالوگ کالا.
 * - واحد مبالغ: ریال (هم‌راستا با unitPriceRial فاکتور و فیلدهای کالا).
 */
function applyCatalogPricesAfterPurchase(
  invoice: CommercialInvoice,
  costing: Awaited<ReturnType<typeof loadInventoryCostData>>,
  accounting: AccountingData
): void {
  const settings = accounting.settings;
  const purchaseMode = settings.purchasePriceUpdateMode || 'last';
  const saleMode = settings.salePriceUpdateMode || 'none';
  if (purchaseMode === 'none' && saleMode === 'none') return;

  const markupPct = Math.max(0, Number(settings.salePriceMarkupPercent) || 0);
  for (const line of invoice.lines) {
    if (!line.productId) continue;
    const p = products.find((x) => x.id === line.productId);
    if (!p) continue;
    const qty = line.quantityMilli / 1000;
    if (!(qty > 0)) continue;
    // بهای واحد خالص ردیف (پس از تخفیف ردیف)
    const netUnitRial = line.totalRial / qty;
    if (!(netUnitRial >= 0) || !Number.isFinite(netUnitRial)) continue;

    const prevPurchase = Number(p.purchasePrice) || 0;
    const prevSale = Number(p.price) || 0;
    let nextPurchase = prevPurchase;

    if (purchaseMode === 'last') {
      nextPurchase = netUnitRial;
    } else if (purchaseMode === 'average') {
      const wh = warehouseName(line.warehouse || p.warehouse);
      const bal = getCostBalance(costing, p.id, wh);
      nextPurchase = bal.averageUnitCostRial > 0 ? bal.averageUnitCostRial : netUnitRial;
    }

    if (purchaseMode !== 'none') {
      p.purchasePrice = Math.round(nextPurchase * 1000) / 1000;
    }

    if (saleMode === 'markup' && (purchaseMode !== 'none' ? nextPurchase : prevPurchase) > 0) {
      const base = purchaseMode !== 'none' ? nextPurchase : prevPurchase;
      p.price = Math.round(base * (1 + markupPct / 100) * 1000) / 1000;
    } else if (saleMode === 'keep-ratio' && purchaseMode !== 'none' && prevPurchase > 0 && nextPurchase > 0) {
      const ratio = prevSale > 0 ? prevSale / prevPurchase : 1;
      p.price = Math.round(nextPurchase * ratio * 1000) / 1000;
    }
  }
}

/**
 * تخصیص هزینه‌های جانبی خرید به ردیف‌های کالایی به‌نسبت مبلغ ردیف (IAS 2).
 * باقی‌مانده گرد کردن به آخرین ردیف دارای کالا داده می‌شود.
 */
export function allocateLandedCostsToLines(lines: CommercialInvoiceLine[], totalLandedRial: number): Map<string, number> {
  const map = new Map<string, number>();
  const stock = lines.filter(l => l.productId);
  if (!stock.length || totalLandedRial <= 0) return map;
  const base = stock.reduce((s, l) => s + Math.max(0, l.totalRial), 0);
  if (base <= 0) {
    // تخصیص مساوی در صورت نبود مبلغ پایه
    const each = Math.floor(totalLandedRial / stock.length);
    let assigned = 0;
    stock.forEach((l, i) => {
      const share = i === stock.length - 1 ? totalLandedRial - assigned : each;
      map.set(l.id, share);
      assigned += share;
    });
    return map;
  }
  let assigned = 0;
  stock.forEach((l, i) => {
    const share = i === stock.length - 1
      ? totalLandedRial - assigned
      : Math.round(totalLandedRial * (l.totalRial / base));
    map.set(l.id, Math.max(0, share));
    assigned += Math.max(0, share);
  });
  return map;
}

export async function postInvoice(invoiceId: string, commerce: CommerceData): Promise<{commerce:CommerceData; accounting:AccountingData}> {
  return withCommerceMutationLock(() => postInvoiceExclusive(invoiceId, commerce));
}

async function postInvoiceExclusive(invoiceId: string, commerce: CommerceData): Promise<{commerce:CommerceData; accounting:AccountingData}> {
  const persisted = await loadCommerceData();
  const activeCommerce = persisted.invoices.some(i => i.id === invoiceId) ? persisted : commerce;
  const invoice=activeCommerce.invoices.find(i=>i.id===invoiceId); if(!invoice) throw new Error('فاکتور پیدا نشد.');
  if(activeCommerce.invoices.some(i=>i.id!==invoice.id&&i.type===invoice.type&&i.number.trim()===invoice.number.trim())) throw new Error('شماره این فاکتور با سند دیگری تکراری است؛ قبل از قطعی‌سازی شماره را اصلاح کنید.');
  if(invoice.status==='posted') return {commerce:activeCommerce,accounting:await loadAccountingData()};
  if(invoice.type==='proforma') throw new Error('پیش‌فاکتور فقط قابل ذخیره و چاپ است و سند حسابداری یا گردش انبار ایجاد نمی‌کند.');
  const creditParts=(invoice.paymentParts||[]).filter(p=>p.method==='credit');
  if(creditParts.some(p=>p.amountRial>0) && !invoice.dueDate) throw new Error('برای مانده اعتباری، تاریخ سررسید را در تسویه مشخص کنید.');
  let accounting=await ensureCommerceAccounts();
  validateDateAndPeriod(invoice.date,invoice.fiscalPeriodId,accounting);
  const party=activeCommerce.parties.find(p=>p.id===invoice.partyId && p.isActive); if(!party) throw new Error('طرف حساب فاکتور غیرفعال یا حذف شده است.');
  await assertDefaultPartyAllowed(invoice.type, invoice.partyId);
  const ar='det-customers', ap='det-suppliers', sales='det-sales-goods', inventory='det-inventory', cogs='det-cogs-goods', purchases='det-purchases', inputTax='det-input-tax', outputTax='det-output-tax';
  const stockLines=invoice.lines.filter(l=>l.productId);
  const saleSide=isSaleInvoiceType(invoice.type); const returnSide=isReturnInvoiceType(invoice.type);
  const stockPurchaseDiscount=isPurchaseInvoiceType(invoice.type)&&invoice.lines.some(l=>l.productId&&(l.discountRial||0)>0);
  const landedTotal = invoice.type === 'purchase' ? totalLandedCostRial(invoice.landedCosts) : 0;
  const landedAlloc = invoice.type === 'purchase' ? allocateLandedCostsToLines(invoice.lines, landedTotal) : new Map<string, number>();
  const titles:Record<string,string>={
    [ar]:'اشخاص دریافتنی',[ap]:'اشخاص پرداختنی',[sales]:'فروش کالا',[inventory]:'موجودی کالا',
    [cogs]:'بهای تمام‌شده',[purchases]:'خرید کالا',[inputTax]:'مالیات خرید',[outputTax]:'مالیات فروش',
    'det-purchase-discounts':'تخفیفات خرید','det-landed-payable':'هزینه‌های جانبی خرید پرداختنی',
    'det-purchase-price-variance':'انحراف قیمت خرید',
  };
  const mayUseStandardCost=!saleSide && stockLines.some(l=>{
    const p=products.find(x=>x.id===l.productId);
    return !!p && Math.round(Number(p.standardCostRial)||0)>0;
  });
  const needed=saleSide?[ar,sales,inventory,cogs,...(invoice.taxRial?[outputTax]:[])]:[inventory,purchases,cogs,ap,...(invoice.taxRial?[inputTax]:[]),...(stockPurchaseDiscount?['det-purchase-discounts']:[]),...(landedTotal>0?['det-landed-payable']:[]),...(mayUseStandardCost?['det-purchase-price-variance']:[])];
  // اگر هنوز نبود، یک‌بار دیگر ensure و بعد خطا با عنوان فارسی
  for(const id of needed){
    if(!accounting.accounts.some(x=>x.id===id&&x.isActive&&x.level==='detail')){
      accounting=await ensureCommerceAccounts();
      break;
    }
  }
  for(const id of needed) requireAccount(accounting,id,titles[id]||id);
  const costing=await loadInventoryCostData(); let inventoryValue=0; let cogsValue=0; let purchaseCogsAdjustment=0; let purchasePriceVariance=0; let provisional=false;
  const touched=new Set<string>();
  const alreadyApplied=new Set(costing.movements.filter(m=>m.sourceDocumentId===invoice.id).map(m=>m.productId));
  for(const line of stockLines){
    const product=products.find(p=>p.id===line.productId); if(!product) throw new Error(`کالای ردیف «${line.description}» دیگر در انبار وجود ندارد.`);
    const warehouse=line.warehouse||product.warehouse||'انبار اصلی';
    ensureProductStock(product); // انبار فاکتور می‌تواند هر انباری باشد که موجودی در آن مدیریت می‌شود
    if(touched.has(product.id)) throw new Error(`کالای «${product.name}» در چند ردیف تکرار شده است؛ ردیف‌ها را یکی کنید.`); touched.add(product.id);
    if(alreadyApplied.has(product.id)) continue;
    seedOpeningStock(costing,product.id,warehouse,Math.round(getWarehouseQty(product,warehouse)*1000));
    if((invoice.type==='purchase' || invoice.type==='return-sale')){
      // بهای ورود: قیمت واحد فاکتور + سهم هزینه جانبی هر واحد (Landed Cost همیشه در موجودی می‌ماند)
      let landedPerUnit=0;
      if(invoice.type==='purchase'){
        const share=landedAlloc.get(line.id)||0;
        line.allocatedLandedRial = share;
        if(share>0 && line.quantityMilli>0){
          landedPerUnit = Math.round(share * 1000 / line.quantityMilli);
        }
      }
      const invoiceUnit=line.unitPriceRial;
      const actualUnit=invoice.type==='purchase'
        ? invoiceUnit + landedPerUnit
        : getCostBalance(costing,product.id,warehouse).averageUnitCostRial;
      if(invoice.type==='return-sale'&&actualUnit<=0)throw new Error(`برای برگشت کالای «${product.name}» بهای موجودی معتبر پیدا نشد.`);
      // بهای استاندارد: موجودی = استاندارد + سهم Landed ؛ انحراف فقط (قیمت فاکتور − استاندارد) است
      const std=Math.round(Number(product.standardCostRial)||0);
      const useStandard=invoice.type==='purchase' && std>0;
      const unitCost=useStandard ? (std + landedPerUnit) : actualUnit;
      const result=receiveStock(costing,{
        productId:product.id,warehouse,qtyMilli:line.quantityMilli,unitCostRial:unitCost,date:invoice.date,sourceDocumentId:invoice.id,
        actualUnitCostRial:useStandard?actualUnit:undefined,
      });
      inventoryValue+=result.inventoryValueRial;
      if(invoice.type==='return-sale')cogsValue+=result.inventoryValueRial;
      purchaseCogsAdjustment+=result.negativeOffsetCostRial;
      if(useStandard) purchasePriceVariance+=result.priceVarianceRial;
    }else{
      const allowNegative=!!accounting.settings.allowNegativeStock
        || !!accounting.settings.allowNegativeStockByWarehouse[warehouse];
      const result=issueStock(costing,{productId:product.id,warehouse,qtyMilli:line.quantityMilli,date:invoice.date,sourceDocumentId:invoice.id,method:accounting.settings.defaultCostingMethod,allowNegative,productName:product.name});
      cogsValue+=result.totalCostRial; if(invoice.type==='return-purchase')inventoryValue+=result.totalCostRial; provisional=provisional||result.provisional;
    }
  }
  const lines:JournalLine[]=[];
  if(saleSide){
    lines.push(journalLine(ar,'حساب دریافتنی مشتری',invoice.grossRial,0,party.id),journalLine(sales,'فروش کالا و خدمات',0,invoice.netRial));
    if(invoice.taxRial)lines.push(journalLine(outputTax,'مالیات ارزش افزوده فروش',0,invoice.taxRial));
    if(cogsValue)lines.push(journalLine(cogs,'بهای تمام‌شده کالای فروش‌رفته',cogsValue,0),journalLine(inventory,'کاهش موجودی کالا',0,cogsValue));
  }else{
    const nonStockPurchase=invoice.lines.filter(l=>!l.productId).reduce((sum,l)=>sum+l.totalRial,0);
    if(inventoryValue)lines.push(journalLine(inventory,'افزایش موجودی کالا',inventoryValue,0));
    // انحراف قیمت خرید: بهای واقعی − بهای استاندارد (نامساعد بدهکار / مساعد بستانکار)
    if(purchasePriceVariance>0){
      requireAccount(accounting,'det-purchase-price-variance','انحراف قیمت خرید');
      lines.push(journalLine('det-purchase-price-variance','انحراف نامساعد قیمت خرید نسبت به بهای استاندارد',purchasePriceVariance,0));
    }else if(purchasePriceVariance<0){
      requireAccount(accounting,'det-purchase-price-variance','انحراف قیمت خرید');
      lines.push(journalLine('det-purchase-price-variance','انحراف مساعد قیمت خرید نسبت به بهای استاندارد',0,-purchasePriceVariance));
    }
    if(purchaseCogsAdjustment)lines.push(journalLine(cogs,'تعدیل بهای تمام‌شده بابت تسویه کسری منفی',purchaseCogsAdjustment,0));
    if(nonStockPurchase)lines.push(journalLine(purchases,'خرید خدمات و اقلام غیرانبار',nonStockPurchase,0));
    const stockDiscount=stockLines.reduce((sum,l)=>sum+(l.discountRial||0),0);
    if(stockDiscount)lines.push(journalLine('det-purchase-discounts','تخفیفات خرید کالا',0,stockDiscount));
    if(invoice.taxRial)lines.push(journalLine(inputTax,'مالیات ارزش افزوده خرید',invoice.taxRial,0));
    lines.push(journalLine(ap,'حساب پرداختنی تأمین‌کننده',0,invoice.grossRial,party.id));
    // هزینه‌های جانبی خرید (حمل/گمرک/بیمه/سایر) به بهای موجودی اضافه و به‌عنوان بدهی جانبی ثبت می‌شود
    if(landedTotal>0){
      lines.push(journalLine('det-landed-payable','هزینه‌های جانبی خرید (حمل، گمرک، بیمه و سایر)',0,landedTotal));
    }
  }
  if(returnSide){ for(const line of lines){ const debit=line.debitRial; line.debitRial=line.creditRial; line.creditRial=debit; } }
  // کنترل هم‌زمانی موجودی باید پیش از قطعی‌سازی سند حسابداری انجام شود.
  for(const line of stockLines){const p=products.find(x=>x.id===line.productId)!;ensureProductStock(p);const movement=costing.movements.find(m=>m.sourceDocumentId===invoice.id&&m.productId===p.id);if(!movement)throw new Error(`گردش انبار کالای «${p.name}» ثبت نشده است.`);const wh=warehouseName(line.warehouse||p.warehouse);const before=movement.beforeQtyMilli/1000,after=movement.afterQtyMilli/1000;const current=getWarehouseQty(p,wh);if(Math.abs(current-before)>=0.000001&&Math.abs(current-after)>=0.000001)throw new Error(`موجودی کالای «${p.name}» در انبار «${wh}» هم‌زمان تغییر کرده است؛ فاکتور را بررسی کنید.`);}
  const existing=accounting.journalEntries.find(j=>j.sourceDocumentId===invoice.id && j.status==='posted');
  const journalId=existing?.id || await persistPostedJournal(accounting,journalBase(invoice.id,saleSide?'F':'B',invoice.fiscalPeriodId,invoice.date,invoice.description || `فاکتور ${invoice.number}`,saleSide?'sales':'purchase',lines));
  for(const line of stockLines){const p=products.find(x=>x.id===line.productId)!;ensureProductStock(p);const movement=costing.movements.find(m=>m.sourceDocumentId===invoice.id&&m.productId===p.id)!;const wh=warehouseName(line.warehouse||movement.warehouse||p.warehouse);const before=movement.beforeQtyMilli/1000,after=movement.afterQtyMilli/1000;if(Math.abs(getWarehouseQty(p,wh)-before)<0.000001)setWarehouseQty(p,wh,after);}
  // به‌روزرسانی قیمت خرید/فروش کارت کالا طبق تنظیمات حسابداری (فقط فاکتور خرید؛ بهای تمام‌شده انبار جداست)
  if(invoice.type==='purchase' && stockLines.length){
    applyCatalogPricesAfterPurchase(invoice, costing, accounting);
  }
  if(stockLines.length){await saveInventoryCostData(costing);saveAppState(true);await flushSave();logAudit('accounting_invoice_stock_posted',{invoiceId:invoice.id,number:invoice.number,type:invoice.type,items:stockLines.length,cogsRial:cogsValue,inventoryRial:inventoryValue,provisionalCost:provisional});}
  const updated={...invoice,status:'posted' as const,journalEntryId:journalId,updatedAt:now()};
  const next={...activeCommerce,invoices:activeCommerce.invoices.map(i=>i.id===invoice.id?updated:i)}; await saveCommerceData(next);
  return {commerce:next,accounting:await loadAccountingData()};
}

export async function createCashTransaction(input: {
  type:'receipt'|'payment'; number:string; date:string; fiscalPeriodId:string; partyId:string;
  cashAccountId:string; amountRial:number; description:string; method?:SettlementMethod;
  allocations?:InvoiceAllocation[]; chequeNumber?:string; chequeBank?:string; chequeAccount?:string; chequeNote?:string; chequeDueDate?:string;
}, commerce:CommerceData):Promise<{commerce:CommerceData;accounting:AccountingData}> {
  return withCommerceMutationLock(() => createCashTransactionExclusive(input, commerce));
}

async function createCashTransactionExclusive(input: {
  type:'receipt'|'payment'; number:string; date:string; fiscalPeriodId:string; partyId:string;
  cashAccountId:string; amountRial:number; description:string; method?:SettlementMethod;
  allocations?:InvoiceAllocation[]; chequeNumber?:string; chequeBank?:string; chequeAccount?:string; chequeNote?:string; chequeDueDate?:string;
}, originalCommerce:CommerceData):Promise<{commerce:CommerceData;accounting:AccountingData}> {
  const persisted = await loadCommerceData();
  const activeCommerce = persisted.cashTransactions.length || persisted.invoices.length || persisted.parties.length ? persisted : originalCommerce;
  const commerce = activeCommerce;
  let accounting=await ensureCommerceAccounts(); validateDateAndPeriod(input.date,input.fiscalPeriodId,accounting);
  if(!input.number.trim()) throw new Error('شماره رسید یا پرداخت الزامی است.');
  const normalizedNumber=input.number.trim();
  if(activeCommerce.cashTransactions.some(t=>t.type===input.type&&t.fiscalPeriodId===input.fiscalPeriodId&&t.number.trim()===normalizedNumber)) throw new Error('شماره رسید/پرداخت در این نوع سند و سال مالی قبلاً ثبت شده است.');
  if(!isSafeMoney(input.amountRial)||input.amountRial<=0) throw new Error('مبلغ باید عدد صحیح ریال و بیشتر از صفر باشد.');
  const party=activeCommerce.parties.find(p=>p.id===input.partyId&&p.isActive);
  const allocatedInvoiceTypes=(input.allocations||[]).map(a=>activeCommerce.invoices.find(i=>i.id===a.invoiceId)?.type).filter(Boolean) as InvoiceType[];
  const partyIsCustomer=allocatedInvoiceTypes.some(t=>t==='sale'||t==='return-sale') || (!allocatedInvoiceTypes.length&&input.type==='receipt');
  if(!party||!(party.type==='both'||(partyIsCustomer?party.type==='customer':party.type==='supplier'))) throw new Error('طرف حساب متناسب با دریافت یا پرداخت انتخاب کنید.');
  const method=input.method||'cash'; const isCheque=method==='cheque';
  if(!isCheque) requireAccount(accounting,input.cashAccountId,'صندوق/بانک');
  else {
    requireAccount(accounting,input.cashAccountId,'صندوق/بانک مقصد یا مبدأ برای تسویه چک');
    requireAccount(accounting,input.type==='receipt'?'det-cheques-receivable':'det-cheques-payable','اسناد چک');
    if(!input.chequeNumber?.trim()||!input.chequeBank?.trim()||!input.chequeAccount?.trim()||!input.chequeDueDate||!/^[0-9]{4}\/[0-9]{2}\/[0-9]{2}$/.test(input.chequeDueDate)) throw new Error('برای چک، شماره چک، بانک، شماره صیادی و تاریخ سررسید معتبر الزامی است.');
    if(input.chequeDueDate<input.date) throw new Error('سررسید چک نمی‌تواند قبل از تاریخ دریافت/پرداخت باشد.');
    const normalizedCheque=input.chequeNumber!.trim(); const normalizedBank=input.chequeBank!.trim().toLocaleLowerCase();
    if(activeCommerce.cashTransactions.some(t=>t.method==='cheque'&&t.chequeStatus!=='void'&&t.chequeNumber?.trim()===normalizedCheque&&(t.chequeBank||'').trim().toLocaleLowerCase()===normalizedBank)) throw new Error('این شماره چک با همین بانک قبلاً در سوابق چک ثبت شده است.');
  }
  const allocations=input.allocations||[]; const allocated=allocations.reduce((sum,a)=>sum+a.amountRial,0);
  if(allocations.some(a=>!isSafeMoney(a.amountRial)||a.amountRial<=0)||allocated>input.amountRial) throw new Error('مجموع تخصیص به فاکتورها معتبر نیست یا از مبلغ عملیات بیشتر است.');
  const seen=new Set<string>();
  for(const a of allocations){
    if(seen.has(a.invoiceId)) throw new Error('یک فاکتور را بیش از یک بار انتخاب نکنید.'); seen.add(a.invoiceId);
    const invoice=activeCommerce.invoices.find(i=>i.id===a.invoiceId&&i.status==='posted'&&i.partyId===party.id);
    const expectedType=invoice&&(invoice.type==='sale'||invoice.type==='return-purchase'?'receipt':invoice.type==='purchase'||invoice.type==='return-sale'?'payment':null);
    if(!invoice||expectedType!==input.type||invoice.type==='proforma') throw new Error('فاکتور انتخابی قطعی نیست یا با نوع دریافت/پرداخت و طرف حساب سازگار نیست.');
    const outstanding=invoiceOutstanding(invoice.id,commerce);
    if(a.amountRial>outstanding) throw new Error(`مبلغ تخصیص از مانده فاکتور ${invoice.number} بیشتر است.`);
  }
  const allocatedType=allocatedInvoiceTypes[0]; const returnSale=allocatedType==='return-sale'; const returnPurchase=allocatedType==='return-purchase';
  const partyAccount=(input.type==='receipt'&&!returnPurchase)||(input.type==='payment'&&returnSale)?'det-customers':'det-suppliers'; requireAccount(accounting,partyAccount,'حساب اشخاص');
  const instrumentAccount=isCheque?(input.type==='receipt'?'det-cheques-receivable':'det-cheques-payable'):input.cashAccountId;
  const lines:JournalLine[] = input.type==='receipt'
    ? [journalLine(instrumentAccount,isCheque?'چک دریافتنی':'دریافت وجه',input.amountRial,0),journalLine(partyAccount,'تسویه حساب طرف حساب',0,input.amountRial,party.id)]
    : [journalLine(partyAccount,'تسویه حساب طرف حساب',input.amountRial,0,party.id),journalLine(instrumentAccount,isCheque?'چک پرداختنی':'پرداخت وجه',0,input.amountRial)];
  const id=makeId(input.type); const entry=journalBase(id,input.type==='receipt'?'R':'P',input.fiscalPeriodId,input.date,input.description||(input.type==='receipt'?'دریافت از مشتری':'پرداخت به تأمین‌کننده'),input.type,lines);
  const journalEntryId=await persistPostedJournal(accounting,entry);
  const tx:CashTransaction={id,type:input.type,number:input.number.trim(),date:input.date,fiscalPeriodId:input.fiscalPeriodId,partyId:party.id,cashAccountId:input.cashAccountId,amountRial:input.amountRial,description:input.description.trim(),journalEntryId,createdAt:now(),method,allocations,...(isCheque?{chequeNumber:input.chequeNumber!.trim(),chequeBank:input.chequeBank!.trim(),chequeAccount:(input.chequeAccount||'').trim(),chequeNote:(input.chequeNote||'').trim(),chequeDueDate:input.chequeDueDate,chequeStatus:'pending' as const}:{})};
  const next={...activeCommerce,cashTransactions:[...activeCommerce.cashTransactions,tx]}; await saveCommerceData(next);
  return {commerce:next,accounting:await loadAccountingData()};
}

export function invoiceOutstanding(invoiceId:string,commerce:CommerceData):number {
  const invoice=commerce.invoices.find(i=>i.id===invoiceId&&i.status==='posted'); if(!invoice)return 0;
  const allocated=commerce.cashTransactions.filter(t=>!t.chequeStatus||t.chequeStatus==='pending'||t.chequeStatus==='cleared').flatMap(t=>t.allocations||[]).filter(a=>a.invoiceId===invoiceId).reduce((s,a)=>s+a.amountRial,0);
  const endorsed=invoice.type==='purchase'?(commerce.chequeEndorsements||[]).filter(e=>e.invoiceId===invoiceId&&commerce.cashTransactions.some(t=>t.id===e.transactionId&&(!t.chequeStatus||t.chequeStatus==='pending'||t.chequeStatus==='cleared'))).reduce((sum,e)=>sum+e.amountRial,0):0;
  return Math.max(0,invoice.grossRial-allocated-endorsed);
}

export async function updateChequeStatus(transactionId:string,status:Exclude<ChequeStatus,'pending'>,clearingDate:string,commerce:CommerceData):Promise<{commerce:CommerceData;accounting:AccountingData}> {
  const tx=commerce.cashTransactions.find(t=>t.id===transactionId);
  if(!tx||tx.method!=='cheque'||tx.chequeStatus!=='pending') throw new Error('چک در وضعیت انتظار یافت نشد.');
  const accounting=await loadAccountingData();
  if(!/^\d{4}\/\d{2}\/\d{2}$/.test(clearingDate)) throw new Error('تاریخ عملیات چک باید شمسی و معتبر باشد.');
  const clearingPeriod=accounting.fiscalPeriods.find(p=>p.status==='open'&&clearingDate>=p.startDate&&clearingDate<=p.endDate);
  if(!clearingPeriod) throw new Error('برای تاریخ عملیات چک، سال مالی باز و معتبر پیدا نشد.');
  if(status==='cleared'){
    if(tx.type==='receipt'&&(commerce.chequeEndorsements||[]).some(e=>e.transactionId===tx.id)) throw new Error('این چک ظهرنویسی و واگذار شده است؛ وصول آن در حساب بانکی شرکت مجاز نیست.');
    requireAccount(accounting,tx.cashAccountId,'صندوق/بانک');
    // کنترل موجودی بانک/صندوق برای پاس چک پرداختنی (قابل تنظیم در تنظیمات حسابداری)
    if(tx.type==='payment' && !accounting.settings.allowChequeClearWithNegativeCash){
      const bal=accounting.journalEntries
        .filter(j=>j.status==='posted')
        .flatMap(j=>j.lines)
        .filter(l=>l.accountId===tx.cashAccountId)
        .reduce((s,l)=>s+l.debitRial-l.creditRial,0);
      if(bal < tx.amountRial){
        throw new Error('موجودی حساب بانک/صندوق برای پاس این چک کافی نیست. در تنظیمات حسابداری می‌توانید «پاس چک با موجودی منفی» را فعال کنید.');
      }
    }
    const chequeAccount=tx.type==='receipt'?'det-cheques-receivable':'det-cheques-payable';
    const lines=tx.type==='receipt'
      ? [journalLine(tx.cashAccountId,'وصول چک دریافتی',tx.amountRial,0),journalLine(chequeAccount,'خروج از اسناد دریافتنی',0,tx.amountRial)]
      : [journalLine(chequeAccount,'تسویه چک پرداختنی',tx.amountRial,0),journalLine(tx.cashAccountId,'پرداخت از بانک بابت چک',0,tx.amountRial)];
    const entry=journalBase(`${tx.id}:clear`,tx.type==='receipt'?'RC':'PC',clearingPeriod.id,clearingDate,`تسویه چک ${tx.chequeNumber}`,tx.type,lines);
    const journalId=await persistPostedJournal(accounting,entry);
    const next={...commerce,cashTransactions:commerce.cashTransactions.map(t=>t.id===tx.id?{...t,chequeStatus:status,clearingJournalEntryId:journalId}:t)};
    await saveCommerceData(next); return {commerce:next,accounting:await loadAccountingData()};
  }
  if(status==='bounced'){
    const partyAccount=tx.type==='receipt'?'det-customers':'det-suppliers';
    const chequeAccount=tx.type==='receipt'?'det-cheques-receivable':'det-cheques-payable';
    const endorsements=(commerce.chequeEndorsements||[]).filter(e=>e.transactionId===tx.id);
    const endorsedTotal=endorsements.reduce((sum,e)=>sum+e.amountRial,0);
    const lines=tx.type==='receipt'
      ? [journalLine(partyAccount,'برگشت چک دریافتی از مشتری',tx.amountRial,0,tx.partyId),
         ...endorsements.map(e=>journalLine('det-suppliers','بازگشت بدهی تأمین‌کننده بابت بخش واگذارشده چک برگشتی',0,e.amountRial,e.toPartyId)),
         ...(tx.amountRial>endorsedTotal?[journalLine(chequeAccount,'حذف مانده واگذارنشده چک برگشتی از اسناد دریافتنی',0,tx.amountRial-endorsedTotal)]:[])]
      : [journalLine(chequeAccount,'ابطال چک پرداختی برگشتی',tx.amountRial,0),journalLine(partyAccount,'بازگشت بدهی تأمین‌کننده',0,tx.amountRial,tx.partyId)];
    const entry=journalBase(`${tx.id}:bounce`,tx.type==='receipt'?'RB':'PB',clearingPeriod.id,clearingDate,`برگشت چک ${tx.chequeNumber}`,tx.type,lines);
    const journalId=await persistPostedJournal(accounting,entry);
    const next={...commerce,cashTransactions:commerce.cashTransactions.map(t=>t.id===tx.id?{...t,chequeStatus:status,clearingJournalEntryId:journalId,allocations:[]}:t)};
    await saveCommerceData(next); return {commerce:next,accounting:await loadAccountingData()};
  }
  const original=accounting.journalEntries.find(j=>j.id===tx.journalEntryId&&j.status==='posted');
  if(!original) throw new Error('سند اولیه چک پیدا نشد؛ ابطال بدون سند معکوس مجاز نیست.');
  const endorsements=(commerce.chequeEndorsements||[]).filter(e=>e.transactionId===tx.id);
  const reverseLines=original.lines.map(l=>journalLine(l.accountId,`ابطال چک ${tx.chequeNumber||tx.number}`,l.creditRial,l.debitRial,l.partyId));
  for(const endorsement of endorsements){const endorsementJournal=accounting.journalEntries.find(j=>j.id===endorsement.journalEntryId&&j.status==='posted');if(!endorsementJournal)throw new Error('یکی از اسناد ظهرنویسی پیدا نشد؛ ابطال بدون اسناد معکوس کامل مجاز نیست.');reverseLines.push(...endorsementJournal.lines.map(l=>journalLine(l.accountId,`ابطال ظهرنویسی چک ${tx.chequeNumber||tx.number}`,l.creditRial,l.debitRial,l.partyId)));}
  const reversal=journalBase(`${tx.id}:void`,tx.type==='receipt'?'RV':'PV',clearingPeriod.id,clearingDate,`ابطال چک ${tx.chequeNumber||tx.number}`,'manual',reverseLines);
  const reversalId=await persistPostedJournal(accounting,reversal);
  const next={...commerce,cashTransactions:commerce.cashTransactions.map(t=>t.id===tx.id?{...t,chequeStatus:'void' as const,clearingJournalEntryId:reversalId,allocations:[]}:t)};
  await saveCommerceData(next); return {commerce:next,accounting:await loadAccountingData()};
}

export function partyBalance(partyId: string, commerce: CommerceData): number {
  const sales=commerce.invoices.filter(i=>i.status==='posted'&&i.type==='sale'&&i.partyId===partyId).reduce((s,i)=>s+i.grossRial,0);
  const purchases=commerce.invoices.filter(i=>i.status==='posted'&&i.type==='purchase'&&i.partyId===partyId).reduce((s,i)=>s+i.grossRial,0);
  const salesReturns=commerce.invoices.filter(i=>i.status==='posted'&&i.type==='return-sale'&&i.partyId===partyId).reduce((s,i)=>s+i.grossRial,0);
  const purchaseReturns=commerce.invoices.filter(i=>i.status==='posted'&&i.type==='return-purchase'&&i.partyId===partyId).reduce((s,i)=>s+i.grossRial,0);
  const receipts=commerce.cashTransactions.filter(t=>t.type==='receipt'&&t.partyId===partyId&&(!t.chequeStatus||t.chequeStatus==='pending'||t.chequeStatus==='cleared')).reduce((s,t)=>s+t.amountRial,0);
  const payments=commerce.cashTransactions.filter(t=>t.type==='payment'&&t.partyId===partyId&&(!t.chequeStatus||t.chequeStatus==='pending'||t.chequeStatus==='cleared')).reduce((s,t)=>s+t.amountRial,0);
  const endorsed=(commerce.chequeEndorsements||[]).filter(e=>e.toPartyId===partyId&&commerce.cashTransactions.some(t=>t.id===e.transactionId&&(!t.chequeStatus||t.chequeStatus==='pending'||t.chequeStatus==='cleared'))).reduce((sum,e)=>sum+e.amountRial,0);
  return sales-purchases-salesReturns+purchaseReturns-receipts+payments+endorsed;
}
