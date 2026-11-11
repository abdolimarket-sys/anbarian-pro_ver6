/**
 * هسته داده‌ای حسابداری انبارین
 * تمام مبالغ در این ماژول به ریال صحیح (integer) نگهداری می‌شوند.
 * این بخش عمداً رابط کاربری و گردش فعلی انبار را تغییر نمی‌دهد.
 */
import { idbGet, idbPut } from './storage';

export type AccountNature = 'debit' | 'credit';
export type AccountLevel = 'group' | 'general' | 'subsidiary' | 'detail';
export type CurrencyDisplay = 'rial' | 'toman';
export type FiscalPeriodStatus = 'open' | 'closed';
export type JournalStatus = 'draft' | 'posted';

export interface LedgerAccount {
  id: string;
  code: string;
  title: string;
  level: AccountLevel;
  nature: AccountNature;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FiscalPeriod {
  id: string;
  title: string;
  startDate: string; // YYYY/MM/DD شمسی
  endDate: string;   // YYYY/MM/DD شمسی
  status: FiscalPeriodStatus;
  createdAt: string;
  closedAt?: string;
}

export interface JournalLine {
  id: string;
  accountId: string;
  description: string;
  debitRial: number;
  creditRial: number;
  partyId?: string;
  costCenterId?: string;
  /** Snapshot نام و کد حساب در زمان قطعی شدن سند برای حفظ سابقه */
  accountCodeSnapshot?: string;
  accountTitleSnapshot?: string;
}

export interface JournalEntry {
  id: string;
  number: string;
  fiscalPeriodId: string;
  date: string; // YYYY/MM/DD شمسی
  description: string;
  status: JournalStatus;
  source: 'manual' | 'opening' | 'sales' | 'purchase' | 'receipt' | 'payment' | 'inventory' | 'closing';
  lines: JournalLine[];
  createdAt: string;
  updatedAt: string;
  postedAt?: string;
  /** شناسه سند تجاری مبدأ برای جلوگیری از ثبت حسابداری تکراری */
  sourceDocumentId?: string;
  /** اگر این سند، معکوسِ یک سند قطعی دیگر باشد */
  reversesEntryId?: string;
  /** اگر این سند قطعی با سند معکوس خنثی شده باشد */
  reversedByEntryId?: string;
}

/** سیاست به‌روزرسانی قیمت خرید کاتالوگ پس از قطعی‌سازی فاکتور خرید */
export type PurchasePriceUpdateMode = 'none' | 'last' | 'average';
/**
 * سیاست به‌روزرسانی قیمت فروش کاتالوگ پس از خرید:
 * - none: بدون تغییر
 * - markup: قیمت فروش = قیمت خرید جدید × (۱ + درصد سود)
 * - keep-ratio: حفظ نسبت قبلی فروش به خرید (اگر خرید قبلی صفر باشد، بدون تغییر)
 */
export type SalePriceUpdateMode = 'none' | 'markup' | 'keep-ratio';

export interface AccountingSettings {
  schemaVersion: 1;
  currencyDisplay: CurrencyDisplay;
  defaultCostingMethod: 'moving-average' | 'fifo';
  /**
   * فروش / خروج کالا حتی وقتی موجودی صفر یا ناکافی است.
   * در حالت خاموش، فقط انبارهایی که در allowNegativeStockByWarehouse فعال شده‌اند مجازند.
   */
  allowNegativeStock: boolean;
  /** پاس/تسویه چک پرداختنی حتی اگر موجودی بانک/صندوق کافی نباشد */
  allowChequeClearWithNegativeCash: boolean;
  /** مجوز موجودی منفی به‌تفکیک انبار (در کنار سیاست سراسری) */
  allowNegativeStockByWarehouse: Record<string, boolean>;
  chartInitialized: boolean;
  /** سال مالی فعال برای ثبت اسناد و عملیات روزمره */
  activeFiscalPeriodId?: string;
  /**
   * پس از قطعی‌سازی فاکتور خرید، قیمت خرید روی کارت کالا چگونه به‌روز شود.
   * بهای تمام‌شده انبار (لایه costing) مستقل است و همیشه از فاکتور تغذیه می‌شود.
   */
  purchasePriceUpdateMode: PurchasePriceUpdateMode;
  /** پس از به‌روز شدن قیمت خرید، قیمت فروش کارت کالا */
  salePriceUpdateMode: SalePriceUpdateMode;
  /** درصد سود روی قیمت خرید وقتی salePriceUpdateMode=markup (مثلاً ۲۵ یعنی ۲۵٪) */
  salePriceMarkupPercent: number;
  /** فروش به «خریدار پیش‌فرض» مجاز باشد */
  allowDefaultCustomerSales: boolean;
  /** خرید از «فروشنده پیش‌فرض» مجاز باشد */
  allowDefaultSupplierPurchases: boolean;
}

export interface AccountingData {
  schemaVersion: 1;
  settings: AccountingSettings;
  accounts: LedgerAccount[];
  fiscalPeriods: FiscalPeriod[];
  journalEntries: JournalEntry[];
}

const DATA_KEY = 'accounting_phase20_data';
const BACKUP_KEY = 'accounting_phase20_backup';

const now = (): string => new Date().toISOString();
const makeId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  schemaVersion: 1,
  currencyDisplay: 'toman',
  defaultCostingMethod: 'moving-average',
  allowNegativeStock: false,
  allowChequeClearWithNegativeCash: false,
  allowNegativeStockByWarehouse: {},
  chartInitialized: false,
  purchasePriceUpdateMode: 'last',
  salePriceUpdateMode: 'none',
  salePriceMarkupPercent: 0,
  allowDefaultCustomerSales: true,
  allowDefaultSupplierPurchases: true,
};

function normalizePurchasePriceMode(v: unknown): PurchasePriceUpdateMode {
  return v === 'none' || v === 'average' || v === 'last' ? v : 'last';
}
function normalizeSalePriceMode(v: unknown): SalePriceUpdateMode {
  return v === 'markup' || v === 'keep-ratio' || v === 'none' ? v : 'none';
}

