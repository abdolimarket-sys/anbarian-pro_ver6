/**
 * لایه ذخیره‌سازی — IndexedDB (اصلی) + localStorage (پشتیبان/متا)
 */

import type { AppState, Product, AppSettings, Session, AuditEntry, StorageBackend, RecentScan } from '@/types';

const DB_NAME = 'anbarin_db';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ——— تنظیمات و وضعیت برنامه ———

const DEFAULT_SETTINGS: AppSettings = {
  continuousScan: true,
  autoNextScan: true,
  soundOnScan: true,
  vibrateOnScan: true,
  autoIncrement: true,
  blindCount: false,
  btScanner: true,
  doubleCount: false,
  role: 'admin',
  warehouses: ['انبار اصلی'],
  currentWarehouse: 'انبار اصلی',
  businessName: '',
  businessSlogan: '',
  businessPhone: '',
  businessAddress: '',
  businessNationalId: '',
  businessEconomicCode: '',
  businessPostalCode: '',
  businessLogoDataUrl: '',
  smsEnabled: false,
  smsProvider: 'device',
  smsApiKey: '',
  smsUsername: '',
  smsSender: '',
  smsCustomUrl: '',
  smsDefaultTemplate: 'سلام {name}، مانده حساب شما {balance} ریال است. {business}',
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('anbar_settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem('anbar_settings', JSON.stringify(settings));
}

export function loadSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem('anbar_session') || 'null');
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  if (session) localStorage.setItem('anbar_session', JSON.stringify(session));
  else localStorage.removeItem('anbar_session');
}

export function loadAuditLog(): AuditEntry[] {
  try {
    return JSON.parse(localStorage.getItem('anbar_audit') || '[]');
  } catch {
    return [];
  }
}

export function saveAuditLog(log: AuditEntry[], max = 500): void {
  try {
    localStorage.setItem('anbar_audit', JSON.stringify(log.slice(-max)));
  } catch {
    // ignore quota
  }
}

