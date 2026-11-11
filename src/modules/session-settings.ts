/**
 * مدیریت جلسه و تنظیمات کاربردی
 */

import type { AppSettings } from '@/types';
import {
  settings,
  session,
  products,
  startNewSession,
  closeSession,
  saveSettingsNow,
  save,
  isDoubleCount,
  setCountPhase,
  countPhase,
} from './state';
import { toast } from './ui';
import { getOperatorName, setOperatorName } from './storage';
import { clearAllCounts, zeroUncounted, canCount } from './count';
import { guardPermission } from './filters-roles';

export function getSessionLabel(): string {
  if (!session) return 'جلسه‌ای شروع نشده';
  if (session.closedAt) {
    return (
      'بسته · ' +
      new Date(session.closedAt).toLocaleDateString('fa-IR') +
      ' ' +
      new Date(session.closedAt).toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
      })
    );
  }
  return (
    'باز · ' +
    new Date(session.startedAt).toLocaleDateString('fa-IR') +
    ' ' +
    new Date(session.startedAt).toLocaleTimeString('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
    })
  );
}

export function isSessionOpen(): boolean {
  return !!(session && !session.closedAt);
}

export function actionStartSession(): void {
  if (!guardPermission('session.start', 'شروع جلسه')) return;
  if (!canCount()) {
    toast('نقش مشاهده‌گر اجازه شروع جلسه ندارد', 'error');
    return;
  }
  if (startNewSession(false)) {
    toast('جلسه جدید شروع شد', 'success');
  }
}

export function actionCloseSession(): void {
  if (!guardPermission('session.close', 'بستن جلسه')) return;
  if (!session || session.closedAt) {
    toast('جلسه‌ای باز نیست', 'info');
    return;
  }
  if (!confirm('جلسه بسته شود؟ بعد از بستن، شمارش قفل می‌شود.')) return;
  closeSession();
  toast('جلسه بسته شد', 'success');
}

export function actionClearCounts(): void {
  clearAllCounts();
}

export function actionZeroUncounted(): void {
  zeroUncounted();
}

/** اعمال تغییرات فرم تنظیمات به state */
export function applySettingsFromForm(): void {
  if (!guardPermission('settings.manage', 'ذخیره تنظیمات')) return;
  const g = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;

  const bool = (id: string, fallback: boolean) => {
    const el = g(id) as HTMLInputElement | null;
    return el ? !!el.checked : fallback;
  };

  settings.continuousScan = bool('setContinuous', settings.continuousScan);
  settings.autoNextScan = bool('setAutoNext', settings.autoNextScan !== false);
  settings.soundOnScan = bool('setSound', settings.soundOnScan);
  settings.vibrateOnScan = bool('setVibrate', settings.vibrateOnScan);
  settings.autoIncrement = bool('setAutoInc', settings.autoIncrement);
  settings.blindCount = bool('setBlind', settings.blindCount);
  settings.btScanner = bool('setBt', settings.btScanner !== false);
  settings.doubleCount = bool('setDouble', settings.doubleCount);

  const role = g('setRole') as HTMLSelectElement | null;
  if (role) settings.role = role.value as AppSettings['role'];

  applyWarehouseSettingsFromForm();

  const op = g('setOperator') as HTMLInputElement | null;
  if (op) setOperatorName(op.value);

  const text = (id: string) => {
    const el = g(id) as HTMLInputElement | null;
    return el ? el.value.trim() : '';
  };
  settings.businessName = text('setBusinessName');
  settings.businessSlogan = text('setBusinessSlogan');
  settings.businessPhone = text('setBusinessPhone');
  settings.businessAddress = text('setBusinessAddress');
  settings.businessNationalId = text('setBusinessNationalId');
  settings.businessEconomicCode = text('setBusinessEconomicCode');
  settings.businessPostalCode = text('setBusinessPostalCode');
  // لوگو از طریق input فایل به‌صورت data URL در settings نگه داشته می‌شود (رویداد change)

  // پیامک (اختیاری)
  const smsEnabledEl = g('setSmsEnabled') as HTMLInputElement | null;
  if (smsEnabledEl) settings.smsEnabled = !!smsEnabledEl.checked;
  const smsProviderEl = g('setSmsProvider') as HTMLSelectElement | null;
  if (smsProviderEl) settings.smsProvider = (smsProviderEl.value as AppSettings['smsProvider']) || 'device';
  settings.smsUsername = text('setSmsUsername');
  settings.smsApiKey = text('setSmsApiKey');
  settings.smsSender = text('setSmsSender');
  settings.smsCustomUrl = text('setSmsCustomUrl');
  const smsTpl = text('setSmsDefaultTemplate');
  if (smsTpl) settings.smsDefaultTemplate = smsTpl;

  saveSettingsNow();
  toast('تنظیمات ذخیره شد', 'success');
}

/** مدل تک‌انباره */
function applyWarehouseSettingsFromForm(): void {
  settings.warehouses = ['انبار اصلی'];
  settings.currentWarehouse = 'انبار اصلی';
  const legacy = document.getElementById('setWarehouse') as HTMLInputElement | HTMLSelectElement | null;
  if (legacy && 'value' in legacy) legacy.value = 'انبار اصلی';
}

function renderWarehouseSettingsUI(): void {
  settings.warehouses = ['انبار اصلی'];
  settings.currentWarehouse = 'انبار اصلی';
  const panel = document.getElementById('setWarehousePanel');
  if (panel) {
    panel.innerHTML = '<p class="hint" style="margin:0">در این نسخه فقط <strong>انبار اصلی</strong> فعال است.</p>';
  }
  const legacy = document.getElementById('setWarehouse') as HTMLInputElement | HTMLSelectElement | null;
  if (legacy) {
    if (legacy.tagName === 'SELECT') {
      legacy.innerHTML = '<option value="انبار اصلی">انبار اصلی</option>';
      (legacy as HTMLSelectElement).value = 'انبار اصلی';
    } else {
      (legacy as HTMLInputElement).value = 'انبار اصلی';
      (legacy as HTMLInputElement).readOnly = true;
    }
  }
}

