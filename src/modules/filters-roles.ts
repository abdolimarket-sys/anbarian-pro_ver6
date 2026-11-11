/**
 * فیلتر مکان/انبار + اعمال نقش در کل UI
 * هدف: بدون عقبگرد نسبت به نسخه قدیم + کنترل یکدست‌تر
 */

import { products, settings, filterByActiveWarehouse } from './state';
import type { Product } from '@/types';
import { toast } from './ui';
import { authorizeLocally, type Permission } from './authorization';
import { qtyEqual } from '@/utils/helpers';
import { applyLicenseModuleUI } from './license-modules';

export let locationFilter = '';
export let warehouseFilterMode: 'active' | 'all' = 'active';

export function setLocationFilter(loc: string): void {
  locationFilter = (loc || '').trim();
}

export function setWarehouseFilterMode(mode: 'active' | 'all'): void {
  warehouseFilterMode = mode;
}

/** همه محل‌های یکتا (از کالاها) */
export function collectLocations(): string[] {
  const set = new Set<string>();
  for (const p of products) {
    const loc = (p.location || '').trim();
    if (loc) set.add(loc);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fa'));
}

export function collectWarehouses(): string[] {
  const set = new Set<string>(settings.warehouses || []);
  for (const p of products) {
    const w = (p.warehouse || '').trim();
    if (w) set.add(w);
  }
  if (settings.currentWarehouse) set.add(settings.currentWarehouse);
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'fa'));
}

/**
 * نرمال‌سازی متن برای جستجوی هوشمند فارسی:
 * - یکسان‌سازی ی/ي و ک/ك
 * - حذف نیم‌فاصله و فاصله‌های اضافه
 * - تبدیل ارقام فارسی/عربی به انگلیسی
 * - حروف کوچک (برای کدهای لاتین)
 */
function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .replace(/[یي]/g, 'ی')
    .replace(/[کك]/g, 'ک')
    .replace(/[\u200c\u200f\u200e]/g, ' ') // نیم‌فاصله و جهت‌ها
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** فیلتر ترکیبی انبار + محل + جستجوی هوشمند (contains روی همه فیلدها + چندکلمه) */
export function filterProductsAdvanced(
  opts: {
    query?: string;
    location?: string;
    onlyWarehouse?: boolean;
    countFilter?: 'all' | 'counted' | 'uncounted' | 'diff';
  } = {}
): Product[] {
  let list =
    opts.onlyWarehouse === false || warehouseFilterMode === 'all'
      ? [...products]
      : filterByActiveWarehouse(products);

  const loc = normalizeSearchText(opts.location ?? locationFilter);
  if (loc) {
    list = list.filter((p) => normalizeSearchText(p.location).includes(loc));
  }

  const cf = opts.countFilter;
  if (cf === 'counted') list = list.filter((p) => p.countedQty != null);
  else if (cf === 'uncounted') list = list.filter((p) => p.countedQty == null);
  else if (cf === 'diff')
    list = list.filter((p) => p.countedQty != null && !qtyEqual(p.countedQty, p.systemQty));

  const rawQ = (opts.query || '').trim();
  if (rawQ) {
    // پشتیبانی از چند کلمه: همه باید جایی در فیلدها پیدا شوند
    const tokens = normalizeSearchText(rawQ)
      .split(' ')
      .filter((t) => t.length > 0);

    if (tokens.length > 0) {
      list = list.filter((p) => {
        const haystack = normalizeSearchText(
          [p.name, p.code, p.sku, p.location, p.note].filter(Boolean).join(' ')
        );
        return tokens.every((token) => haystack.includes(token));
      });

      // مرتب‌سازی هوشمند: اول آن‌هایی که با توکن اول شروع می‌شوند، بعد بقیه
      const first = tokens[0];
      list.sort((a, b) => {
        const an = normalizeSearchText(a.name || '');
        const bn = normalizeSearchText(b.name || '');
        const aStarts = an.startsWith(first) || normalizeSearchText(a.code || '').startsWith(first);
        const bStarts = bn.startsWith(first) || normalizeSearchText(b.code || '').startsWith(first);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return an.localeCompare(bn, 'fa');
      });
    }
  }
  return list;
}

export function isViewer(): boolean {
  return settings.role === 'viewer';
}

export function isAdmin(): boolean {
  return settings.role === 'admin' || !settings.role;
}

