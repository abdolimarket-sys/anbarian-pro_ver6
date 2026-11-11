/**
 * همگام‌سازی تیمی از طریق فایل JSON
 * - صدور بسته شمارش این دستگاه
 * - دریافت و ادغام با حالت‌های sum / max / incoming / local
 * - کد جلسه مشترک
 */

import type { Product } from '@/types';
import {
  products,
  settings,
  session,
  logAudit,
  save,
  rebuildIndex,
  invalidateStats,
  startNewSession,
} from './state';
import { toast } from './ui';
import { downloadFile, dateStr, generateId } from '@/utils/helpers';
import { getOperatorName, saveSession } from './storage';
import { canCount } from './count';

export type MergeMode = 'sum' | 'max' | 'incoming' | 'local';

export interface TeamCountItem {
  code: string;
  sku: string;
  name: string;
  countedQty: number | null;
  countedQty2?: number | null;
  systemQty: number;
  location?: string;
  warehouse?: string;
  note?: string;
  price?: number;
  updatedAt?: string | null;
}

export interface TeamSyncPack {
  type: 'anbar-team-sync' | 'anbar-partial';
  version: number;
  sessionId: string;
  warehouse: string;
  operator: string;
  role?: string;
  deviceId?: string;
  exportedAt: string;
  countTotal: number;
  counts: TeamCountItem[];
}

export interface MergeReport {
  at: string;
  mode: MergeMode;
  operator: string;
  sessionId: string;
  matched: number;
  added: number;
  merged: number;
  skipped: number;
  conflictCount?: number;
}

export interface TeamSyncConflictSummary {
  duplicateIncoming: string[];
  ambiguousLocal: string[];
  duplicateTargets: string[];
  metadataMismatch: string[];
}

/** Preflight conflict detection; it never mutates application state. */
export function analyzeTeamSyncConflicts(counts: TeamCountItem[]): TeamSyncConflictSummary {
  const normalized = (value: unknown) => String(value || '').trim().toLowerCase();
  const identity = (item: { code?: string; sku?: string; name?: string }) => {
    if (normalized(item.code)) return 'code:' + normalized(item.code);
    if (normalized(item.sku)) return 'sku:' + normalized(item.sku);
    return 'name:' + normalized(item.name);
  };
  const duplicateIncoming: string[] = [];
  const incomingSeen = new Set<string>();
  for (const item of counts) {
    const key = identity(item);
    if (incomingSeen.has(key)) duplicateIncoming.push(key);
    incomingSeen.add(key);
  }

  const byCode = new Map<string, Product[]>();
  const bySku = new Map<string, Product[]>();
  const byName = new Map<string, Product[]>();
  const add = (map: Map<string, Product[]>, key: string, product: Product) => {
    if (!key) return;
    const group = map.get(key) || [];
    group.push(product);
    map.set(key, group);
  };
  for (const product of products) {
    add(byCode, normalized(product.code), product);
    add(bySku, normalized(product.sku), product);
    add(byName, normalized(product.name), product);
  }

  const ambiguousLocal: string[] = [];
  const metadataMismatch: string[] = [];
  const duplicateTargets: string[] = [];
  const targetedProducts = new Set<string>();
  for (const item of counts) {
    const code = normalized(item.code);
    const sku = normalized(item.sku);
    const name = normalized(item.name);
    const matches = code ? (byCode.get(code) || []) : sku ? (bySku.get(sku) || []) : (byName.get(name) || []);
    const key = identity(item);
    if (matches.length > 1) {
      ambiguousLocal.push(key);
      continue;
    }
    const local = matches[0];
    if (!local) continue;
    if (targetedProducts.has(local.id)) duplicateTargets.push(key);
    targetedProducts.add(local.id);
    const localWarehouse = normalized(local.warehouse || settings.currentWarehouse);
    const incomingWarehouse = normalized(item.warehouse);
    if (Number(local.systemQty) !== Number(item.systemQty) ||
        (incomingWarehouse && localWarehouse && incomingWarehouse !== localWarehouse)) {
      metadataMismatch.push(key);
    }
  }
  return {
    duplicateIncoming: [...new Set(duplicateIncoming)],
    ambiguousLocal: [...new Set(ambiguousLocal)],
    duplicateTargets: [...new Set(duplicateTargets)],
    metadataMismatch: [...new Set(metadataMismatch)],
  };
}

let lastMergeReport: MergeReport | null = null;

function ensureSession(): void {
  if (!session) {
    startNewSession(true);
  }
}

export function getTeamSessionCode(): string {
  ensureSession();
  return session?.id || '';
}