export function loadRecentScans(): RecentScan[] {
  try {
    const raw = JSON.parse(localStorage.getItem('anbar_recent') || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveRecentScans(scans: RecentScan[]): void {
  try {
    localStorage.setItem('anbar_recent', JSON.stringify(scans.slice(0, 50)));
  } catch {
    // ignore
  }
}

export function getOperatorName(): string {
  return (localStorage.getItem('anbar_operator') || '').trim() || 'ناشناس';
}

export function setOperatorName(name: string): void {
  localStorage.setItem('anbar_operator', name.trim());
}

/** تشخیص حداقلی snapshot سالم؛ از مهاجرت داده‌های قدیمی جلوگیری نمی‌کند. */
function isStateSnapshot(value: unknown): value is {
  products: Product[];
  settings?: AppSettings;
  session?: Session | null;
  auditLog?: AuditEntry[];
  recentScans?: RecentScan[];
  inventoryDocs?: AppState['inventoryDocs'];
  savedAt?: string;
  version?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.products)) return false;
  // رکوردهای کالا باید شیء باشند؛ فیلدهای قدیمی/اختیاری دست‌نخورده می‌مانند.
  if (!candidate.products.every((item) => !!item && typeof item === 'object' && !Array.isArray(item))) return false;
  if (candidate.auditLog !== undefined && !Array.isArray(candidate.auditLog)) return false;
  if (candidate.recentScans !== undefined && !Array.isArray(candidate.recentScans)) return false;
  if (candidate.inventoryDocs !== undefined && !Array.isArray(candidate.inventoryDocs)) return false;
  if (candidate.settings !== undefined && (!candidate.settings || typeof candidate.settings !== 'object' || Array.isArray(candidate.settings))) return false;
  return true;
}

function snapshotTime(value: { savedAt?: string }): number {
  const parsed = value.savedAt ? Date.parse(value.savedAt) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function toPartialState(value: {
  products: Product[];
  settings?: AppSettings;
  session?: Session | null;
  auditLog?: AuditEntry[];
  recentScans?: RecentScan[];
  inventoryDocs?: AppState['inventoryDocs'];
}): Partial<AppState> {
  return {
    products: value.products,
    settings: value.settings,
    session: value.session,
    auditLog: value.auditLog,
    recentScans: value.recentScans,
    inventoryDocs: value.inventoryDocs,
  };
}

/** ذخیره کامل وضعیت؛ پشتیبان قبلی تا زمان موفقیت ذخیره اصلی حفظ می‌شود. */
export async function persistAppState(state: AppState): Promise<StorageBackend> {
  const full = {
    ...state,
    // هر snapshot زمان مستقل دارد تا بازیابی بتواند نسخه تازه‌تر را تشخیص دهد.
    savedAt: new Date().toISOString(),
    version: 3,
  };

  try {
    await idbPut('app_state', full);

    // نگهداری آخرین پشتیبان سالم پیش از جایگزینی آن با نسخه جدید.
    try {
      const previous = await idbGet<unknown>('autobackup');
      if (isStateSnapshot(previous)) await idbPut('autobackup_prev', previous);
      // نگهداری پنج نسخه زمان‌دار مستقل برای بازیابی از خطاهای چند ذخیره اخیر.
      const historyRaw = await idbGet<unknown>('autobackup_history');
      const history = Array.isArray(historyRaw) ? historyRaw.filter(isStateSnapshot) : [];
      if (isStateSnapshot(previous) && snapshotTime(previous) !== snapshotTime(full)) history.push(previous);
      const unique = new Map<number, typeof full>();
      for (const item of history) unique.set(snapshotTime(item), item as typeof full);
      const retained = [...unique.values()].sort((a, b) => snapshotTime(a) - snapshotTime(b)).slice(-5);
      await idbPut('autobackup_history', retained);
      await idbPut('autobackup', full);
    } catch (backupError) {
      // ذخیره اصلی موفق است؛ خطای پشتیبان نباید موفقیت ذخیره اصلی را پنهان کند.
      console.warn('autobackup update failed', backupError);
    }

    try {
      localStorage.setItem('anbar_products_meta', JSON.stringify({
        count: state.products.length,
        at: full.savedAt,
        version: full.version,
        note: 'full data in IndexedDB',
      }));
    } catch (metaError) {
      console.warn('storage metadata update failed', metaError);
    }
    return 'idb';
  } catch (err) {
    console.error('idb persist fail', err);
    // fallback قدیمی برای سازگاری؛ ممکن است به علت محدودیت فضا شکست بخورد.
    try {
      localStorage.setItem('anbar_products', JSON.stringify(state.products));
      return 'local+idb';
    } catch (fallbackError) {
      console.error('localStorage fallback failed', fallbackError);
      return 'pending';
    }
  }
}

/** بارگذاری تازه‌ترین snapshot معتبر از میان ذخیره اصلی و نسخه‌های پشتیبان. */
export async function loadAppState(): Promise<{ state: Partial<AppState>; source: string }> {
  const candidates: Array<{ value: ReturnType<typeof toPartialState>; savedAt: number; source: string }> = [];

  const addCandidate = (raw: unknown, source: string) => {
    if (!isStateSnapshot(raw)) return;
    candidates.push({ value: toPartialState(raw), savedAt: snapshotTime(raw), source });
  };

  // خواندن مستقل هر نسخه تا خرابی یک کلید مانع بازیابی نسخه دیگر نشود.
  try { addCandidate(await idbGet<unknown>('app_state'), 'idb'); }
  catch (e) { console.warn('primary state read failed', e); }
  try { addCandidate(await idbGet<unknown>('autobackup'), 'idb-autobackup'); }
  catch (e) { console.warn('autobackup read failed', e); }
  try { addCandidate(await idbGet<unknown>('autobackup_prev'), 'idb-autobackup-previous'); }
  catch (e) { console.warn('previous autobackup read failed', e); }
  try {
    const history = await idbGet<unknown>('autobackup_history');
    if (Array.isArray(history)) history.forEach((item, index) => addCandidate(item, `idb-autobackup-history-${index + 1}`));
  } catch (e) { console.warn('backup history read failed', e); }

  // مهاجرت از نسخه‌های قدیمی که فقط فهرست کالا را در localStorage داشتند.
  try {
    const raw = localStorage.getItem('anbar_products');
    if (raw) {
      const products: unknown = JSON.parse(raw);
      if (Array.isArray(products) && products.every((item) => !!item && typeof item === 'object' && !Array.isArray(item))) {
        addCandidate({
          products,
          settings: loadSettings(),
          session: loadSession(),
          auditLog: loadAuditLog(),
          recentScans: loadRecentScans(),
        }, 'localStorage-migrated');
      }
    }
  } catch (e) {
    console.warn('legacy localStorage recovery failed', e);
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.savedAt - a.savedAt);
    const selected = candidates[0];
    // فقط وقتی نسخه اصلی انتخاب شده باشد نیازی به مهاجرت نیست؛ در غیر این صورت
    // snapshot بازیابی‌شده در ذخیره بعدی به‌عنوان نسخه اصلی ثبت خواهد شد.
    return { state: selected.value, source: selected.source };
  }

  return {
    state: {
      products: [],
      settings: loadSettings(),
      session: loadSession(),
      auditLog: loadAuditLog(),
      recentScans: loadRecentScans(),
    },
    source: 'empty',
  };
}

export { DEFAULT_SETTINGS };
