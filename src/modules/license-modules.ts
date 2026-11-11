/**
 * لایسنس ماژولار انبارین
 * — شمارش/انبار (count)
 * — حسابداری (accounting)
 * — کامل (هر دو)
 *
 * سازگار با لایسنس‌های قدیمی بدون فیلد modules.
 * زیرساخت آنلاین: lease سرور از license-platform.
 */

import { getOfflineLicense } from './offline-license';
import { getStoredLicense, getInstallMeta } from './license';
import { getCachedLicenseLease, type LicenseLease } from './license-platform';
import { toast } from './ui';
import { showPage } from './ui';

export type AppModuleId = 'count' | 'accounting';

export const APP_MODULE_LABELS: Record<AppModuleId, string> = {
  count: 'شمارش و انبار',
  accounting: 'حسابداری',
};

const ALL_MODULES: AppModuleId[] = ['count', 'accounting'];
const TRIAL_DAYS = 14;

function uniqueModules(list: string[]): AppModuleId[] {
  const out: AppModuleId[] = [];
  for (const m of list) {
    const id = String(m || '').trim().toLowerCase();
    if ((id === 'count' || id === 'accounting') && !out.includes(id as AppModuleId)) {
      out.push(id as AppModuleId);
    }
  }
  return out;
}

export function modulesFromPlan(plan: string | undefined | null): AppModuleId[] {
  const p = String(plan || '').trim().toLowerCase();
  if (!p || p === 'none') return [];
  if (p === 'trial' || p === 'demo') return [...ALL_MODULES];
  if (
    p === 'full' ||
    p === 'pro' ||
    p === 'professional' ||
    p === 'enterprise' ||
    p === 'complete' ||
    p === 'standard'
  ) {
    return [...ALL_MODULES];
  }
  if (p === 'count' || p === 'inventory' || p === 'stock' || p === 'warehouse' || p === 'starter') {
    return ['count'];
  }
  if (p === 'accounting' || p === 'acc' || p === 'finance' || p === 'commerce') {
    return ['accounting'];
  }
  if (/count|inventory|stock/.test(p) && /acc|finance|commerce/.test(p)) return [...ALL_MODULES];
  if (/count|inventory|stock/.test(p)) return ['count'];
  if (/acc|finance|commerce/.test(p)) return ['accounting'];
  return [...ALL_MODULES];
}

function modulesFromFeatures(features: string[] | undefined): AppModuleId[] {
  if (!features?.length) return [];
  const set = new Set(features.map((f) => String(f).toLowerCase()));
  const out: AppModuleId[] = [];
  if (set.has('module.count') || set.has('inventory.basic') || set.has('inventory.advanced') || set.has('count')) {
    out.push('count');
  }
  if (
    set.has('module.accounting') ||
    set.has('accounting.basic') ||
    set.has('accounting.advanced') ||
    set.has('accounting')
  ) {
    out.push('accounting');
  }
  return out;
}

function modulesFromLease(lease: LicenseLease | null): AppModuleId[] {
  if (!lease) return [];
  const fromFeat = modulesFromFeatures(lease.entitlements?.features);
  if (fromFeat.length) return fromFeat;
  return modulesFromPlan(lease.plan);
}

function isTrialActiveLocal(): boolean {
  try {
    const install = getInstallMeta();
    if (install.clockTamper) return false;
    const first = new Date(install.firstAt).getTime();
    const trialEnd = first + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    return Date.now() < trialEnd;
  } catch {
    return false;
  }
}

function hasAnyLicense(): boolean {
  if (getOfflineLicense()) return true;
  if (getStoredLicense()) return true;
  if (getCachedLicenseLease()) return true;
  return isTrialActiveLocal();
}

export function getActiveModules(): AppModuleId[] {
  const offline = getOfflineLicense();
  if (offline) {
    const listed = uniqueModules(offline.modules || []);
    if (listed.length) return listed;
    return modulesFromPlan(offline.plan);
  }

  const stored = getStoredLicense();
  if (stored) {
    const listed = uniqueModules((stored as { modules?: string[] }).modules || []);
    if (listed.length) return listed;
    return modulesFromPlan(stored.plan);
  }

  const lease = getCachedLicenseLease();
  if (lease) {
    const fromLease = modulesFromLease(lease);
    if (fromLease.length) return fromLease;
  }

  if (isTrialActiveLocal()) return [...ALL_MODULES];

  // پس از پایان آزمایشی، بدون لایسنس هیچ ماژولی باز نیست (شمارش و حسابداری هر دو نیاز به لایسنس دارند)
  return [];
}

export function hasModule(module: AppModuleId): boolean {
  return getActiveModules().includes(module);
}

export function requireModule(module: AppModuleId, featureLabel?: string): boolean {
  if (hasModule(module)) return true;
  const name = APP_MODULE_LABELS[module];
  toast(
    `دسترسی به «${featureLabel || name}» نیاز به لایسنس ${name} دارد. از تنظیمات لایسنس را فعال کنید.`,
    'error'
  );
  showPage('admin');
  return false;
}

export function describeActiveModules(): string {
  const mods = getActiveModules();
  const offline = getOfflineLicense();
  const stored = getStoredLicense();
  if (offline || stored) {
    if (mods.length === ALL_MODULES.length) return 'کامل (شمارش + حسابداری)';
    return mods.map((m) => APP_MODULE_LABELS[m]).join(' + ') + ' — لایسنس فعال';
  }
  if (isTrialActiveLocal()) return 'آزمایشی — کامل (شمارش + حسابداری)';
  if (mods.length === ALL_MODULES.length) return 'کامل (شمارش + حسابداری)';
  if (!mods.length) return 'بدون لایسنس — برای شمارش و حسابداری لایسنس فعال کنید';
  return mods.map((m) => APP_MODULE_LABELS[m]).join(' + ');
}

export function applyLicenseModuleUI(): void {
  const canCount = hasModule('count');
  const canAcc = hasModule('accounting');

  document.querySelectorAll<HTMLElement>('.nav-item[data-page]').forEach((btn) => {
    const page = btn.dataset.page || '';
    let allowed = true;
    if (page === 'count' || page === 'products' || page === 'reports') allowed = canCount;
    else if (page === 'accounting') allowed = canAcc;
    btn.style.display = allowed ? '' : 'none';
    btn.toggleAttribute('disabled', !allowed);
    btn.classList.toggle('module-locked', !allowed);
  });

  const lock = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('module-locked', on);
    if (on) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  };
  lock('page-count', !canCount);
  lock('page-products', !canCount);
  lock('page-reports', !canCount);
  lock('page-accounting', !canAcc);

  const active = document.querySelector('.page.active') as HTMLElement | null;
  if (active) {
    const id = active.id || '';
    if ((id === 'page-count' || id === 'page-products' || id === 'page-reports') && !canCount) showPage('admin');
    else if (id === 'page-accounting' && !canAcc) showPage('admin');
  }

  const detail = document.getElementById('licenseModuleDetail');
  if (detail) detail.textContent = describeActiveModules();
}

export function moduleForPage(page: string): AppModuleId | null {
  if (page === 'count' || page === 'products' || page === 'reports') return 'count';
  if (page === 'accounting') return 'accounting';
  return null;
}