export function copyTeamSessionCode(): void {
  const code = getTeamSessionCode();
  const el = document.getElementById('teamSessionCode') as HTMLInputElement | null;
  if (el) el.value = code;

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(code).then(
      () => toast('کد جلسه کپی شد', 'success'),
      () => prompt('کد جلسه:', code)
    );
  } else {
    prompt('کد جلسه:', code);
  }
}

export function joinTeamSession(codeRaw?: string): boolean {
  const inp = document.getElementById('joinSessionInput') as HTMLInputElement | null;
  const code = (codeRaw ?? inp?.value ?? '').trim();
  if (!code) {
    toast('کد جلسه را وارد کنید', 'error');
    return false;
  }

  if (
    products.some((p) => p.countedQty !== null) &&
    !confirm('با پیوستن به جلسه دیگر، شمارش‌های فعلی روی همین دستگاه می‌ماند ولی کد جلسه عوض می‌شود. ادامه؟')
  ) {
    return false;
  }

  ensureSession();
  if (session) {
    session.id = code;
    session.joinedAt = new Date().toISOString();
    saveSession(session);
  }
  logAudit('session_join', { sessionId: code });
  toast('به جلسه ' + code + ' پیوستید', 'success');
  return true;
}

export function exportTeamSyncPack(): void {
  if (!canCount() && settings.role !== 'admin') {
    toast('دسترسی ندارید', 'error');
    return;
  }
  ensureSession();
  const op = getOperatorName();
  const counted = products.filter(
    (p) => p.countedQty !== null || (p.countedQty2 != null && p.countedQty2 !== undefined)
  );
  if (!counted.length) {
    toast('شمارشی برای ارسال نیست', 'error');
    return;
  }

  const payload: TeamSyncPack = {
    type: 'anbar-team-sync',
    version: 3,
    sessionId: session?.id || '',
    warehouse: settings.currentWarehouse || '',
    operator: op,
    role: settings.role,
    exportedAt: new Date().toISOString(),
    countTotal: counted.length,
    counts: counted.map((p) => ({
      code: p.code || '',
      sku: p.sku || '',
      name: p.name,
      countedQty: p.countedQty,
      countedQty2: p.countedQty2,
      systemQty: p.systemQty,
      location: p.location || '',
      warehouse: p.warehouse || settings.currentWarehouse || '',
      note: p.note || '',
      price: p.price || 0,
      updatedAt: p.countUpdatedAt || null,
    })),
  };

  const fname = `team-sync-${session?.id || 'nosession'}-${op}-${dateStr()}.json`;
  downloadFile(JSON.stringify(payload, null, 2), fname, 'application/json');
  logAudit('team_export', {
    count: counted.length,
    sessionId: session?.id,
    warehouse: settings.currentWarehouse,
  });
  toast(`${counted.length} شمارش صادر شد`, 'success');
}

/** خروجی سبک فقط برای ادغام شمارش (سازگار با partial قدیمی) */
export function exportPartialCount(): void {
  ensureSession();
  const op = getOperatorName();
  const counted = products.filter((p) => p.countedQty !== null);
  if (!counted.length) {
    toast('شمارشی نیست', 'error');
    return;
  }
  const payload = {
    type: 'anbar-partial' as const,
    version: 2,
    sessionId: session?.id || '',
    operator: op,
    exportedAt: new Date().toISOString(),
    counts: counted.map((p) => ({
      code: p.code || '',
      sku: p.sku || '',
      name: p.name,
      countedQty: p.countedQty,
      countedQty2: p.countedQty2,
      systemQty: p.systemQty,
      location: p.location || '',
      warehouse: p.warehouse || '',
    })),
  };
  downloadFile(
    JSON.stringify(payload, null, 2),
    `anbar-partial-${op}-${dateStr()}.json`,
    'application/json'
  );
  logAudit('partial_export', { count: counted.length });
  toast('فایل شمارش جزئی ذخیره شد', 'success');
}

function pickValue(
  localV: number | null | undefined,
  incV: number | null | undefined,
  mode: MergeMode
): number | null {
  if (incV === null || incV === undefined) return localV ?? null;
  if (localV === null || localV === undefined) return incV;
  if (localV === incV) return localV;
  if (mode === 'incoming') return incV;
  if (mode === 'local') return localV;
  if (mode === 'max') return Math.max(Number(localV) || 0, Number(incV) || 0);
  // sum
  return (Number(localV) || 0) + (Number(incV) || 0);
}

