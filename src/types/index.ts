/** مدل داده اصلی کالا */
export interface Product {
  id: string;
  name: string;
  code?: string;
  sku?: string;
  unit?: string;
  /** تعداد واحد پایه در هر واحد بسته‌بندی (مثلاً ۱۲ اگر هر کارتن ۱۲ عدد باشد) */
  unitFactor?: number;
  /** نام واحد بسته‌بندی (مثلاً کارتن) */
  packUnit?: string;
  systemQty: number;
  countedQty: number | null;
  countedQty2?: number | null;
  price?: number; /** قیمت فروش (پس از تخفیف) — در فاکتور فروش استفاده می‌شود */
  consumerPrice?: number; /** قیمت مصرف‌کننده / روی برچسب */
  sellDiscountPercent?: number; /** درصد تخفیف نسبت به قیمت مصرف‌کننده (مثلاً ۵) */
  purchasePrice?: number; /** قیمت خرید — مبنای بهای تمام‌شده / فاکتور خرید */
  /** بهای استاندارد واحد (ریال) — انحراف خرید و ارزش‌گذاری استاندارد؛ اختیاری */
  standardCostRial?: number;
  location?: string;
  /** انبار اصلی/نمایشی کالا (سازگاری؛ موجودی واقعی در stockByWarehouse) */
  warehouse?: string;
  /** موجودی عملیاتی به‌تفکیک انبار (کالا + انبار). systemQty = جمع این مقادیر */
  stockByWarehouse?: Record<string, number>;
  serial?: string;
  batch?: string;
  expiry?: string;
  note?: string;
  photo?: string;
  photoAt?: string;
  minQty?: number | null;
  maxQty?: number | null;
  createdAt?: string;
  countUpdatedAt?: string;
}

export interface AppSettings {
  continuousScan: boolean;
  autoNextScan: boolean;
  soundOnScan: boolean;
  vibrateOnScan: boolean;
  autoIncrement: boolean;
  blindCount: boolean;
  btScanner: boolean;
  doubleCount: boolean;
  role: 'admin' | 'viewer' | 'counter';
  warehouses: string[];
  currentWarehouse: string;
  theme?: 'light' | 'dark';
  countPhase?: 1 | 2;
  quickAutoConfirm?: boolean;
  /** مشخصات فروشگاه / شرکت برای فاکتور و چاپ */
  businessName?: string;
  businessSlogan?: string;
  businessPhone?: string;
  businessAddress?: string;
  businessNationalId?: string;
  businessEconomicCode?: string;
  businessPostalCode?: string;
  /** لوگو به صورت data URL (مثلاً image/png;base64,...) */
  businessLogoDataUrl?: string;
  /** تنظیمات پیامک (اختیاری؛ پیش‌فرض خاموش) */
  smsEnabled?: boolean;
  /** device | kavenegar | faraz | melipayamak | custom */
  smsProvider?: 'device' | 'kavenegar' | 'faraz' | 'melipayamak' | 'custom';
  smsApiKey?: string;
  /** نام کاربری (ملی‌پیامک و برخی سرویس‌ها) */
  smsUsername?: string;
  smsSender?: string;
  smsCustomUrl?: string;
  /** آدرس API زمان‌بندی سمت سرور؛ باید پیام را برای زمان آینده صف‌بندی کند */
  smsScheduleUrl?: string;
  smsScheduleApiToken?: string;
  /** الگوی پیام پیش‌فرض؛ از {name} {amount} {date} {number} {balance} پشتیبانی می‌شود */
  smsDefaultTemplate?: string;
  /** هشدار سررسید هنگام ورود؛ پیش‌فرض خاموش */
  dueReminderEnabled?: boolean;
  /** اعلان بومی اندروید برای سررسیدها */
  dueNotificationEnabled?: boolean;
  dueNotificationTime?: string;
}

export interface Session {
  id: string;
  startedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  joinedAt?: string;
}

export interface AuditEntry {
  id?: string;
  action: string;
  ts: string;
  detail?: Record<string, unknown>;
  operator?: string;
  /** FNV checksum chain; detects accidental edits, not a cryptographic security boundary. */
  integrityHash?: string;
  previousHash?: string;
}

export interface UndoItem {
  type: 'count' | 'count2' | 'bulk';
  id?: string;
  prev: number | null;
  next?: number | null;
  name?: string;
  ts: number;
  items?: Array<{ id: string; prev: number | null }>;
  phase?: number;
}

export interface CountStats {
  total: number;
  counted: number;
  counted2: number;
  diffs: number;
  withPhoto: number;
  phase2: boolean;
}

export interface LicenseInfo {
  org: string;
  exp: string;
  plan: string;
  device?: string | null;
  demo?: boolean;
  activatedAt?: string;
}

export interface RecentScan {
  id: string;
  name: string;
  qty: number | null;
}

export type InventoryDocumentKind = 'receipt' | 'issue' | 'adjustment' | 'transfer';
export interface InventoryDocumentLine { productId: string; productName: string; code: string; qty: number; beforeQty: number; afterQty: number; fromWarehouse?: string; toWarehouse?: string; }
export interface InventoryDocument { id: string; number: string; kind: InventoryDocumentKind; status: 'draft' | 'approved'; createdAt: string; approvedAt?: string; operator: string; warehouse: string; destinationWarehouse?: string; reason: string; lines: InventoryDocumentLine[]; }

export interface AppState {
  products: Product[];
  inventoryDocs?: InventoryDocument[];
  settings: AppSettings;
  session: Session | null;
  auditLog: AuditEntry[];
  recentScans: RecentScan[];
}

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export type StorageBackend =
  | 'idb'
  | 'local+idb'
  | 'localStorage'
  | 'pending'
  | 'idb-autobackup'
  | string;