/** ادغام تنظیمات ذخیره‌شده با پیش‌فرض‌ها (سازگاری با داده‌های قدیمی) */
export function normalizeAccountingSettings(
  input?: Partial<AccountingSettings> | null
): AccountingSettings {
  const src = input || {};
  const markup = Number(src.salePriceMarkupPercent);
  return {
    ...DEFAULT_ACCOUNTING_SETTINGS,
    ...src,
    schemaVersion: 1,
    currencyDisplay: src.currencyDisplay === 'rial' ? 'rial' : 'toman',
    defaultCostingMethod: src.defaultCostingMethod === 'fifo' ? 'fifo' : 'moving-average',
    allowNegativeStock: !!src.allowNegativeStock,
    allowChequeClearWithNegativeCash: !!src.allowChequeClearWithNegativeCash,
    allowNegativeStockByWarehouse: { ...(src.allowNegativeStockByWarehouse || {}) },
    chartInitialized: !!src.chartInitialized,
    activeFiscalPeriodId: src.activeFiscalPeriodId || undefined,
    purchasePriceUpdateMode: normalizePurchasePriceMode(src.purchasePriceUpdateMode),
    salePriceUpdateMode: normalizeSalePriceMode(src.salePriceUpdateMode),
    salePriceMarkupPercent: Number.isFinite(markup) ? Math.max(0, Math.min(1000, markup)) : 0,
    // پیش‌فرض true برای سازگاری با نسخه‌های قبلی که این کلید را نداشتند
    allowDefaultCustomerSales: src.allowDefaultCustomerSales !== false,
    allowDefaultSupplierPurchases: src.allowDefaultSupplierPurchases !== false,
  };
}