export async function importTeamSyncPack(
  file: File,
  mode?: MergeMode
): Promise<MergeReport | null> {
  const requestedMode = mode ||
    ((document.getElementById('teamMergeMode') as HTMLSelectElement | null)?.value as MergeMode) ||
    'sum';
  const mergeMode: MergeMode = ['sum', 'max', 'incoming', 'local'].includes(requestedMode)
    ? requestedMode
    : 'sum';

  try {
    const data = JSON.parse(await file.text()) as TeamSyncPack;
    const validCount = (item: unknown): item is TeamCountItem => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const c = item as Record<string, unknown>;
      const nullableNumber = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
      return typeof c.name === 'string' && typeof c.code === 'string' && typeof c.sku === 'string' &&
        typeof c.systemQty === 'number' && Number.isFinite(c.systemQty) &&
        nullableNumber(c.countedQty) && nullableNumber(c.countedQty2) && nullableNumber(c.price) &&
        ['location', 'warehouse', 'note', 'updatedAt'].every((key) => c[key] === undefined || c[key] === null || typeof c[key] === 'string');
    };
    if (
      !data ||
      (data.type !== 'anbar-team-sync' && data.type !== 'anbar-partial') ||
      !Array.isArray(data.counts) ||
      !data.counts.every(validCount)
    ) {
      toast('فایل همگام‌سازی معتبر نیست یا اطلاعات شمارش ناقص است', 'error');
      return null;
    }

    if (data.counts.length > 50000 || (data.countTotal !== undefined && data.countTotal !== data.counts.length)) {
      toast('تعداد اقلام بسته با اطلاعات سربرگ همخوانی ندارد یا بیش از حد مجاز است', 'error');
      return null;
    }
    const conflicts = analyzeTeamSyncConflicts(data.counts);
    if (conflicts.duplicateIncoming.length) {
      toast(`بسته ورودی دارای ${conflicts.duplicateIncoming.length} شناسه تکراری است؛ ادغام متوقف شد`, 'error');
      return null;
    }
    if (conflicts.ambiguousLocal.length) {
      toast(`در دستگاه فعلی ${conflicts.ambiguousLocal.length} شناسه به چند کالا اشاره می‌کند؛ ابتدا کالاهای تکراری را بررسی کنید`, 'error');
      return null;
    }
    if (conflicts.duplicateTargets.length) {
      toast(`چند ردیف فایل به یک کالای محلی اشاره می‌کنند (${conflicts.duplicateTargets.length})؛ ادغام متوقف شد`, 'error');
      return null;
    }
    if (conflicts.metadataMismatch.length) {
      const examples = conflicts.metadataMismatch.slice(0, 5).join('، ');
      const more = conflicts.metadataMismatch.length > 5 ? ' و موارد دیگر' : '';
      if (!confirm(`هشدار تعارض اطلاعات پایه: ${conflicts.metadataMismatch.length} کالا دارای اختلاف موجودی سیستمی یا انبار هستند (${examples}${more}). روش ادغام انتخاب‌شده «${mergeMode}» فقط روی مقدار شمارش اثر می‌گذارد و اختلاف اطلاعات پایه را حل نمی‌کند. آیا با ثبت این تعارض‌ها و ادامه ادغام موافقید؟`)) return null;
    }

    if (
      session?.id &&
      data.sessionId &&
      data.sessionId !== session.id &&
      !confirm(
        `کد جلسه فایل (${data.sessionId}) با جلسه فعلی (${session.id}) فرق دارد. باز هم ادغام شود؟`
      )
    ) {
      return null;
    }

    const byCode: Record<string, number> = {};
    const bySku: Record<string, number> = {};
    const byName: Record<string, number> = {};
    products.forEach((p, i) => {
      if (p.code) byCode[String(p.code).trim().toLowerCase()] = i;
      if (p.sku) bySku[String(p.sku).trim().toLowerCase()] = i;
      if (p.name) byName[p.name.trim()] = i;
    });

    let matched = 0;
    let added = 0;
    let merged = 0;
    let skipped = 0;

    data.counts.forEach((c) => {
      let idx: number | undefined;
      const code = String(c.code || '')
        .trim()
        .toLowerCase();
      const sku = String(c.sku || '')
        .trim()
        .toLowerCase();
      if (code && byCode[code] !== undefined) idx = byCode[code];
      else if (sku && bySku[sku] !== undefined) idx = bySku[sku];
      else if (c.name && byName[c.name.trim()] !== undefined) idx = byName[c.name.trim()];

      if (idx === undefined) {
        const np: Product = {
          id: generateId('t'),
          name: c.name || 'کالای ' + (c.code || ''),
          code: c.code || '',
          sku: c.sku || '',
          unit: 'عدد',
          systemQty: c.systemQty || 0,
          price: c.price || 0,
          location: c.location || '',
          warehouse: c.warehouse || settings.currentWarehouse || 'انبار اصلی',
          note: ((c.note || '') + ' [تیم:' + (data.operator || '') + ']').trim(),
          countedQty: c.countedQty,
          countedQty2: c.countedQty2,
          createdAt: new Date().toISOString(),
        };
        products.push(np);
        const ni = products.length - 1;
        if (code) byCode[code] = ni;
        if (sku) bySku[sku] = ni;
        if (c.name) byName[c.name.trim()] = ni;
        added++;
        return;
      }

      const p = products[idx];
      const prev1 = p.countedQty;
      const prev2 = p.countedQty2;
      const next1 = pickValue(p.countedQty, c.countedQty, mergeMode);
      const next2 = pickValue(p.countedQty2, c.countedQty2, mergeMode);

      if (prev1 === next1 && prev2 === next2) {
        matched++;
        return;
      }

      p.countedQty = next1;
      if (next2 !== undefined) p.countedQty2 = next2;
      if (c.location && !p.location) p.location = c.location;
      p.countUpdatedAt = new Date().toISOString();
      merged++;
    });

    rebuildIndex();
    save(true);
    invalidateStats();

    const report: MergeReport = {
      at: new Date().toISOString(),
      mode: mergeMode,
      operator: data.operator || '',
      sessionId: data.sessionId || '',
      matched,
      added,
      merged,
      skipped,
      conflictCount: conflicts.metadataMismatch.length,
    };
    lastMergeReport = report;
    try {
      localStorage.setItem('anbar_last_team_merge', JSON.stringify(report));
    } catch {
      // ignore
    }

    logAudit('team_import', {
      operator: data.operator,
      matched,
      added,
      merged,
      mode: mergeMode,
      sessionId: data.sessionId,
      conflictCount: conflicts.metadataMismatch.length,
      conflictExamples: conflicts.metadataMismatch.slice(0, 20),
    });
    toast(
      `ادغام (${mergeMode}): ${matched} بدون تغییر، ${merged} ادغام، ${added} جدید` + (conflicts.metadataMismatch.length ? ` · هشدار تعارض اطلاعات پایه: ${conflicts.metadataMismatch.length}` : ''),
      'success'
    );
    return report;
  } catch (err) {
    console.error(err);
    toast('خطا در خواندن فایل همگام‌سازی', 'error');
    return null;
  }
}

