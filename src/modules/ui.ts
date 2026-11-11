/**
 * توابع UI پایه (toast، navigation ساده و ...)
 */

import type { ToastType } from '@/types';
import { Capacitor } from '@capacitor/core';

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, type: ToastType = 'info'): void {
  // در اندروید پیام موفقیت دانلود را فقط بعد از تأیید واقعی ذخیره نشان می‌دهیم.
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && /دانلود شد|فایل ذخیره شد/.test(message)) return;
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }

  el.textContent = message;
  el.className = `toast show ${type}`;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el?.classList.remove('show');
  }, 2800);
}

export function showPage(pageId: string): void {
  document.querySelectorAll('.page').forEach((p) => {
    p.classList.remove('active');
  });
  const target = document.getElementById(`page-${pageId}`);
  if (target) target.classList.add('active');

  // nav active state
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-page') === pageId);
  });
}

export type ThemePreference = 'light' | 'dark' | 'auto';

const THEME_PREF_KEY = 'anbar_theme_pref';
const THEME_LEGACY_KEY = 'anbar_theme';

let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'auto') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }
  return pref;
}

/** اعمال تم واقعی روی سند (روشن / تاریک) */
export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** سازگاری با کدهای قبلی که فقط light/dark می‌فرستند */
export function setTheme(theme: 'light' | 'dark'): void {
  setThemePreference(theme);
}

export function getThemePreference(): ThemePreference {
  const pref = localStorage.getItem(THEME_PREF_KEY) as ThemePreference | null;
  if (pref === 'light' || pref === 'dark' || pref === 'auto') return pref;
  const legacy = localStorage.getItem(THEME_LEGACY_KEY) as 'light' | 'dark' | null;
  if (legacy === 'light' || legacy === 'dark') return legacy;
  return 'auto';
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_PREF_KEY, pref);
    // کلید قدیمی برای سازگاری
    localStorage.setItem(THEME_LEGACY_KEY, resolveTheme(pref));
  } catch {
    /* ignore quota */
  }
  applyTheme(resolveTheme(pref));
  bindSystemThemeListener(pref === 'auto');
  paintThemeButtons(pref);
}

function bindSystemThemeListener(enabled: boolean): void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (systemThemeListener) {
      mq.removeEventListener('change', systemThemeListener);
      systemThemeListener = null;
    }
    if (!enabled) return;
    systemThemeListener = () => {
      if (getThemePreference() !== 'auto') return;
      applyTheme(resolveTheme('auto'));
    };
    mq.addEventListener('change', systemThemeListener);
  } catch {
    /* older webviews */
  }
}

export function paintThemeButtons(pref?: ThemePreference): void {
  const current = pref || getThemePreference();
  document.querySelectorAll<HTMLElement>('[data-theme-pref]').forEach((btn) => {
    const on = btn.dataset.themePref === current;
    btn.classList.toggle('is-active', on);
    btn.classList.toggle('is-available', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

export function loadTheme(): ThemePreference {
  const pref = getThemePreference();
  applyTheme(resolveTheme(pref));
  bindSystemThemeListener(pref === 'auto');
  // بعد از ساخت DOM دکمه‌ها رنگ می‌شوند؛ اینجا هم اگر موجود باشند
  queueMicrotask(() => paintThemeButtons(pref));
  return pref;
}

export function bindThemeControls(): void {
  document.querySelectorAll<HTMLElement>('[data-theme-pref]').forEach((btn) => {
    if (btn.dataset.themeBound === '1') return;
    btn.dataset.themeBound = '1';
    btn.addEventListener('click', () => {
      const pref = (btn.dataset.themePref || 'auto') as ThemePreference;
      if (pref !== 'light' && pref !== 'dark' && pref !== 'auto') return;
      setThemePreference(pref);
      const label = pref === 'light' ? 'روشن' : pref === 'dark' ? 'تاریک' : 'خودکار (سیستم)';
      toast(`تم ${label} اعمال شد`, 'success');
    });
  });
  paintThemeButtons();
}