/** کدینگ آغازین پیشنهادی؛ قابل توسعه و ویرایش توسط مدیر. */
export const SUGGESTED_CHART = [
  { id: 'grp-assets', code: '1', title: 'دارایی‌ها', level: 'group', nature: 'debit', parentId: null, isActive: true, isSystem: true },
  { id: 'acc-current-assets', code: '11', title: 'دارایی‌های جاری', level: 'general', nature: 'debit', parentId: 'grp-assets', isActive: true, isSystem: true },
  { id: 'sub-cash-bank', code: '1101', title: 'موجودی نقد و بانک', level: 'subsidiary', nature: 'debit', parentId: 'acc-current-assets', isActive: true, isSystem: true },
  { id: 'det-cash', code: '110101', title: 'صندوق', level: 'detail', nature: 'debit', parentId: 'sub-cash-bank', isActive: true, isSystem: true },
  { id: 'det-bank', code: '110102', title: 'بانک', level: 'detail', nature: 'debit', parentId: 'sub-cash-bank', isActive: true, isSystem: true },
  { id: 'sub-receivables', code: '1102', title: 'حساب‌ها و اسناد دریافتنی', level: 'subsidiary', nature: 'debit', parentId: 'acc-current-assets', isActive: true, isSystem: true },
  { id: 'det-customers', code: '110201', title: 'اشخاص دریافتنی', level: 'detail', nature: 'debit', parentId: 'sub-receivables', isActive: true, isSystem: true },
  { id: 'sub-inventory', code: '1103', title: 'موجودی کالا', level: 'subsidiary', nature: 'debit', parentId: 'acc-current-assets', isActive: true, isSystem: true },
  { id: 'grp-liabilities', code: '2', title: 'بدهی‌ها', level: 'group', nature: 'credit', parentId: null, isActive: true, isSystem: true },
  { id: 'acc-current-liabilities', code: '21', title: 'بدهی‌های جاری', level: 'general', nature: 'credit', parentId: 'grp-liabilities', isActive: true, isSystem: true },
  { id: 'sub-payables', code: '2101', title: 'حساب‌ها و اسناد پرداختنی', level: 'subsidiary', nature: 'credit', parentId: 'acc-current-liabilities', isActive: true, isSystem: true },
  { id: 'det-suppliers', code: '210101', title: 'اشخاص پرداختنی', level: 'detail', nature: 'credit', parentId: 'sub-payables', isActive: true, isSystem: true },
  { id: 'det-landed-payable', code: '210102', title: 'هزینه‌های جانبی خرید پرداختنی', level: 'detail', nature: 'credit', parentId: 'sub-payables', isActive: true, isSystem: true },
  { id: 'grp-equity', code: '3', title: 'حقوق مالکانه', level: 'group', nature: 'credit', parentId: null, isActive: true, isSystem: true },
  { id: 'grp-revenue', code: '4', title: 'درآمدها', level: 'group', nature: 'credit', parentId: null, isActive: true, isSystem: true },
  { id: 'acc-sales', code: '41', title: 'فروش کالا و خدمات', level: 'general', nature: 'credit', parentId: 'grp-revenue', isActive: true, isSystem: true },
  { id: 'sub-sales-goods', code: '4101', title: 'فروش کالا', level: 'subsidiary', nature: 'credit', parentId: 'acc-sales', isActive: true, isSystem: true },
  { id: 'det-sales-goods', code: '410101', title: 'فروش کالای اصلی', level: 'detail', nature: 'credit', parentId: 'sub-sales-goods', isActive: true, isSystem: true },
  { id: 'grp-cogs', code: '5', title: 'بهای تمام‌شده', level: 'group', nature: 'debit', parentId: null, isActive: true, isSystem: true },
  { id: 'acc-cogs', code: '51', title: 'بهای تمام‌شده کالای فروش‌رفته', level: 'general', nature: 'debit', parentId: 'grp-cogs', isActive: true, isSystem: true },
  { id: 'sub-cogs-goods', code: '5101', title: 'بهای تمام‌شده کالای فروش‌رفته', level: 'subsidiary', nature: 'debit', parentId: 'acc-cogs', isActive: true, isSystem: true },
  { id: 'det-cogs-goods', code: '510101', title: 'بهای تمام‌شده کالای اصلی', level: 'detail', nature: 'debit', parentId: 'sub-cogs-goods', isActive: true, isSystem: true },
  { id: 'grp-expenses', code: '6', title: 'هزینه‌ها', level: 'group', nature: 'debit', parentId: null, isActive: true, isSystem: true },
  { id: 'acc-operating-expenses', code: '61', title: 'هزینه‌های عملیاتی', level: 'general', nature: 'debit', parentId: 'grp-expenses', isActive: true, isSystem: true },
  { id: 'sub-admin-expenses', code: '6101', title: 'هزینه‌های اداری', level: 'subsidiary', nature: 'debit', parentId: 'acc-operating-expenses', isActive: true, isSystem: true },
  { id: 'det-admin-expenses', code: '610101', title: 'هزینه ملزومات اداری', level: 'detail', nature: 'debit', parentId: 'sub-admin-expenses', isActive: true, isSystem: true },
  { id: 'sub-purchases', code: '5102', title: 'خرید کالا', level: 'subsidiary', nature: 'debit', parentId: 'acc-cogs', isActive: true, isSystem: true },
  { id: 'det-purchases', code: '510201', title: 'خرید کالا و مواد', level: 'detail', nature: 'debit', parentId: 'sub-purchases', isActive: true, isSystem: true },
  { id: 'sub-input-tax', code: '1104', title: 'مالیات و عوارض ارزش افزوده خرید', level: 'subsidiary', nature: 'debit', parentId: 'acc-current-assets', isActive: true, isSystem: true },
  { id: 'det-input-tax', code: '110401', title: 'مالیات ارزش افزوده خرید', level: 'detail', nature: 'debit', parentId: 'sub-input-tax', isActive: true, isSystem: true },
  { id: 'sub-output-tax', code: '2102', title: 'مالیات و عوارض ارزش افزوده فروش', level: 'subsidiary', nature: 'credit', parentId: 'acc-current-liabilities', isActive: true, isSystem: true },
  { id: 'det-output-tax', code: '210201', title: 'مالیات ارزش افزوده فروش', level: 'detail', nature: 'credit', parentId: 'sub-output-tax', isActive: true, isSystem: true },
  // تکمیل کدینگ استاندارد: دارایی ثابت، بدهی بلندمدت، سرمایه و سرفصل‌های عملکردی
  { id: 'acc-fixed-assets', code: '12', title: 'دارایی‌های غیرجاری', level: 'general', nature: 'debit', parentId: 'grp-assets', isActive: true, isSystem: true },
  { id: 'sub-tangible-assets', code: '1201', title: 'دارایی‌های ثابت مشهود', level: 'subsidiary', nature: 'debit', parentId: 'acc-fixed-assets', isActive: true, isSystem: true },
  { id: 'det-equipment', code: '120101', title: 'تجهیزات و اثاثیه', level: 'detail', nature: 'debit', parentId: 'sub-tangible-assets', isActive: true, isSystem: true },
  { id: 'det-accum-depr', code: '120102', title: 'استهلاک انباشته دارایی‌ها', level: 'detail', nature: 'credit', parentId: 'sub-tangible-assets', isActive: true, isSystem: true },
  { id: 'acc-long-liabilities', code: '22', title: 'بدهی‌های غیرجاری', level: 'general', nature: 'credit', parentId: 'grp-liabilities', isActive: true, isSystem: true },
  { id: 'sub-long-payables', code: '2201', title: 'تسهیلات و اسناد پرداختنی بلندمدت', level: 'subsidiary', nature: 'credit', parentId: 'acc-long-liabilities', isActive: true, isSystem: true },
  { id: 'det-long-loans', code: '220101', title: 'وام‌ها و تسهیلات بلندمدت', level: 'detail', nature: 'credit', parentId: 'sub-long-payables', isActive: true, isSystem: true },
  { id: 'acc-capital', code: '31', title: 'سرمایه', level: 'general', nature: 'credit', parentId: 'grp-equity', isActive: true, isSystem: true },
  { id: 'sub-owner-capital', code: '3101', title: 'سرمایه مالک / شرکا', level: 'subsidiary', nature: 'credit', parentId: 'acc-capital', isActive: true, isSystem: true },
  { id: 'det-owner-capital', code: '310101', title: 'سرمایه ثبت‌شده', level: 'detail', nature: 'credit', parentId: 'sub-owner-capital', isActive: true, isSystem: true },
  { id: 'acc-retained', code: '32', title: 'سود و زیان انباشته', level: 'general', nature: 'credit', parentId: 'grp-equity', isActive: true, isSystem: true },
  { id: 'sub-retained', code: '3201', title: 'سود و زیان سنواتی', level: 'subsidiary', nature: 'credit', parentId: 'acc-retained', isActive: true, isSystem: true },
  { id: 'det-retained', code: '320101', title: 'سود و زیان انباشته', level: 'detail', nature: 'credit', parentId: 'sub-retained', isActive: true, isSystem: true },
  { id: 'sub-sales-returns', code: '4102', title: 'برگشت از فروش و تخفیفات', level: 'subsidiary', nature: 'debit', parentId: 'acc-sales', isActive: true, isSystem: true },
  { id: 'det-sales-returns', code: '410201', title: 'برگشت از فروش', level: 'detail', nature: 'debit', parentId: 'sub-sales-returns', isActive: true, isSystem: true },
  { id: 'acc-other-income', code: '42', title: 'سایر درآمدها', level: 'general', nature: 'credit', parentId: 'grp-revenue', isActive: true, isSystem: true },
  { id: 'sub-other-income', code: '4201', title: 'درآمدهای متفرقه', level: 'subsidiary', nature: 'credit', parentId: 'acc-other-income', isActive: true, isSystem: true },
  { id: 'det-other-income', code: '420101', title: 'سایر درآمدهای عملیاتی', level: 'detail', nature: 'credit', parentId: 'sub-other-income', isActive: true, isSystem: true },
  { id: 'sub-payroll', code: '6102', title: 'حقوق و دستمزد', level: 'subsidiary', nature: 'debit', parentId: 'acc-operating-expenses', isActive: true, isSystem: true },
  { id: 'det-payroll', code: '610201', title: 'هزینه حقوق و دستمزد', level: 'detail', nature: 'debit', parentId: 'sub-payroll', isActive: true, isSystem: true },
  { id: 'sub-rent', code: '6103', title: 'اجاره و نگهداری', level: 'subsidiary', nature: 'debit', parentId: 'acc-operating-expenses', isActive: true, isSystem: true },
  { id: 'det-rent', code: '610301', title: 'هزینه اجاره', level: 'detail', nature: 'debit', parentId: 'sub-rent', isActive: true, isSystem: true },
  // درآمد مالی (۴۳) · هزینه مالی (۶۲) · مالیات بر درآمد (۶۳)
  { id: 'acc-finance-income', code: '43', title: 'درآمدهای مالی', level: 'general', nature: 'credit', parentId: 'grp-revenue', isActive: true, isSystem: true },
  { id: 'sub-finance-income', code: '4301', title: 'سود و درآمدهای مالی', level: 'subsidiary', nature: 'credit', parentId: 'acc-finance-income', isActive: true, isSystem: true },
  { id: 'det-finance-income', code: '430101', title: 'درآمد سود سپرده و تسهیلات', level: 'detail', nature: 'credit', parentId: 'sub-finance-income', isActive: true, isSystem: true },
  { id: 'acc-finance-expenses', code: '62', title: 'هزینه‌های مالی', level: 'general', nature: 'debit', parentId: 'grp-expenses', isActive: true, isSystem: true },
  { id: 'sub-finance-expenses', code: '6201', title: 'سود و کارمزد تسهیلات', level: 'subsidiary', nature: 'debit', parentId: 'acc-finance-expenses', isActive: true, isSystem: true },
  { id: 'det-finance-interest', code: '620101', title: 'هزینه سود تسهیلات بانکی', level: 'detail', nature: 'debit', parentId: 'sub-finance-expenses', isActive: true, isSystem: true },
  { id: 'det-finance-fees', code: '620102', title: 'کارمزد و هزینه خدمات مالی', level: 'detail', nature: 'debit', parentId: 'sub-finance-expenses', isActive: true, isSystem: true },
  { id: 'acc-income-tax', code: '63', title: 'مالیات بر درآمد', level: 'general', nature: 'debit', parentId: 'grp-expenses', isActive: true, isSystem: true },
  { id: 'sub-income-tax', code: '6301', title: 'مالیات عملکرد', level: 'subsidiary', nature: 'debit', parentId: 'acc-income-tax', isActive: true, isSystem: true },
  { id: 'det-income-tax', code: '630101', title: 'هزینه مالیات بر درآمد', level: 'detail', nature: 'debit', parentId: 'sub-income-tax', isActive: true, isSystem: true },
  { id: 'sub-inventory-impairment', code: '6104', title: 'کاهش ارزش موجودی', level: 'subsidiary', nature: 'debit', parentId: 'acc-operating-expenses', isActive: true, isSystem: true },
  { id: 'det-inventory-impairment', code: '610401', title: 'زیان کاهش ارزش موجودی کالا', level: 'detail', nature: 'debit', parentId: 'sub-inventory-impairment', isActive: true, isSystem: true },
  { id: 'sub-cost-variances', code: '5103', title: 'انحرافات بهای تمام‌شده', level: 'subsidiary', nature: 'debit', parentId: 'acc-cogs', isActive: true, isSystem: true },
  { id: 'det-purchase-price-variance', code: '510301', title: 'انحراف قیمت خرید (بهای استاندارد)', level: 'detail', nature: 'debit', parentId: 'sub-cost-variances', isActive: true, isSystem: true },
] satisfies ReadonlyArray<Omit<LedgerAccount, 'createdAt' | 'updatedAt'>>;