export function getLastMergeReport(): MergeReport | null {
  if (lastMergeReport) return lastMergeReport;
  try {
    return JSON.parse(localStorage.getItem('anbar_last_team_merge') || 'null');
  } catch {
    return null;
  }
}

export function exportTeamConflictReport(): void {
  const rep = getLastMergeReport();
  if (!rep) {
    toast('گزارش ادغامی نیست', 'info');
    return;
  }
  downloadFile(
    JSON.stringify(rep, null, 2),
    `team-merge-report-${dateStr()}.json`,
    'application/json'
  );
  toast('گزارش ادغام دانلود شد', 'success');
}

export function refreshTeamSyncUI(): void {
  const info = document.getElementById('teamSyncInfo');
  const codeEl = document.getElementById('teamSessionCode') as HTMLInputElement | null;
  const sid = session?.id || '—';
  if (codeEl) codeEl.value = sid === '—' ? '' : sid;
  if (info) {
    info.textContent =
      'کد جلسه: ' +
      sid +
      ' · اپراتور: ' +
      getOperatorName() +
      ' · انبار: ' +
      (settings.currentWarehouse || '—');
  }
}

// Optional Firebase Realtime Database transport. Local counting and JSON import/export
// continue to work without this configuration or an internet connection.
interface TeamOnlineConfig { url: string; token: string }
interface RemoteDevicePack extends TeamSyncPack { deviceId: string }
const ONLINE_CONFIG_KEY = 'anbar_team_online_config_v1';
const ONLINE_TOKEN_SESSION_KEY = 'anbar_team_online_token_session_v1';
const DEVICE_KEY = 'anbar_team_device_id_v1';
const SYNC_MODE_KEY = 'anbar_team_sync_mode_v1';
type TeamSyncMode = 'offline' | 'live' | 'hybrid';
let autoSyncTimer: number | null = null;
const REMOTE_CACHE_PREFIX = 'anbar_team_remote_cache_v1:';
let onlineSyncBusy = false;
let onlineSyncInitialized = false;
const SYNC_REQUEST_TIMEOUT_MS = 15000;
const MAX_REMOTE_PACK_ITEMS = 50000;

/**
 * The database URL persists, but the optional access token is session-scoped.
 * A legacy token in localStorage is migrated once and removed from persistent storage.
 * This reduces persistence exposure; it is not a substitute for server-side auth/rules.
 */
