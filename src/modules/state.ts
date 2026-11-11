/**
 * State مرکزی برنامه — single source of truth
 */

import type {
  AppState,
  Product,
  AppSettings,
  Session,
  AuditEntry,
  UndoItem,
  CountStats,
  StorageBackend,
  RecentScan,
  InventoryDocument,
} from '@/types';
import {
  loadAppState,
  persistAppState,
  loadSettings,
  saveSettings,
  loadSession,
  saveSession,
  loadAuditLog,
  saveAuditLog,
  loadRecentScans,
  saveRecentScans,
  getOperatorName,
  DEFAULT_SETTINGS,
} from './storage';
import { qtyEqual } from '@/utils/helpers';
import { migrateProductsStock } from './warehouse-stock';
import { generateId, normalizeDigits } from '@/utils/helpers';

// ——— State ———
export let products: Product[] = [];
export let settings: AppSettings = { ...DEFAULT_SETTINGS };
export let session: Session | null = null;
export let auditLog: AuditEntry[] = [];
export let recentScans: RecentScan[] = [];
export let inventoryDocs: InventoryDocument[] = [];
export let undoStack: UndoItem[] = [];
export let storageBackend: StorageBackend = 'pending';

const UNDO_MAX = 50;
const AUDIT_MAX = 500;

// Index برای جستجوی سریع بارکد
let codeIndex: Record<string, number> = {};
let statsCache: CountStats | null = null;

// ——— Index ———
export function rebuildIndex(): void {
  codeIndex = {};
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (p.code) {
      const c = String(p.code).trim();
      const normalized = normalizeDigits(c);
      codeIndex[c] = i;
      codeIndex[c.toLowerCase()] = i;
      codeIndex[normalized] = i;
      codeIndex[normalized.toLowerCase()] = i;
    }
    if (p.sku) {
      const s = String(p.sku).trim();
      const normalizedSku = normalizeDigits(s);
      codeIndex[s] = i;
      codeIndex[s.toLowerCase()] = i;
      codeIndex[normalizedSku] = i;
      codeIndex[normalizedSku.toLowerCase()] = i;
    }
  }
  statsCache = null;
}

export function findProductByCode(code: string | null | undefined): Product | null {
  if (!code) return null;
  const t = normalizeDigits(code);
  let i = codeIndex[t];
  if (i === undefined) i = codeIndex[t.toLowerCase()];
  if (i === undefined) return null;
  return products[i] || null;
}

export function invalidateStats(): void {
  statsCache = null;
}

export function getCountStats(): CountStats {
  if (statsCache) return statsCache;

  let counted = 0;
  let counted2 = 0;
  let diffs = 0;
  let withPhoto = 0;
  const phase2 = isDoubleCount() && countPhase() === 2;

  for (const p of products) {
    if (p.countedQty !== null && p.countedQty !== undefined) counted++;
    if (p.countedQty2 != null && p.countedQty2 !== undefined) counted2++;
    if (p.countedQty !== null && !qtyEqual(p.countedQty, p.systemQty)) diffs++;
    if (p.photo) withPhoto++;
  }

  statsCache = { total: products.length, counted, counted2, diffs, withPhoto, phase2 };
  return statsCache;
}

// ——— Double count helpers ———
export function isDoubleCount(): boolean {
  return !!settings.doubleCount;
}

export function countPhase(): 1 | 2 {
  // می‌تواند از settings یا session گرفته شود؛ فعلاً ساده
  return settings.countPhase === 2 ? 2 : 1;
}

export function setCountPhase(phase: 1 | 2): void {
  settings.countPhase = phase;
  saveSettings(settings);
  invalidateStats();
}

// ——— Warehouse filter ———
export function filterByActiveWarehouse(list: Product[]): Product[] {
  // تک‌انباره: همه کالاها
  return list;
}

/** موجودی سیستم (مدل تک‌انباره) */
export function displaySystemQty(product: Product): number {
  const n = Number(product.systemQty) || 0;
  // جلوگیری از نمایش رقم‌های شناور زیاد
  return Math.round(n * 10000) / 10000;
}