export function createEmptyAccountingData(): AccountingData {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_ACCOUNTING_SETTINGS, allowNegativeStockByWarehouse: {} },
    accounts: [],
    fiscalPeriods: [],
    journalEntries: [],
  };
}

function isAccountingData(value: unknown): value is AccountingData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<AccountingData>;
  return v.schemaVersion === 1 && !!v.settings && Array.isArray(v.accounts) && Array.isArray(v.fiscalPeriods) && Array.isArray(v.journalEntries);
}

export async function loadAccountingData(): Promise<AccountingData> {
  try {
    const current = await idbGet<unknown>(DATA_KEY);
    if (isAccountingData(current)) {
      return { ...current, settings: normalizeAccountingSettings(current.settings) };
    }
  } catch (error) {
    console.warn('accounting data read failed', error);
  }
  try {
    const backup = await idbGet<unknown>(BACKUP_KEY);
    if (isAccountingData(backup)) {
      return { ...backup, settings: normalizeAccountingSettings(backup.settings) };
    }
  } catch (error) {
    console.warn('accounting backup read failed', error);
  }
  return createEmptyAccountingData();
}

export async function saveAccountingData(data: AccountingData): Promise<void> {
  if (!isAccountingData(data)) throw new Error('ساختار اطلاعات حسابداری معتبر نیست.');
  await idbPut(BACKUP_KEY, data);
  await idbPut(DATA_KEY, data);
}

export async function initializeSuggestedChart(): Promise<AccountingData> {
  const data = await loadAccountingData();
  const timestamp = now();
  // مهاجرت افزایشی و غیرمخرب: کدینگ استاندارد به اطلاعات قبلی اضافه می‌شود؛
  // حساب‌های سفارشی کاربر و گردش اسناد موجود دست‌نخورده می‌مانند.
  const knownIds = new Set(data.accounts.map((account) => account.id));
  const knownCodes = new Set(data.accounts.map((account) => account.code));
  const missing = SUGGESTED_CHART.filter((account) => !knownIds.has(account.id) && !knownCodes.has(account.code));
  if (missing.length) {
    data.accounts = [...data.accounts, ...missing.map((account) => ({ ...account, createdAt: timestamp, updatedAt: timestamp }))];
    data.settings.chartInitialized = true;
    await saveAccountingData(data);
  } else if (!data.settings.chartInitialized && data.accounts.length === 0) {
    data.settings.chartInitialized = true;
    await saveAccountingData(data);
  }
  return data;
}