export function isCounter(): boolean {
  return settings.role === 'counter' || isAdmin();
}

/** اعمال محدودیت نقش روی دکمه‌ها و فرم‌ها */
export function applyRoleUI(): void {
  const admin = isAdmin();
  const permissionSelectors: Partial<Record<Permission, string[]>> = {
    'inventory.read': [],
    'inventory.count': ['#btnOpenScanner', '#btnQuickCount', '#qtyConfirm', '#btnClearCounts', '#btnZeroUncounted', '#btnApplySystem', '#btnResetToSystem'],
    'inventory.edit': ['#btnAddProduct', '#btnTakePhoto'],
    'inventory.import': ['#btnImport', '#btnImportPhotos'],
    'inventory.export': ['#btnExportExcel', '#btnExportDiff', '#btnExportCsv', '#btnExportJson', '#btnExportPhotos', '#btnExportDiffs', '#btnExportCountedProducts', '#btnExportInventoryDocs', '#btnExportPartial', '#btnExportMergeReport'],
    'session.start': ['#btnStartSession'],
    'session.close': ['#btnCloseSession'],
    'team.sync': ['#btnExportTeam', '#btnImportTeam', '#btnJoinSession', '#btnSyncTeamOnline'],
    'audit.read': ['#btnExportAudit'],
    'audit.clear': ['#btnClearAudit'],
    'license.manage': ['#btnActivateLicense', '#btnDeactivateLicense', '#btnActivateOfflineLicense'],
    'settings.manage': ['#btnSaveSettings'],
  };
  for (const [permission, selectors] of Object.entries(permissionSelectors) as [Permission, string[]][]) {
    const allowed = authorizeLocally(settings, permission).allowed;
    for (const selector of selectors) document.querySelectorAll<HTMLButtonElement>(selector).forEach(button => {
      button.disabled = !allowed;
      button.title = allowed ? '' : `مجوز لازم: ${permission}`;
      button.classList.toggle('role-locked', !allowed);
    });
  }
  // حذف لاگ و مدیریت حساب‌ها فقط برای مدیر مجاز است.
  ['#btnClearAudit', '#localAddUser'].forEach(selector => document.querySelectorAll<HTMLButtonElement>(selector).forEach(button => {
    const allowed = authorizeLocally(settings, selector === '#btnClearAudit' ? 'audit.clear' : 'users.manage').allowed;
    button.disabled = !allowed; button.classList.toggle('role-locked', !allowed);
  }));
  const badge = document.getElementById('roleBadge');
  if (badge) badge.textContent = settings.role === 'viewer' ? 'مشاهده‌گر' : settings.role === 'counter' ? 'شمارنده' : 'مدیر';
  const usersPanel = document.getElementById('localUsersPanel');
  if (usersPanel) usersPanel.classList.toggle('role-locked', !authorizeLocally(settings, 'users.manage').allowed);
  try { applyLicenseModuleUI(); } catch { /* ignore */ }
}

/** بررسی یک مجوز محلی برای یکسان‌سازی کنترل‌های رابط کاربری.
 * این بررسی جایگزین احراز هویت یا کنترل دسترسی سمت سرور نیست.
 */
export function guardPermission(permission: Permission, feature = 'این عمل'): boolean {
  const decision = authorizeLocally(settings, permission);
  if (!decision.allowed) {
    toast('نقش فعلی اجازه «' + feature + '» را ندارد', 'error');
    return false;
  }
  return true;
}

/** نگه‌داشتن رفتار قبلی: شمارنده و مدیر مجازند؛ مشاهده‌گر فقط خواندنی است. */
export function guardWrite(feature = 'این عمل'): boolean {
  return guardPermission('inventory.count', feature);
}

/** پر کردن select محل‌ها */
export function fillLocationSelect(selectId = 'locationFilterSelect'): void {
  const sel = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!sel) return;
  const current = sel.value;
  const locs = collectLocations();
  // Treat location names as untrusted text: never interpolate them into innerHTML.
  sel.replaceChildren();
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'همه محل‌ها';
  sel.appendChild(allOption);
  for (const location of locs) {
    const option = document.createElement('option');
    option.value = location;
    option.textContent = location;
    sel.appendChild(option);
  }
  if (current && locs.includes(current)) sel.value = current;
  else if (locationFilter && locs.includes(locationFilter)) sel.value = locationFilter;
}