function onlineConfig(): TeamOnlineConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(ONLINE_CONFIG_KEY) || '{}');
    const url = String(parsed.url || '').trim().replace(/\/+$/, '');
    let token = '';
    try { token = String(sessionStorage.getItem(ONLINE_TOKEN_SESSION_KEY) || '').trim(); } catch { /* session storage unavailable */ }
    const legacyToken = String(parsed.token || '').trim();
    if (!token && legacyToken) {
      token = legacyToken;
      try { sessionStorage.setItem(ONLINE_TOKEN_SESSION_KEY, token); } catch { /* keep in memory for this call */ }
      try { localStorage.setItem(ONLINE_CONFIG_KEY, JSON.stringify({ url })); } catch { /* migration is best effort */ }
    }
    return { url: isSafeDatabaseUrl(url) ? url : '', token };
  } catch { return { url: '', token: '' }; }
}

function isSafeDatabaseUrl(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash;
  } catch { return false; }
}

function validOptionalQuantity(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000000);
}

function isValidRemotePack(value: unknown, databaseKey: string, expectedSessionId: string): value is RemoteDevicePack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pack = value as Partial<RemoteDevicePack>;
  if (pack.type !== 'anbar-team-sync' || pack.version !== 4 ||
      typeof pack.sessionId !== 'string' || pack.sessionId !== expectedSessionId ||
      typeof pack.deviceId !== 'string' || !pack.deviceId || pack.deviceId !== databaseKey ||
      typeof pack.operator !== 'string' || pack.operator.length > 120 ||
      typeof pack.warehouse !== 'string' || pack.warehouse.length > 200 ||
      typeof pack.exportedAt !== 'string' || !Number.isFinite(Date.parse(pack.exportedAt)) ||
      !Array.isArray(pack.counts) || pack.counts.length > MAX_REMOTE_PACK_ITEMS ||
      pack.countTotal !== pack.counts.length) return false;

  const seen = new Set<string>();
  for (const raw of pack.counts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const item = raw as TeamCountItem;
    if (typeof item.name !== 'string' || item.name.length > 500 ||
        typeof item.code !== 'string' || item.code.length > 200 ||
        typeof item.sku !== 'string' || item.sku.length > 200 ||
        typeof item.systemQty !== 'number' || !Number.isFinite(item.systemQty) || item.systemQty < 0 ||
        !validOptionalQuantity(item.countedQty) || !validOptionalQuantity(item.countedQty2) ||
        (item.price !== undefined && (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0)) ||
        (item.location !== undefined && (typeof item.location !== 'string' || item.location.length > 300)) ||
        (item.warehouse !== undefined && (typeof item.warehouse !== 'string' || item.warehouse.length > 200)) ||
        (item.note !== undefined && (typeof item.note !== 'string' || item.note.length > 2000))) return false;
    const key = productKey(item);
    if (key === 'name:' || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

async function fetchWithSyncTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } finally {
    window.clearTimeout(timeout);
  }
}

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = generateId('device');
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* device id remains in memory only */ }
  }
  return id;
}

function firebaseUrl(path: string): string {
  const cfg = onlineConfig();
  const url = `${cfg.url}/${path.split('/').map(encodeURIComponent).join('/')}.json`;
  if (!cfg.token) return url;
  return `${url}?auth=${encodeURIComponent(cfg.token)}`;
}

function setOnlineStatus(message: string, isError = false): void {
  const el = document.getElementById('teamOnlineStatus');
  if (el) {
    el.textContent = message;
    el.style.color = isError ? 'var(--danger, #b42318)' : '';
  }
}

function currentTeamSyncMode(): TeamSyncMode {
  const raw = localStorage.getItem(SYNC_MODE_KEY);
  return raw === 'live' || raw === 'hybrid' ? raw : 'offline';
}

export function saveTeamSyncMode(): void {
  const el = document.getElementById('teamSyncMode') as HTMLSelectElement | null;
  const mode: TeamSyncMode = el?.value === 'live' || el?.value === 'hybrid' ? el.value : 'offline';
  try { localStorage.setItem(SYNC_MODE_KEY, mode); } catch { /* current selection still applies until reload */ }
  configureAutoSync();
  refreshTeamOnlineStatus();
  toast(mode === 'offline' ? 'حالت آفلاین انتخاب شد' : mode === 'live' ? 'همگام‌سازی زنده انتخاب شد' : 'حالت ترکیبی انتخاب شد', 'success');
}