export function validateAccount(input: Pick<LedgerAccount, 'code' | 'title' | 'level' | 'parentId'>, accounts: LedgerAccount[], excludeId?: string): string[] {
  const errors: string[] = [];
  const code = input.code.trim();
  const title = input.title.trim();
  if (!code) errors.push('کد حساب الزامی است.');
  if (!title) errors.push('عنوان حساب الزامی است.');
  if (accounts.some((a) => a.id !== excludeId && a.code === code)) errors.push('کد حساب تکراری است.');
  const parent = input.parentId ? accounts.find((a) => a.id === input.parentId) : undefined;
  if (input.level === 'group' && input.parentId) errors.push('حساب گروه نباید والد داشته باشد.');
  if (input.level !== 'group' && !parent) errors.push('برای این سطح، انتخاب حساب والد الزامی است.');
  const expectedParent: Record<Exclude<AccountLevel, 'group'>, AccountLevel> = {
    general: 'group', subsidiary: 'general', detail: 'subsidiary',
  };
  if (parent && input.level !== 'group' && parent.level !== expectedParent[input.level]) {
    errors.push('سطح حساب والد با سطح حساب جدید سازگار نیست.');
  }
  return errors;
}

export function upsertAccount(data: AccountingData, input: Omit<LedgerAccount, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): AccountingData {
  const errors = validateAccount(input, data.accounts, input.id);
  if (errors.length) throw new Error(errors.join('\n'));
  const timestamp = now();
  const existing = input.id ? data.accounts.find((a) => a.id === input.id) : undefined;
  if (input.id && !existing) throw new Error('حساب موردنظر پیدا نشد.');
  const next: LedgerAccount = {
    ...input,
    id: existing?.id || makeId('acc'),
    code: input.code.trim(),
    title: input.title.trim(),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  return {
    ...data,
    accounts: existing ? data.accounts.map((a) => a.id === existing.id ? next : a) : [...data.accounts, next],
  };
}

export function removeAccount(data: AccountingData, accountId: string): AccountingData {
  const account = data.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('حساب موردنظر پیدا نشد.');
  if (account.isSystem) throw new Error('حساب پایه سیستمی حذف نمی‌شود؛ می‌توانید آن را غیرفعال کنید.');
  if (data.accounts.some((a) => a.parentId === accountId)) throw new Error('ابتدا زیرحساب‌های این حساب را منتقل یا حذف کنید.');
  if (data.journalEntries.some((entry) => entry.lines.some((line) => line.accountId === accountId))) throw new Error('این حساب در اسناد استفاده شده و قابل حذف نیست.');
  return { ...data, accounts: data.accounts.filter((a) => a.id !== accountId) };
}

/** ورودی/نمایش پول با محاسبات ده‌دهی رشته‌ای و بدون خطای ممیز شناور. */
export function parseMoneyToRial(value: string, unit: CurrencyDisplay): number {
  const normalized = value.trim().replace(/[٬,\s]/g, '').replace(/٫/g, '.').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const pattern = unit === 'toman' ? /^\d+(\.\d{1})?$/ : /^\d+$/;
  if (!pattern.test(normalized)) throw new Error(unit === 'toman' ? 'مبلغ تومان باید حداکثر یک رقم اعشار داشته باشد.' : 'مبلغ ریالی باید عدد صحیح باشد.');
  const [whole, fraction = ''] = normalized.split('.');
  const scale = unit === 'toman' ? 10 : 1;
  const wholeRial = Number(whole) * scale;
  const fractionRial = unit === 'toman' ? Number((fraction + '0').slice(0, 1)) : Number(fraction || 0);
  const result = wholeRial + fractionRial;
  if (!Number.isSafeInteger(result)) throw new Error('مبلغ از محدوده مجاز بیشتر است.');
  return result;
}

export function formatMoneyFromRial(amountRial: number, unit: CurrencyDisplay): string {
  if (!Number.isSafeInteger(amountRial)) throw new Error('مبلغ ذخیره‌شده باید عدد صحیح ریال باشد.');
  if (unit === 'rial') return String(amountRial);
  const whole = Math.trunc(amountRial / 10);
  const remainder = Math.abs(amountRial % 10);
  return remainder ? `${whole}.${remainder}` : String(whole);
}

/** ذخیره پیش‌نویس؛ سند قطعی قابل ویرایش نیست. */
export function upsertJournalEntry(data: AccountingData, entry: JournalEntry): AccountingData {
  if (entry.status !== 'draft') throw new Error('برای تغییر سند قطعی باید سند اصلاحی جداگانه ثبت شود.');
  const existing = data.journalEntries.find((item) => item.id === entry.id);
  if (existing?.status === 'posted') throw new Error('سند قطعی قابل ویرایش نیست؛ سند اصلاحی ثبت کنید.');
  if (data.journalEntries.some((item) => item.id !== entry.id && item.number === entry.number)) throw new Error('شماره سند تکراری است.');
  const errors = validateJournalEntry(entry, data, false);
  if (errors.length) throw new Error(errors.join('\n'));
  const saved = { ...entry, updatedAt: now() };
  return {
    ...data,
    journalEntries: existing
      ? data.journalEntries.map((item) => item.id === entry.id ? saved : item)
      : [...data.journalEntries, saved],
  };
}

/** قطعی کردن سند، همراه با ثبت snapshot حساب برای حفظ گزارش تاریخی. */
export function postJournalEntry(data: AccountingData, entryId: string): AccountingData {
  const entry = data.journalEntries.find((item) => item.id === entryId);
  if (!entry) throw new Error('سند موردنظر پیدا نشد.');
  if (entry.status === 'posted') return data;
  const errors = validateJournalEntry(entry, data);
  if (errors.length) throw new Error(errors.join('\n'));
  const timestamp = now();
  const posted: JournalEntry = {
    ...entry,
    status: 'posted',
    postedAt: timestamp,
    updatedAt: timestamp,
    lines: entry.lines.map((line) => {
      const account = data.accounts.find((item) => item.id === line.accountId)!;
      return { ...line, accountCodeSnapshot: account.code, accountTitleSnapshot: account.title };
    }),
  };
  return { ...data, journalEntries: data.journalEntries.map((item) => item.id === entryId ? posted : item) };
}

/**
 * صدور سند معکوس (اصلاحی) برای یک سند قطعی.
 * آرتیکل‌ها جابه‌جا می‌شوند؛ سند اصلی ویرایش نمی‌شود و فقط به سند معکوس لینک می‌شود.
 */
export function createReversingJournalEntry(
  data: AccountingData,
  originalEntryId: string,
  options?: { date?: string; description?: string; autoPost?: boolean },
): AccountingData {
  const original = data.journalEntries.find((item) => item.id === originalEntryId);
  if (!original) throw new Error('سند اصلی پیدا نشد.');
  if (original.status !== 'posted') throw new Error('فقط سند قطعی قابل معکوس‌سازی است.');
  if (original.reversedByEntryId) {
    const existing = data.journalEntries.find((x) => x.id === original.reversedByEntryId);
    throw new Error(existing
      ? `این سند قبلاً با سند ${existing.number} معکوس شده است.`
      : 'این سند قبلاً معکوس شده است.');
  }
  if (original.reversesEntryId) throw new Error('خودِ سند معکوس را دوباره معکوس نکنید؛ در صورت نیاز سند جدید ثبت کنید.');

  const period = resolveActiveFiscalPeriod(data);
  const date = options?.date || original.date;
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) throw new Error('تاریخ سند معکوس باید شمسی و به شکل سال/ماه/روز باشد.');
  if (period.status !== 'open') throw new Error('سال مالی فعال بسته است؛ سند معکوس ثبت نمی‌شود.');
  if (date < period.startDate || date > period.endDate) throw new Error('تاریخ سند معکوس خارج از محدوده سال مالی فعال است.');

  const reverseLines: JournalLine[] = original.lines.map((line) => ({
    id: makeId('line'),
    accountId: line.accountId,
    description: line.description ? `معکوس: ${line.description}` : `معکوس سند ${original.number}`,
    debitRial: line.creditRial,
    creditRial: line.debitRial,
    partyId: line.partyId,
  }));

  const description = (options?.description || '').trim()
    || `سند معکوس بابت سند ${original.number} — ${original.description}`;

  const baseNumber = `REV-${original.number}`;
  let number = baseNumber;
  let n = 2;
  while (data.journalEntries.some((e) => e.number === number)) {
    number = `${baseNumber}-${n++}`;
  }

  const timestamp = now();
  const reverseEntry: JournalEntry = {
    id: makeId('je'),
    number,
    fiscalPeriodId: period.id,
    date,
    description,
    status: 'draft',
    source: 'manual',
    sourceDocumentId: `reverse:${original.id}`,
    reversesEntryId: original.id,
    lines: reverseLines,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  let next = upsertJournalEntry(data, reverseEntry);
  if (options?.autoPost !== false) {
    next = postJournalEntry(next, reverseEntry.id);
  }
  const finalReverse = next.journalEntries.find((e) => e.id === reverseEntry.id)!;
  next = {
    ...next,
    journalEntries: next.journalEntries.map((e) =>
      e.id === original.id
        ? { ...e, reversedByEntryId: finalReverse.id, updatedAt: timestamp }
        : e,
    ),
  };
  return next;
}

export function validateJournalEntry(entry: Pick<JournalEntry, 'fiscalPeriodId' | 'date' | 'lines'>, data: AccountingData, requireBalance = true): string[] {
  const errors: string[] = [];
  if ('number' in entry && !String(entry.number || '').trim()) errors.push('شماره سند الزامی است.');
  if ('description' in entry && !String(entry.description || '').trim()) errors.push('شرح سند الزامی است.');
  const period = data.fiscalPeriods.find((p) => p.id === entry.fiscalPeriodId);
  if (!period) errors.push('سال مالی انتخاب‌شده وجود ندارد.');
  else {
    if (period.status !== 'open') errors.push('سال مالی بسته است.');
    if (entry.date < period.startDate || entry.date > period.endDate) errors.push('تاریخ سند خارج از محدوده سال مالی است.');
  }
  if (requireBalance && entry.lines.length < 2) errors.push('سند باید حداقل دو ردیف داشته باشد.');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(entry.date)) errors.push('تاریخ سند باید به شکل سال/ماه/روز شمسی باشد.');
  let debit = 0;
  let credit = 0;
  for (const line of entry.lines) {
    const account = data.accounts.find((a) => a.id === line.accountId);
    if (!account || !account.isActive) errors.push(`حساب ردیف ${line.id} معتبر یا فعال نیست.`);
    if (account && account.level !== 'detail') errors.push(`ثبت مستقیم روی حساب تفصیلی‌پذیر الزامی است: ${account.title}`);
    if (!Number.isSafeInteger(line.debitRial) || !Number.isSafeInteger(line.creditRial) || line.debitRial < 0 || line.creditRial < 0) errors.push('مبالغ بدهکار و بستانکار باید عدد صحیح و نامنفی ریال باشند.');
    if (line.debitRial > 0 && line.creditRial > 0) errors.push('هر ردیف فقط می‌تواند بدهکار یا بستانکار باشد.');
    if (requireBalance && line.debitRial === 0 && line.creditRial === 0) errors.push('ردیف سند باید مبلغ بدهکار یا بستانکار داشته باشد.');
    debit += line.debitRial;
    credit += line.creditRial;
  }
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) errors.push('جمع مبالغ از محدوده مجاز محاسبات خارج است.');
  if (requireBalance && debit !== credit) errors.push('سند تراز نیست؛ جمع بدهکار و بستانکار باید برابر باشد.');
  if (requireBalance && debit <= 0) errors.push('مبلغ سند باید بیشتر از صفر باشد.');
  return errors;
}