export function fillSettingsForm(): void {
  const set = (id: string, checked: boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.checked = checked;
  };
  set('setContinuous', !!settings.continuousScan);
  set('setAutoNext', settings.autoNextScan !== false);
  set('setSound', !!settings.soundOnScan);
  set('setVibrate', !!settings.vibrateOnScan);
  set('setAutoInc', !!settings.autoIncrement);
  set('setBlind', !!settings.blindCount);
  set('setBt', settings.btScanner !== false);
  set('setDouble', !!settings.doubleCount);

  const role = document.getElementById('setRole') as HTMLSelectElement | null;
  if (role) role.value = settings.role || 'admin';

  renderWarehouseSettingsUI();

  const op = document.getElementById('setOperator') as HTMLInputElement | null;
  if (op) op.value = getOperatorName() === 'ناشناس' ? '' : getOperatorName();

  const fillText = (id: string, value?: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = value || '';
  };
  fillText('setBusinessName', settings.businessName);
  fillText('setBusinessSlogan', settings.businessSlogan);
  fillText('setBusinessPhone', settings.businessPhone);
  fillText('setBusinessAddress', settings.businessAddress);
  fillText('setBusinessNationalId', settings.businessNationalId);
  fillText('setBusinessEconomicCode', settings.businessEconomicCode);
  fillText('setBusinessPostalCode', settings.businessPostalCode);
  // پیامک
  const smsEn = document.getElementById('setSmsEnabled') as HTMLInputElement | null;
  if (smsEn) smsEn.checked = !!settings.smsEnabled;
  const smsProv = document.getElementById('setSmsProvider') as HTMLSelectElement | null;
  if (smsProv) smsProv.value = settings.smsProvider || 'device';
  fillText('setSmsUsername', settings.smsUsername || '');
  fillText('setSmsApiKey', settings.smsApiKey || '');
  fillText('setSmsSender', settings.smsSender || '');
  fillText('setSmsCustomUrl', settings.smsCustomUrl || '');
  fillText('setSmsDefaultTemplate', settings.smsDefaultTemplate || '');

  const logoPrev = document.getElementById('setBusinessLogoPreview') as HTMLImageElement | null;
  const logoPh = document.getElementById('setBusinessLogoPlaceholder');
  if (logoPrev) {
    if (settings.businessLogoDataUrl) {
      logoPrev.src = settings.businessLogoDataUrl;
      logoPrev.style.display = 'block';
      if (logoPh) logoPh.style.display = 'none';
    } else {
      logoPrev.removeAttribute('src');
      logoPrev.style.display = 'none';
      if (logoPh) logoPh.style.display = '';
    }
  }

  const phaseBar = document.getElementById('phaseBar');
  if (phaseBar) {
    phaseBar.style.display = settings.doubleCount ? 'flex' : 'none';
  }
  updatePhaseButtons();
}

/** اتصال یک‌باره انتخاب/حذف لوگو فروشگاه */
export function bindBusinessLogoControls(): void {
  const input = document.getElementById('setBusinessLogo') as HTMLInputElement | null;
  const clearBtn = document.getElementById('btnClearBusinessLogo');
  const preview = document.getElementById('setBusinessLogoPreview') as HTMLImageElement | null;
  if (input && input.dataset.bound !== '1') {
    input.dataset.bound = '1';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 400_000) {
        toast('حجم لوگو زیاد است؛ کمتر از حدود ۴۰۰ کیلوبایت انتخاب کنید', 'error');
        input.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl.startsWith('data:image/')) {
          toast('فایل تصویر معتبر نیست', 'error');
          return;
        }
        settings.businessLogoDataUrl = dataUrl;
        if (preview) {
          preview.src = dataUrl;
          preview.style.display = 'block';
        }
        const ph = document.getElementById('setBusinessLogoPlaceholder');
        if (ph) ph.style.display = 'none';
        toast('لوگو انتخاب شد؛ برای ثبت نهایی «ذخیره تنظیمات» را بزنید', 'info');
      };
      reader.readAsDataURL(file);
    });
  }
  if (clearBtn && clearBtn.dataset.bound !== '1') {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', () => {
      settings.businessLogoDataUrl = '';
      if (input) input.value = '';
      if (preview) {
        preview.removeAttribute('src');
        preview.style.display = 'none';
      }
      const ph = document.getElementById('setBusinessLogoPlaceholder');
      if (ph) ph.style.display = '';
      toast('لوگو حذف شد؛ ذخیره تنظیمات را بزنید', 'info');
    });
  }
}

export function updatePhaseButtons(): void {
  const phase = countPhase();
  document.querySelectorAll('[data-phase]').forEach((btn) => {
    const p = Number((btn as HTMLElement).dataset.phase);
    btn.classList.toggle('active', p === phase);
  });
}

export function actionSetPhase(phase: 1 | 2): void {
  if (!isDoubleCount()) {
    toast('شمارش دومرحله‌ای خاموش است', 'info');
    return;
  }
  setCountPhase(phase);
  updatePhaseButtons();
  toast(phase === 1 ? 'شمارش اول فعال شد' : 'شمارش دوم فعال شد', 'success');
}

export function getSettingsSummary(): string {
  const parts = [
    settings.role,
    settings.doubleCount ? 'دومرحله‌ای' : null,
    settings.blindCount ? 'کور' : null,
    settings.currentWarehouse,
  ].filter(Boolean);
  return parts.join(' · ');
}