export function saveTeamOnlineConfig(): void {
  const urlEl = document.getElementById('teamOnlineUrl') as HTMLInputElement | null;
  const tokenEl = document.getElementById('teamOnlineToken') as HTMLInputElement | null;
  const url = (urlEl?.value || '').trim().replace(/\/+$/, '');
  const token = (tokenEl?.value || '').trim();
  if (url.length > 2048 || token.length > 4096) {
    toast('طول نشانی یا کلید دسترسی بیش از حد مجاز است', 'error');
    return;
  }
  if (url && !isSafeDatabaseUrl(url)) {
    toast('نشانی پایگاه داده باید HTTPS معتبر و بدون نام کاربری، رمز، پارامتر یا fragment باشد', 'error');
    return;
  }
  try {
    localStorage.setItem(ONLINE_CONFIG_KEY, JSON.stringify({ url }));
    try {
      if (token) sessionStorage.setItem(ONLINE_TOKEN_SESSION_KEY, token);
      else sessionStorage.removeItem(ONLINE_TOKEN_SESSION_KEY);
    } catch {
      if (token) {
        toast('ذخیره موقت کلید در این نشست ممکن نشد؛ کلید ذخیره نشد', 'error');
        return;
      }
    }
    configureAutoSync();
    toast(url ? 'تنظیمات همگام‌سازی آنلاین ذخیره شد' : 'تنظیمات آنلاین پاک شد؛ برای کار آفلاین حالت آفلاین را انتخاب کنید', 'success');
    refreshTeamOnlineStatus();
  } catch {
    toast('ذخیره تنظیمات آنلاین در این دستگاه ممکن نشد', 'error');
  }
}

export function refreshTeamOnlineStatus(): void {
  const cfg = onlineConfig();
  const urlEl = document.getElementById('teamOnlineUrl') as HTMLInputElement | null;
  const tokenEl = document.getElementById('teamOnlineToken') as HTMLInputElement | null;
  if (urlEl && document.activeElement !== urlEl) urlEl.value = cfg.url;
  if (tokenEl && document.activeElement !== tokenEl) tokenEl.value = cfg.token;
  const mode = currentTeamSyncMode();
  const modeText = mode === 'offline' ? 'حالت انتخابی: آفلاین.' : mode === 'live' ? 'حالت انتخابی: آنلاین زنده.' : 'حالت انتخابی: ترکیبی.';
  if (urlEl && document.activeElement !== urlEl) { /* retain saved URL above */ }
  if (mode === 'offline') setOnlineStatus(`${modeText} همگام‌سازی خودکار خاموش است؛ فایل JSON و شمارش محلی فعال‌اند.`);
  else if (!cfg.url) setOnlineStatus(`${modeText} برای همگام‌سازی آنلاین، ابتدا نشانی Firebase را وارد و ذخیره کنید.`, true);
  else if (!navigator.onLine) setOnlineStatus(`${modeText} اینترنت قطع است؛ شمارش محلی حفظ می‌شود و همگام‌سازی خودکار پس از اتصال از سر گرفته می‌شود.`);
  else setOnlineStatus(`${modeText} همگام‌سازی خودکار هر 5 ثانیه بررسی می‌شود؛ می‌توانید دستی هم همگام‌سازی کنید.`);
  paintTeamModeChips();
}

function makeOnlinePack(): RemoteDevicePack {
  ensureSession();
  let previous: Record<string, { q1: number; q2: number }> = {};
  try { previous = JSON.parse(localStorage.getItem(REMOTE_CACHE_PREFIX + (session?.id || '')) || '{}'); } catch { previous = {}; }
  // Publish this device's own contribution only, not the remote counts already merged locally.
  const counted = products.map(p => {
    const old = previous[productKey({ code: p.code, sku: p.sku, name: p.name })] || { q1: 0, q2: 0 };
    const q1 = p.countedQty == null ? null : Number(p.countedQty) - old.q1;
    const q2 = p.countedQty2 == null ? null : Number(p.countedQty2) - old.q2;
    return { p, q1, q2 };
  }).filter(x => x.q1 !== null || x.q2 !== null);
  return {
    type: 'anbar-team-sync', version: 4, sessionId: session?.id || '',
    warehouse: settings.currentWarehouse || '', operator: getOperatorName(), role: settings.role,
    deviceId: deviceId(), exportedAt: new Date().toISOString(), countTotal: counted.length,
    counts: counted.map(({ p, q1, q2 }) => ({ code: p.code || '', sku: p.sku || '', name: p.name,
      countedQty: q1, countedQty2: q2, systemQty: p.systemQty,
      location: p.location || '', warehouse: p.warehouse || settings.currentWarehouse || '',
      note: p.note || '', price: p.price || 0, updatedAt: p.countUpdatedAt || null }))
  };
}

function productKey(c: { code?: string; sku?: string; name?: string }): string {
  if (c.code?.trim()) return 'code:' + c.code.trim().toLowerCase();
  if (c.sku?.trim()) return 'sku:' + c.sku.trim().toLowerCase();
  return 'name:' + (c.name || '').trim().toLowerCase();
}