/** سال مالی فعال؛ در صورت نبود، اولین سال باز انتخاب و ذخیره می‌شود. */
export function resolveActiveFiscalPeriod(data: AccountingData): FiscalPeriod {
  const open = data.fiscalPeriods.filter((p) => p.status === 'open');
  if (!open.length) throw new Error('هیچ سال مالی بازی تعریف نشده است. ابتدا از بخش سال مالی یک دوره باز ایجاد کنید.');
  const activeId = data.settings.activeFiscalPeriodId;
  const active = open.find((p) => p.id === activeId) || open[open.length - 1];
  return active;
}

export function withActiveFiscalPeriod(data: AccountingData, periodId: string): AccountingData {
  const period = data.fiscalPeriods.find((p) => p.id === periodId);
  if (!period) throw new Error('سال مالی پیدا نشد.');
  if (period.status !== 'open') throw new Error('فقط سال مالی باز را می‌توان فعال کرد.');
  return {
    ...data,
    settings: { ...data.settings, activeFiscalPeriodId: periodId },
  };
}

export function createFiscalPeriod(input: Pick<FiscalPeriod, 'title' | 'startDate' | 'endDate'>, existing: FiscalPeriod[]): FiscalPeriod {
  const title = input.title.trim();
  if (!title) throw new Error('عنوان سال مالی الزامی است.');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(input.startDate) || !/^\d{4}\/\d{2}\/\d{2}$/.test(input.endDate)) throw new Error('تاریخ‌ها باید به شکل سال/ماه/روز شمسی باشند.');
  if (input.startDate > input.endDate) throw new Error('تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.');
  if (existing.some((p) => p.title === title)) throw new Error('عنوان سال مالی تکراری است.');
  if (existing.some((p) => input.startDate <= p.endDate && input.endDate >= p.startDate)) throw new Error('بازه سال مالی با یک سال مالی دیگر هم‌پوشانی دارد.');
  return { ...input, id: makeId('fy'), title, status: 'open', createdAt: now() };
}

