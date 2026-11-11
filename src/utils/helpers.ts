/** ابزارهای عمومی */

import { Capacitor, registerPlugin } from '@capacitor/core';

interface SaveFilePluginResult {
  cancelled: boolean;
  uri?: string;
  filename?: string;
}
interface SaveFilePluginAPI {
  save(options: { filename: string; mimeType: string; data: string }): Promise<SaveFilePluginResult>;
}
const NativeSaveFile = registerPlugin<SaveFilePluginAPI>('SaveFile');

interface ShareFilePluginAPI {
  share(options: {
    filename: string;
    mimeType: string;
    data: string;
    title?: string;
    text?: string;
  }): Promise<{ shared: boolean; filename?: string }>;
}
const NativeShareFile = registerPlugin<ShareFilePluginAPI>('ShareFile');

const NativePrint = registerPlugin<{
  printHtml(options: { html: string; title: string }): Promise<{ started: boolean }>;
}>('NativePrint');

/** تبدیل Blob/متن به Base64 برای پلاگین‌های بومی */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * چاپ HTML بدون ترک صفحه فعلی اپ.
 * روی اندروید: NativePrint | روی وب: iframe مخفی.
 * از window.open استفاده نمی‌کند تا بعد از چاپ صفحه خالی نماند.
 * options.paperSize: 'a4' | 'a5' | 'label80' — در صورت ارسال، @page تزریق می‌شود.
 */
export function printHtmlSafely(
  html: string,
  title = 'چاپ',
  options?: {
    onSuccess?: () => void;
    onError?: (err: unknown) => void;
    paperSize?: 'a4' | 'a5' | 'label80';
  }
): void {
  const { onSuccess, onError, paperSize } = options || {};

  let finalHtml = html;
  if (paperSize) {
    // تزریق سبک @page بدون وابستگی دایره‌ای به ماژول چاپ
    const pageMap: Record<string, string> = {
      a4: '@page{size:A4;margin:12mm}',
      a5: '@page{size:A5;margin:10mm}',
      label80: '@page{size:80mm auto;margin:2mm}',
    };
    const pageRule = pageMap[paperSize] || pageMap.a4;
    if (/@page\s*\{/.test(finalHtml)) {
      finalHtml = finalHtml.replace(/@page\s*\{[^}]*\}/g, pageRule);
    } else if (/<\/head>/i.test(finalHtml)) {
      finalHtml = finalHtml.replace(/<\/head>/i, `<style>${pageRule}</style></head>`);
    } else {
      finalHtml = `<style>${pageRule}</style>` + finalHtml;
    }
  }

  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    NativePrint.printHtml({ html: finalHtml, title })
      .then((result) => {
        if (result?.started) onSuccess?.();
        else onError?.(new Error('سیستم چاپ پاسخی نداد'));
      })
      .catch((err) => {
        console.error('[Anbarin] native print failed:', err);
        onError?.(err);
      });
    return;
  }

  try {
    const frame = document.createElement('iframe');
    frame.title = title;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0.01;pointer-events:none;z-index:50000;';
    let started = false;
    const cleanup = () => {
      window.setTimeout(() => {
        try {
          frame.remove();
        } catch {
          /* ignore */
        }
      }, 1500);
    };
    frame.onload = () => {
      if (started) return;
      started = true;
      const w = frame.contentWindow;
      if (!w) {
        frame.remove();
        onError?.(new Error('آماده‌سازی چاپ ناموفق بود'));
        return;
      }
      const finish = () => {
        cleanup();
        onSuccess?.();
      };
      w.onafterprint = finish;
      window.setTimeout(cleanup, 60000);
      window.setTimeout(() => {
        try {
          w.focus();
          w.print();
        } catch (err) {
          console.error(err);
          frame.remove();
          onError?.(err);
        }
      }, 250);
    };
    frame.srcdoc = finalHtml;
    document.body.appendChild(frame);
  } catch (err) {
    console.error('[Anbarin] print setup failed:', err);
    onError?.(err);
  }
}

/** تبدیل ارقام فارسی و عربی به ارقام استاندارد برای بارکد و کد کالا */
export function normalizeDigits(value: unknown): string {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();
}

export function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function dateStr(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function generateId(prefix = ''): string {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7)
  );
}

/** محدود کردن رقم اعشار برای جلوگیری از نمایش ۱۴-۱۵ رقم شناور */
export function roundQty(n: number, digits = 4): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function formatFaNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const cleaned = roundQty(Number(n));
  return cleaned.toLocaleString('fa-IR', {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  });
}

/** مقایسه امن موجودی (با تحمل خطای شناور) */
export function qtyEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 1e-6;
}

export function formatAuditTime(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString('fa-IR') +
      ' ' +
      d.toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    );
  } catch {
    return iso;
  }
}

/**
 * ذخیره فایل در دستگاه (اندروید: دیالوگ «ذخیره در» سیستم؛ وب: دانلود مرورگر).
 * خروجی Promise برای کنترل toast/وضعیت در UI.
 */
export async function downloadFile(
  content: string | Blob,
  filename: string,
  mime = 'text/plain;charset=utf-8'
): Promise<'saved' | 'cancelled' | 'error'> {
  const blob =
    typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const mimeType = blob.type || mime || 'application/octet-stream';

  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      const data = await blobToBase64(blob);
      const result = await NativeSaveFile.save({ filename, mimeType, data });
      if (result.cancelled) {
        window.dispatchEvent(new CustomEvent('anbarin:file-save-cancelled', {
          detail: { filename },
        }));
        return 'cancelled';
      }
      window.dispatchEvent(new CustomEvent('anbarin:file-saved', {
        detail: { filename: result.filename || filename, uri: result.uri || '' },
      }));
      return 'saved';
    } catch (error) {
      console.error('ذخیره فایل در اندروید ناموفق بود', error);
      window.dispatchEvent(new CustomEvent('anbarin:file-save-error', {
        detail: { filename, message: String(error) },
      }));
      return 'error';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'saved';
}

/**
 * اشتراک‌گذاری فایل (اندروید: شیت سیستم — Drive، تلگرام، واتساپ، ایمیل و ...).
 * روی وب: Web Share API در صورت پشتیبانی.
 */
export async function shareFileContent(
  content: string | Blob,
  filename: string,
  mime = 'application/octet-stream',
  options?: { title?: string; text?: string }
): Promise<'shared' | 'cancelled' | 'unavailable' | 'error'> {
  const blob =
    typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const mimeType = blob.type || mime || 'application/octet-stream';
  const title = options?.title || filename;
  const text = options?.text || '';

  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      const data = await blobToBase64(blob);
      await NativeShareFile.share({ filename, mimeType, data, title, text });
      return 'shared';
    } catch (error) {
      console.error('اشتراک‌گذاری بومی ناموفق بود', error);
      return 'error';
    }
  }

  try {
    const file = new File([blob], filename, { type: mimeType });
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title, text, files: [file] });
      return 'shared';
    }
    if (typeof navigator.share === 'function') {
      // بدون فایل (محدودیت مرورگر) — حداقل عنوان/متن
      await navigator.share({ title, text: text || `فایل: ${filename}` });
      return 'shared';
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
    console.error('Web Share ناموفق بود', error);
  }
  return 'unavailable';
}

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