// ——— Undo ———
export function pushUndo(item: UndoItem): void {
  undoStack.push(item);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

export function popUndo(): UndoItem | undefined {
  return undoStack.pop();
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

// ——— Audit ———
function stableAuditValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableAuditValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableAuditValue(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Checksum زنجیره‌ای برای کشف تغییرات تصادفی/خرابی داده؛ جایگزین امضای رمزنگاری‌شده سرور نیست. */
function auditChecksum(previousHash: string, entry: Omit<AuditEntry, 'integrityHash' | 'previousHash'>): string {
  const payload = `${previousHash}|${stableAuditValue({ id: entry.id, action: entry.action, ts: entry.ts, detail: entry.detail || {}, operator: entry.operator || '' })}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function verifyAuditIntegrity(): { valid: boolean; checked: number; legacy: number; brokenAt: number | null } {
  let previousHash: string | null = null;
  let checked = 0;
  let legacy = 0;
  for (let i = 0; i < auditLog.length; i++) {
    const entry = auditLog[i];
    if (!entry.integrityHash) { legacy++; continue; }
    // نخستین رکورد زنجیره ممکن است پیش از آن به علت محدودیت نگهداری حذف شده باشد.
    if (previousHash === null) previousHash = entry.previousHash || 'legacy';
    if ((entry.previousHash || 'legacy') !== previousHash) return { valid: false, checked, legacy, brokenAt: i };
    const expected = auditChecksum(previousHash, entry);
    if (expected !== entry.integrityHash) return { valid: false, checked, legacy, brokenAt: i };
    previousHash = entry.integrityHash;
    checked++;
  }
  return { valid: true, checked, legacy, brokenAt: null };
}

export function logAudit(action: string, detail: Record<string, unknown> = {}): void {
  const base = {
    id: generateId('a'),
    action,
    ts: new Date().toISOString(),
    detail,
    operator: getOperatorName(),
  };
  const previousHash = auditLog.length ? (auditLog[auditLog.length - 1].integrityHash || 'legacy') : 'legacy';
  auditLog.push({ ...base, previousHash, integrityHash: auditChecksum(previousHash, base) });
  if (auditLog.length > AUDIT_MAX) auditLog = auditLog.slice(-AUDIT_MAX);
  saveAuditLog(auditLog, AUDIT_MAX);
}

// ——— Persist ———
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveQueue: Promise<void> = Promise.resolve();

/** ذخیره‌های پشت‌سرهم را به صف می‌برد تا عملیات قدیمی‌تر دیرتر تمام نشود و
 * نسخه تازه‌تر را بازنویسی نکند. */
export function flushSave(): Promise<void> {
  const snapshot: AppState = {
    products: products.map((product) => ({ ...product })),
    settings: { ...settings, warehouses: [...settings.warehouses] },
    session: session ? { ...session } : null,
    auditLog: auditLog.map((entry) => ({ ...entry, detail: { ...entry.detail } })),
    recentScans: recentScans.map((scan) => ({ ...scan })),
    inventoryDocs: inventoryDocs.map((doc) => ({ ...doc, lines: doc.lines.map((line) => ({ ...line })) })),
  };

  saveQueue = saveQueue
    .catch((error) => { console.warn('previous save failed', error); })
    .then(async () => {
      storageBackend = await persistAppState(snapshot);
      if (storageBackend === 'pending') console.error('ذخیره اطلاعات انجام نشد؛ فضای ذخیره‌سازی را بررسی کنید.');
    });
  return saveQueue;
}

export function save(immediate = false): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (immediate) {
    void flushSave();
    return;
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 400);
}

export function saveSettingsNow(): void {
  saveSettings(settings);
  save(true);
}

/** بازیابی جلسه از فایل پشتیبان معتبر؛ وضعیت مرکزی و ذخیره‌سازی را همگام می‌کند. */
export function restoreSession(value: Session | null): void {
  session = value && typeof value === 'object' ? value : null;
  save(true);
}

// ——— Boot ———
export async function bootState(): Promise<string> {
  const { state, source } = await loadAppState();

  products = Array.isArray(state.products) ? state.products.filter((p) => p && typeof p === 'object') : [];
  try {
    migrateProductsStock(products);
  } catch (e) {
    console.warn('[boot] warehouse migration skipped', e);
  }
  settings = { ...DEFAULT_SETTINGS, ...(state.settings || loadSettings()) };
  settings.warehouses = ['انبار اصلی'];
  settings.currentWarehouse = 'انبار اصلی';
  session = state.session ?? loadSession();
  auditLog = state.auditLog || loadAuditLog();
  recentScans = state.recentScans || loadRecentScans();
  inventoryDocs = Array.isArray(state.inventoryDocs) ? state.inventoryDocs : [];

  rebuildIndex();
  storageBackend = source.startsWith('idb') ? 'idb' : source;

  return source;
}

// ——— Session helpers ———
export function startNewSession(silent = false): boolean {
  if (!silent && products.some((p) => p.countedQty !== null)) {
    if (!confirm('شمارش‌های فعلی پاک شود و جلسه جدید شروع شود؟')) return false;
    products.forEach((p) => {
      p.countedQty = null;
      p.countedQty2 = null;
    });
  }

  session = {
    id: generateId('s'),
    startedAt: new Date().toISOString(),
    closedAt: null,
    closedBy: null,
  };
  saveSession(session);
  recentScans = [];
  saveRecentScans(recentScans);
  undoStack = [];
  invalidateStats();
  save(true);

  if (!silent) {
    logAudit('session', {});
  }
  return true;
}

export function closeSession(): void {
  if (!session) return;
  session.closedAt = new Date().toISOString();
  session.closedBy = getOperatorName();
  saveSession(session);
  save(true);
  logAudit('close_session', { sessionId: session.id });
}