export function closeFiscalPeriod(data: AccountingData, periodId: string): AccountingData {
  const period = data.fiscalPeriods.find((p) => p.id === periodId);
  if (!period) throw new Error('سال مالی پیدا نشد.');
  if (period.status === 'closed') return data;
  const drafts = data.journalEntries.filter((entry) => entry.fiscalPeriodId === periodId && entry.status === 'draft');
  if (drafts.length) throw new Error('برای بستن سال مالی، ابتدا اسناد پیش‌نویس را تعیین تکلیف کنید.');
  return {
    ...data,
    fiscalPeriods: data.fiscalPeriods.map((p) => p.id === periodId ? { ...p, status: 'closed', closedAt: now() } : p),
  };
}

/**
 * پیش‌نمایش و تهیه اسناد اختتامیه و افتتاحیه.
 * گروه حساب‌های ۴، ۵ و ۶ به‌عنوان حساب‌های موقت در نظر گرفته می‌شوند؛
 * حساب سود و زیان انباشته باید توسط مدیر به‌صورت تفصیلی انتخاب شود.
 */
export interface FiscalClosingPreview {
  period: FiscalPeriod;
  postedEntryCount: number;
  draftEntryCount: number;
  temporaryAccounts: Array<{ accountId: string; code: string; title: string; debitRial: number; creditRial: number }>;
  permanentAccounts: Array<{ accountId: string; code: string; title: string; debitRial: number; creditRial: number }>;
  profitOrLossRial: number;
  totalDebitRial: number;
  totalCreditRial: number;
  errors: string[];
}

const isTemporaryAccount = (code: string): boolean => /^[456]/.test(code);

export function previewFiscalClosing(data: AccountingData, periodId: string): FiscalClosingPreview {
  const period = data.fiscalPeriods.find((item) => item.id === periodId);
  if (!period) throw new Error('سال مالی پیدا نشد.');
  const posted = data.journalEntries.filter((entry) => entry.fiscalPeriodId === periodId && entry.status === 'posted');
  const drafts = data.journalEntries.filter((entry) => entry.fiscalPeriodId === periodId && entry.status === 'draft');
  const balances = new Map<string, { debit: number; credit: number }>();
  for (const entry of posted) for (const line of entry.lines) {
    const current = balances.get(line.accountId) || { debit: 0, credit: 0 };
    current.debit += line.debitRial;
    current.credit += line.creditRial;
    balances.set(line.accountId, current);
  }
  const rows = [...balances.entries()].map(([accountId, balance]) => {
    const account = data.accounts.find((item) => item.id === accountId);
    if (!account) return null;
    const net = balance.debit - balance.credit;
    return {
      accountId, code: account.code, title: account.title,
      debitRial: Math.max(0, net), creditRial: Math.max(0, -net),
    };
  }).filter((item): item is NonNullable<typeof item> => !!item);
  const temporaryAccounts = rows.filter((item) => isTemporaryAccount(item.code) && (item.debitRial || item.creditRial));
  const permanentAccounts = rows.filter((item) => !isTemporaryAccount(item.code) && (item.debitRial || item.creditRial));
  const temporaryDebit = temporaryAccounts.reduce((sum, item) => sum + item.debitRial, 0);
  const temporaryCredit = temporaryAccounts.reduce((sum, item) => sum + item.creditRial, 0);
  const totalDebitRial = rows.reduce((sum, item) => sum + item.debitRial, 0);
  const totalCreditRial = rows.reduce((sum, item) => sum + item.creditRial, 0);
  const errors: string[] = [];
  if (drafts.length) errors.push(`${drafts.length} سند پیش‌نویس تعیین تکلیف نشده است.`);
  if (period.status !== 'open') errors.push('این سال مالی قبلاً بسته شده است.');
  if (!Number.isSafeInteger(totalDebitRial) || !Number.isSafeInteger(totalCreditRial)) errors.push('جمع گردش حساب‌ها از محدوده مجاز محاسبات خارج است.');
  return {
    period, postedEntryCount: posted.length, draftEntryCount: drafts.length,
    temporaryAccounts, permanentAccounts,
    profitOrLossRial: temporaryCredit - temporaryDebit,
    totalDebitRial, totalCreditRial, errors,
  };
}