/** Push this device's contribution and reconcile latest contributions from other devices.
 * The per-device layout prevents repeatedly pulling the same counts from adding them twice. */
export async function syncTeamOnlineNow(quiet = false): Promise<void> {
  if (onlineSyncBusy) return;
  const cfg = onlineConfig();
  if (!cfg.url) {
    setOnlineStatus('ابتدا نشانی Firebase Realtime Database را وارد و ذخیره کنید.', true);
    toast('تنظیمات همگام‌سازی آنلاین کامل نیست', 'error');
    return;
  }
  if (!navigator.onLine) {
    setOnlineStatus('اینترنت در دسترس نیست؛ داده‌ها محلی حفظ شده‌اند.', true);
    toast('اینترنت قطع است؛ حالت آفلاین فعال است', 'info');
    return;
  }
  onlineSyncBusy = true;
  const button = document.getElementById('btnSyncTeamOnline') as HTMLButtonElement | null;
  if (button) button.disabled = true;
  setOnlineStatus('در حال ارسال و دریافت شمارش‌های تیم…');
  try {
    const pack = makeOnlinePack();
    if (!pack.sessionId) throw new Error('شناسه جلسه موجود نیست');
    const root = `teams/${pack.sessionId}`;
    const put = await fetchWithSyncTimeout(firebaseUrl(`${root}/devices/${pack.deviceId}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pack), cache: 'no-store'
    });
    if (!put.ok) throw new Error(`ارسال آنلاین ناموفق بود (HTTP ${put.status})`);
    const get = await fetchWithSyncTimeout(firebaseUrl(`${root}/devices`), { cache: 'no-store' });
    if (!get.ok) throw new Error(`دریافت آنلاین ناموفق بود (HTTP ${get.status})`);
    const remote = await get.json() as unknown;
    const remoteObject = remote && typeof remote === 'object' && !Array.isArray(remote)
      ? remote as Record<string, unknown> : {};
    const remoteEntries = Object.entries(remoteObject);
    if (remoteEntries.length > 2000) throw new Error('تعداد دستگاه‌های ثبت‌شده در جلسه بیش از حد مجاز است');
    const all = remoteEntries
      .filter(([key, value]) => key !== pack.deviceId && isValidRemotePack(value, key, pack.sessionId))
      .map(([, value]) => value as RemoteDevicePack);
    const rejectedRemotePacks = remoteEntries.length - all.length - (remoteObject[pack.deviceId] ? 1 : 0);
    const totals = new Map<string, { item: TeamCountItem; q1: number; q2: number }>();
    const onlineMetadataConflicts = new Set<string>();
    for (const rp of all) for (const c of rp.counts) {
      const key = productKey(c);
      if (key === 'name:') continue;
      const item = totals.get(key) || { item: c, q1: 0, q2: 0 };
      const firstWarehouse = String(item.item.warehouse || '').trim().toLowerCase();
      const nextWarehouse = String(c.warehouse || '').trim().toLowerCase();
      if (Number(item.item.systemQty) !== Number(c.systemQty) ||
          (firstWarehouse && nextWarehouse && firstWarehouse !== nextWarehouse)) {
        onlineMetadataConflicts.add(key);
      }
      if (c.countedQty !== null && c.countedQty !== undefined) item.q1 += Number(c.countedQty) || 0;
      if (c.countedQty2 !== null && c.countedQty2 !== undefined) item.q2 += Number(c.countedQty2) || 0;
      totals.set(key, item);
    }
    const cacheKey = REMOTE_CACHE_PREFIX + pack.sessionId;
    let previous: Record<string, { q1: number; q2: number }> = {};
    try { previous = JSON.parse(localStorage.getItem(cacheKey) || '{}'); } catch { previous = {}; }
    const nextCache: Record<string, { q1: number; q2: number }> = {};
    const byKey = new Map<string, number>();
    products.forEach((p, i) => {
      byKey.set(productKey({ code: p.code, sku: p.sku, name: p.name }), i);
    });
    for (const [key, total] of totals) {
      nextCache[key] = { q1: total.q1, q2: total.q2 };
      let idx = byKey.get(key);
      if (idx === undefined) {
        const c = total.item;
        const np: Product = {
          id: generateId('sync'), name: c.name || 'کالای همگام‌شده', code: c.code || '', sku: c.sku || '',
          unit: 'عدد', systemQty: Number(c.systemQty) || 0, price: Number(c.price) || 0,
          location: c.location || '', warehouse: c.warehouse || settings.currentWarehouse || 'انبار اصلی',
          note: c.note || '', countedQty: null, countedQty2: null, createdAt: new Date().toISOString()
        };
        products.push(np); idx = products.length - 1; byKey.set(key, idx);
      }
      const p = products[idx];
      const old = previous[key] || { q1: 0, q2: 0 };
      const local1 = p.countedQty == null ? 0 : Number(p.countedQty) - old.q1;
      const local2 = p.countedQty2 == null ? 0 : Number(p.countedQty2) - old.q2;
      p.countedQty = (p.countedQty == null && total.q1 === 0 && old.q1 === 0) ? null : local1 + total.q1;
      p.countedQty2 = (p.countedQty2 == null && total.q2 === 0 && old.q2 === 0) ? null : local2 + total.q2;
      p.countUpdatedAt = new Date().toISOString();
    }
    // Remove remote contribution from products that disappeared from the server.
    for (const [key, old] of Object.entries(previous)) {
      if (totals.has(key)) continue;
      const idx = byKey.get(key);
      if (idx === undefined) continue;
      const p = products[idx];
      if (p.countedQty != null) p.countedQty = Math.max(0, Number(p.countedQty) - old.q1);
      if (p.countedQty2 != null) p.countedQty2 = Math.max(0, Number(p.countedQty2) - old.q2);
    }
    try { localStorage.setItem(cacheKey, JSON.stringify(nextCache)); } catch { /* sync still succeeds for this run */ }
    rebuildIndex(); save(true); invalidateStats();
    logAudit('team_online_sync', {
      sessionId: pack.sessionId, remoteDevices: all.length, remoteProducts: totals.size,
      metadataConflictCount: onlineMetadataConflicts.size,
      metadataConflictExamples: [...onlineMetadataConflicts].slice(0, 20),
    });
    setOnlineStatus(`همگام‌سازی موفق · دستگاه‌های دیگر: ${all.length} · کالاهای دریافتی: ${totals.size}` +
      (onlineMetadataConflicts.size ? ` · هشدار: ${onlineMetadataConflicts.size} تعارض اطلاعات پایه بین دستگاه‌ها` : '') +
      (rejectedRemotePacks ? ` · بسته‌های نامعتبر نادیده گرفته‌شده: ${rejectedRemotePacks}` : '') +
      ` · ${new Date().toLocaleTimeString()}`);
    if (!quiet) toast('همگام‌سازی آنلاین انجام شد', 'success');
  } catch (err) {
    console.error('[Anbarin] team online sync failed:', err);
    const message = err instanceof Error ? err.message : 'خطای ناشناخته';
    setOnlineStatus(`همگام‌سازی انجام نشد: ${message} · داده‌های محلی حفظ شده‌اند.`, true);
    if (!quiet) toast('همگام‌سازی آنلاین ناموفق بود؛ اطلاعات محلی حذف نشده‌اند', 'error');
  } finally {
    onlineSyncBusy = false;
    if (button) button.disabled = false;
  }
}

function configureAutoSync(): void {
  if (autoSyncTimer !== null) {
    window.clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  const mode = currentTeamSyncMode();
  if (mode === 'offline') return;
  autoSyncTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden' || !navigator.onLine || !onlineConfig().url || onlineSyncBusy) return;
    void syncTeamOnlineNow(true);
  }, 5000);
}

function paintTeamModeChips(): void {
  const mode = currentTeamSyncMode();
  const modeEl = document.getElementById('teamSyncMode') as HTMLSelectElement | null;
  if (modeEl && modeEl.value !== mode) modeEl.value = mode;
  document.querySelectorAll<HTMLElement>('[data-team-mode]').forEach((btn) => {
    const on = btn.dataset.teamMode === mode;
    btn.classList.toggle('is-active', on);
    btn.classList.toggle('is-available', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  // دکمه همگام‌سازی آنلاین: در حالت آفلاین غیرفعال‌تر دیده شود
  const syncNow = document.getElementById('btnSyncTeamOnline');
  if (syncNow) {
    const online = mode === 'live' || mode === 'hybrid';
    syncNow.classList.toggle('is-active', online);
    syncNow.classList.toggle('is-available', !online);
  }
}

export function initializeTeamOnlineSync(): void {
  const modeEl = document.getElementById('teamSyncMode') as HTMLSelectElement | null;
  if (modeEl) modeEl.value = currentTeamSyncMode();
  paintTeamModeChips();
  if (!onlineSyncInitialized) {
    onlineSyncInitialized = true;
    window.addEventListener('online', () => {
      refreshTeamOnlineStatus();
      // Auto-sync resumes only when a live/hybrid mode is selected.
      configureAutoSync();
    });
    window.addEventListener('offline', () => refreshTeamOnlineStatus());
  }
  configureAutoSync();
  refreshTeamOnlineStatus();
}