/** ایجاد سند اختتامیه حساب‌های موقت؛ این تابع فقط پیش‌نویس می‌سازد و چیزی را قطعی نمی‌کند. */
export function buildFiscalClosingEntry(
  data: AccountingData,
  periodId: string,
  retainedEarningsAccountId: string,
): AccountingData {
  const preview = previewFiscalClosing(data, periodId);
  if (preview.errors.length) throw new Error(preview.errors.join('\n'));
  if (data.journalEntries.some((entry) => entry.sourceDocumentId === `year-close:${periodId}`)) {
    throw new Error('سند اختتامیه این سال مالی قبلاً ایجاد شده است.');
  }
  const retained = data.accounts.find((account) => account.id === retainedEarningsAccountId && account.isActive && account.level === 'detail');
  if (!retained) throw new Error('حساب سود و زیان انباشته باید یک حساب تفصیلی فعال باشد.');
  const lines: JournalLine[] = [];
  for (const account of preview.temporaryAccounts) {
    lines.push({
      id: makeId('line'), accountId: account.accountId,
      description: 'بستن مانده حساب موقت در پایان سال مالی',
      debitRial: account.creditRial, creditRial: account.debitRial,
    });
  }
  const debit = lines.reduce((sum, line) => sum + line.debitRial, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditRial, 0);
  if (debit > credit) lines.push({ id: makeId('line'), accountId: retained.id, description: 'انتقال سود خالص سال به سود و زیان انباشته', debitRial: 0, creditRial: debit - credit });
  if (credit > debit) lines.push({ id: makeId('line'), accountId: retained.id, description: 'انتقال زیان خالص سال به سود و زیان انباشته', debitRial: credit - debit, creditRial: 0 });
  if (!lines.length) throw new Error('برای این سال مالی مانده‌ای جهت بستن وجود ندارد.');
  const timestamp = now();
  const entry: JournalEntry = {
    id: makeId('je'), number: `CLOSE-${periodId}`, fiscalPeriodId: periodId,
    date: preview.period.endDate, description: `سند اختتامیه سال مالی ${preview.period.title}`,
    status: 'draft', source: 'closing', sourceDocumentId: `year-close:${periodId}`,
    lines, createdAt: timestamp, updatedAt: timestamp,
  };
  return upsertJournalEntry(data, entry);
}

/** تهیه سند افتتاحیه سال جدید از مانده حساب‌های دائمی سال قبل، پس از قطعی‌شدن سند اختتامیه. */
export function buildFiscalOpeningEntry(data: AccountingData, previousPeriodId: string, nextPeriodId: string): AccountingData {
  const previous = data.fiscalPeriods.find((period) => period.id === previousPeriodId);
  const next = data.fiscalPeriods.find((period) => period.id === nextPeriodId);
  if (!previous || !next) throw new Error('سال مالی مبدأ یا مقصد پیدا نشد.');
  if (previous.status !== 'open') throw new Error('برای تهیه افتتاحیه، سال مالی مبدأ باید هنوز باز باشد.');
  if (next.status !== 'open') throw new Error('سال مالی مقصد بسته است.');
  if (next.startDate <= previous.endDate) throw new Error('تاریخ شروع سال جدید باید پس از پایان سال قبل باشد.');
  const closeId = `year-close:${previousPeriodId}`;
  const closingEntry = data.journalEntries.find((entry) => entry.sourceDocumentId === closeId);
  if (!closingEntry || closingEntry.status !== 'posted') throw new Error('ابتدا سند اختتامیه را ایجاد و قطعی کنید.');
  const openingKey = `year-opening:${previousPeriodId}:${nextPeriodId}`;
  if (data.journalEntries.some((entry) => entry.sourceDocumentId === openingKey)) throw new Error('سند افتتاحیه این دو سال مالی قبلاً ایجاد شده است.');
  const preview = previewFiscalClosing(data, previousPeriodId);
  const lines: JournalLine[] = preview.permanentAccounts.map((account) => ({
    id: makeId('line'), accountId: account.accountId,
    description: `انتقال مانده از سال مالی ${previous.title}`,
    debitRial: account.debitRial, creditRial: account.creditRial,
  }));
  const debit = lines.reduce((sum, line) => sum + line.debitRial, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditRial, 0);
  if (debit !== credit) throw new Error('مانده حساب‌های دائمی تراز نیست؛ سند اختتامیه و حساب سود و زیان انباشته را بررسی کنید.');
  if (!lines.length) throw new Error('مانده‌ای برای انتقال به سال مالی جدید وجود ندارد.');
  const timestamp = now();
  const entry: JournalEntry = {
    id: makeId('je'), number: `OPEN-${nextPeriodId}`, fiscalPeriodId: nextPeriodId,
    date: next.startDate, description: `سند افتتاحیه سال مالی ${next.title}`,
    status: 'draft', source: 'opening', sourceDocumentId: openingKey,
    lines, createdAt: timestamp, updatedAt: timestamp,
  };
  return upsertJournalEntry(data, entry);
}

/** بستن نهایی سال فقط پس از قطعی‌شدن اختتامیه و افتتاحیه انجام می‌شود. */
export function finalizeFiscalYearClose(data: AccountingData, previousPeriodId: string, nextPeriodId: string): AccountingData {
  const previous = data.fiscalPeriods.find((period) => period.id === previousPeriodId);
  if (!previous) throw new Error('سال مالی مبدأ پیدا نشد.');
  if (previous.status === 'closed') throw new Error('این سال مالی قبلاً بسته شده است.');
  const closing = data.journalEntries.find((entry) => entry.sourceDocumentId === `year-close:${previousPeriodId}`);
  const opening = data.journalEntries.find((entry) => entry.sourceDocumentId === `year-opening:${previousPeriodId}:${nextPeriodId}`);
  if (!closing || closing.status !== 'posted') throw new Error('سند اختتامیه هنوز قطعی نشده است.');
  if (!opening || opening.status !== 'posted') throw new Error('سند افتتاحیه هنوز قطعی نشده است.');
  const drafts = data.journalEntries.filter((entry) => entry.fiscalPeriodId === previousPeriodId && entry.status === 'draft');
  if (drafts.length) throw new Error('در سال مالی مبدأ هنوز سند پیش‌نویس وجود دارد.');
  return {
    ...data,
    fiscalPeriods: data.fiscalPeriods.map((period) => period.id === previousPeriodId
      ? { ...period, status: 'closed', closedAt: now() } : period),
  };
}
