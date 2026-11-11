/**
 * گزارش‌ها و خروجی‌های کاربردی انبارگردانی
 */

import type { Product } from '@/types';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { products, settings, session, auditLog, inventoryDocs, isDoubleCount, logAudit } from './state';
import { toast } from './ui';
import { exportExcel, exportCSV, rowsToCSV, buildOfflineXlsx } from './import-export';
import { downloadFile, dateStr, formatFaNumber, printHtmlSafely } from '@/utils/helpers';
import { getOperatorName } from './storage';
import { choosePaperSize } from './print-paper';

const NativePrint = registerPlugin<{ printHtml(options: { html: string; title: string }): Promise<{ started: boolean }> }>('NativePrint');

export interface ReportSummary {
  total: number;
  counted: number;
  uncounted: number;
  diffs: number;
  over: number;
  under: number;
  match: number;
  withPhoto: number;
  progressPct: number;
  valueDiff: number;
}

export function computeSummary(list: Product[] = products): ReportSummary {
  let counted = 0;
  let diffs = 0;
  let over = 0;
  let under = 0;
  let match = 0;
  let withPhoto = 0;
  let valueDiff = 0;

  for (const p of list) {
    if (p.photo) withPhoto++;
    if (p.countedQty == null) continue;
    counted++;
    const d = p.countedQty - (p.systemQty ?? 0);
    if (d === 0) match++;
    else {
      diffs++;
      if (d > 0) over++;
      else under++;
      valueDiff += d * (p.price || 0);
    }
  }

  const total = list.length;
  return {
    total,
    counted,
    uncounted: total - counted,
    diffs,
    over,
    under,
    match,
    withPhoto,
    progressPct: total ? Math.round((counted / total) * 100) : 0,
    valueDiff,
  };
}

function activeList(): Product[] {
  const wh = settings.currentWarehouse;
  if (!wh || wh === 'همه') return products;
  return products.filter((p) => (p.warehouse || 'انبار اصلی') === wh);
}

export function buildTextReport(): string {
  const list = activeList();
  const s = computeSummary(list);
  const lines = [
    'گزارش انبارگردانی — انبارین',
    'تاریخ: ' + new Date().toLocaleString('fa-IR'),
    'اپراتور: ' + getOperatorName(),
    'انبار: ' + (settings.currentWarehouse || '—'),
    session ? 'جلسه: ' + session.id : 'بدون جلسه',
    '────────────────',
    `کل کالا: ${s.total}`,
    `شمارش‌شده: ${s.counted} (${s.progressPct}٪)`,
    `مانده: ${s.uncounted}`,
    `تطابق: ${s.match}`,
    `مغایرت: ${s.diffs} (اضافه: ${s.over} / کسری: ${s.under})`,
    `ارزش مغایرت تقریبی: ${s.valueDiff.toLocaleString('fa-IR')}`,
    `با عکس: ${s.withPhoto}`,
  ];
  if (isDoubleCount()) {
    const review = computeDoubleCountReview(list);
    lines.push(
      '────────────────',
      'بازبینی شمارش دومرحله‌ای',
      `تکمیل شمارش اول: ${review.phase1Count}`,
      `تکمیل شمارش دوم: ${review.phase2Count}`,
      `هر دو شمارش تکمیل: ${review.bothCount}`,
      `نیازمند بازبینی: ${review.reviewCount}`,
      `اختلاف دو شمارش: ${review.mismatchCount}`,
    );
  }
  return lines.join('\n');
}

export function exportDiffsExcel(): void {
  exportExcel(true);
}

export function exportFullExcel(): void {
  exportExcel(false);
}

/** خروجی مستقل کالاهای شمارش‌شده؛ فقط خواندن داده‌ها و بدون تغییر موجودی/شمارش. */
export function exportCountedProductsExcel(): void {
  const doubleCount = isDoubleCount();
  // در شمارش دومرحله‌ای، وجود حداقل یک مقدار ثبت‌شده در هر یک از دو مرحله
  // به معنی شمارش‌شدن کالا است؛ مقدار نهایی نمایشی، شمارش دوم و در نبود آن شمارش اول است.
  const list = activeList().filter((p) =>
    doubleCount ? p.countedQty != null || p.countedQty2 != null : p.countedQty != null
  );
  if (!list.length) {
    toast('در انبار انتخاب‌شده کالای شمارش‌شده‌ای برای خروجی وجود ندارد', 'info');
    return;
  }

  const headers = [
    'بارکد', 'کد کالا', 'نام', 'موجودی سیستم', 'تعداد شمارش‌شده', 'مغایرت', 'قیمت', 'محل',
    ...(doubleCount ? ['شمارش اول', 'شمارش دوم'] : []),
  ];
  const rows: unknown[][] = list.map((p) => {
    const effectiveCount = doubleCount
      ? (p.countedQty2 != null ? p.countedQty2 : p.countedQty)
      : p.countedQty;
    const diff = effectiveCount == null ? '' : effectiveCount - (p.systemQty ?? 0);
    return [
      String(p.code ?? '').trim(),
      String(p.sku ?? '').trim(),
      p.name ?? '',
      p.systemQty ?? 0,
      effectiveCount ?? '',
      diff,
      p.price ?? 0,
      p.location ?? '',
      ...(doubleCount ? [p.countedQty ?? '', p.countedQty2 ?? ''] : []),
    ];
  });

  try {
    const bytes = buildOfflineXlsx([{
      name: 'کالاهای شمارش‌شده',
      rows: [
        [`انبار: ${settings.currentWarehouse || 'همه'}`, `تاریخ تهیه: ${new Date().toLocaleString('fa-IR')}`],
        headers,
        ...rows,
      ],
    }]);
    const filename = `anbarin-counted-products-${dateStr()}.xlsx`;
    downloadFile(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      filename,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    toast(`خروجی کالاهای شمارش‌شده آماده شد؛ ${list.length} کالا`, 'success');
    logAudit('export_counted_products_xlsx', {
      warehouse: settings.currentWarehouse || 'همه',
      count: list.length,
      doubleCount,
    });
  } catch (error) {
    console.error('Counted products XLSX export failed', error);
    toast('ساخت فایل اکسل کالاهای شمارش‌شده ناموفق بود', 'error');
  }
}

export function exportAccountingDoc(kind: 'generic' | 'heloo' | 'sepidar' = 'generic'): void {
  const list = activeList().filter(
    (p) => p.countedQty != null && p.countedQty !== p.systemQty
  );
  if (!list.length) {
    toast('مغایرتی برای سند اصلاح نیست', 'error');
    return;
  }

  if (kind === 'heloo') {
    const rows = list.map((p) => ({
      کد: p.sku || p.code || '',
      نام: p.name,
      'موجودی سیستم': p.systemQty,
      شمارش: p.countedQty,
      اختلاف: (p.countedQty ?? 0) - p.systemQty,
      انبار: p.warehouse || settings.currentWarehouse || '',
    }));
    downloadFile(rowsToCSV(rows), `heloo-adjust-${dateStr()}.csv`, 'text/csv;charset=utf-8');
    toast('خروجی قالب هلو آماده شد', 'success');
    return;
  }

  if (kind === 'sepidar') {
    const rows = list.map((p) => ({
      ItemCode: p.sku || p.code || '',
      ItemName: p.name,
      SystemQty: p.systemQty,
      CountedQty: p.countedQty,
      Diff: (p.countedQty ?? 0) - p.systemQty,
      Warehouse: p.warehouse || settings.currentWarehouse || '',
      Location: p.location || '',
    }));
    downloadFile(rowsToCSV(rows), `sepidar-adjust-${dateStr()}.csv`, 'text/csv;charset=utf-8');
    toast('خروجی قالب سپیدار آماده شد', 'success');
    return;
  }

  const rows = list.map((p) => ({
    بارکد: p.code || '',
    کد: p.sku || '',
    نام: p.name,
    'موجودی سیستم': p.systemQty,
    شمارش: p.countedQty,
    اختلاف: (p.countedQty ?? 0) - p.systemQty,
    'قیمت واحد': p.price || 0,
    'ارزش اختلاف': ((p.countedQty ?? 0) - p.systemQty) * (p.price || 0),
    محل: p.location || '',
    انبار: p.warehouse || '',
    یادداشت: p.note || '',
  }));
  downloadFile(rowsToCSV(rows), `inventory-adjust-${dateStr()}.csv`, 'text/csv;charset=utf-8');
  toast('سند اصلاح موجودی دانلود شد', 'success');
}

export type AccountingTemplateKind = 'heloo' | 'sepidar';
type AccountingField = 'barcode' | 'name' | 'code' | 'systemQty' | 'countedQty' | 'diff' | 'unitPrice' | 'diffValue' | 'unit' | 'location';
const ACCOUNTING_FIELDS: Array<{ id: AccountingField; label: string }> = [
  { id: 'barcode', label: 'بارکد' },
  { id: 'name', label: 'نام کالا' },
  { id: 'code', label: 'کد کالا' },
  { id: 'systemQty', label: 'موجودی سیستم' },
  { id: 'countedQty', label: 'موجودی شمارش‌شده' },
  { id: 'diff', label: 'مغایرت' },
  { id: 'unitPrice', label: 'قیمت واحد' },
  { id: 'diffValue', label: 'ارزش مغایرت' },
  { id: 'unit', label: 'واحد کالا' },
  { id: 'location', label: 'محل کالا' },
];
const DEFAULT_ACCOUNTING_FIELDS: AccountingField[] = ACCOUNTING_FIELDS.map((f) => f.id);
const TEMPLATE_STORAGE_PREFIX = 'anbarin_accounting_template_v1_';

function getTemplate(kind: AccountingTemplateKind): AccountingField[] {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_PREFIX + kind);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((v): v is AccountingField => ACCOUNTING_FIELDS.some((f) => f.id === v));
        if (valid.length) return valid;
      }
    }
  } catch (e) { console.warn('Could not read accounting template', e); }
  return [...DEFAULT_ACCOUNTING_FIELDS];
}

export function initAccountingTemplateUI(): void {
  const target = document.getElementById('accountingTemplateTarget') as HTMLSelectElement | null;
  const fieldsHost = document.getElementById('accountingTemplateFields');
  if (!target || !fieldsHost || fieldsHost.dataset.initialized === '1') return;
  fieldsHost.dataset.initialized = '1';
  fieldsHost.innerHTML = ACCOUNTING_FIELDS.map((f) => `<label class="accounting-field-option" style="display:flex;align-items:center;gap:8px;padding:6px 2px"><input type="checkbox" data-accounting-field="${f.id}" checked><span>${f.label}</span></label>`).join('');

  const applyTemplate = () => {
    const selected = getTemplate(target.value as AccountingTemplateKind);
    fieldsHost.querySelectorAll<HTMLInputElement>('input[data-accounting-field]').forEach((el) => {
      el.checked = selected.includes(el.dataset.accountingField as AccountingField);
    });
  };
  target.addEventListener('change', applyTemplate);
  document.getElementById('btnSaveAccountingTemplate')?.addEventListener('click', () => {
    const chosen = Array.from(fieldsHost.querySelectorAll<HTMLInputElement>('input[data-accounting-field]:checked'))
      .map((el) => el.dataset.accountingField as AccountingField);
    if (!chosen.length) { toast('حداقل یک ستون را انتخاب کنید', 'error'); return; }
    try {
      localStorage.setItem(TEMPLATE_STORAGE_PREFIX + target.value, JSON.stringify(chosen));
      toast(`قالب ${target.value === 'heloo' ? 'هلو' : 'سپیدار'} ذخیره شد`, 'success');
      logAudit('save_accounting_template', { kind: target.value, fields: chosen });
    } catch (e) { console.error(e); toast('ذخیره قالب ناموفق بود', 'error'); }
  });
  document.getElementById('btnExportAccountingTemplate')?.addEventListener('click', () => {
    const chosen = Array.from(fieldsHost.querySelectorAll<HTMLInputElement>('input[data-accounting-field]:checked'))
      .map((el) => el.dataset.accountingField as AccountingField);
    if (!chosen.length) { toast('حداقل یک ستون را انتخاب کنید', 'error'); return; }
    exportConfiguredAccounting(target.value as AccountingTemplateKind, chosen);
  });
  applyTemplate();
}

function exportConfiguredAccounting(kind: AccountingTemplateKind, chosen: AccountingField[]): void {
  const list = activeList().filter((p) => p.countedQty != null);
  if (!list.length) { toast('کالای شمارش‌شده‌ای برای خروجی وجود ندارد', 'error'); return; }
  const labels: Record<AccountingField, string> = {
    barcode: 'بارکد', name: 'نام کالا', code: 'کد کالا', systemQty: 'موجودی سیستم',
    countedQty: 'موجودی شمارش‌شده', diff: 'مغایرت', unitPrice: 'قیمت واحد',
    diffValue: 'ارزش مغایرت', unit: 'واحد کالا', location: 'محل کالا',
  };
  const rows = list.map((p) => {
    const diff = (p.countedQty ?? 0) - (p.systemQty ?? 0);
    const values: Record<AccountingField, unknown> = {
      // Barcode is intentionally a string cell to preserve leading zeros.
      barcode: String(p.code ?? '').trim(),
      name: p.name ?? '',
      code: String(p.sku ?? p.code ?? '').trim(),
      systemQty: p.systemQty ?? 0,
      countedQty: p.countedQty ?? 0,
      diff,
      unitPrice: p.price ?? 0,
      diffValue: diff * (p.price ?? 0),
      unit: p.unit ?? '',
      location: p.location ?? '',
    };
    return chosen.map((field) => values[field]);
  });
  const headers = chosen.map((field) => labels[field]);
  const filename = `anbarin-${kind === 'heloo' ? 'heloo' : 'sepidar'}-custom-${dateStr()}.xlsx`;
  try {
    const bytes = buildOfflineXlsx([{ name: kind === 'heloo' ? 'خروجی هلو' : 'خروجی سپیدار', rows: [headers, ...rows] }]);
    downloadFile(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    toast(`فایل اکسل ساخته شد؛ ${list.length} کالا و ${chosen.length} ستون`, 'success');
    logAudit('export_accounting_custom_xlsx', { kind, count: list.length, fields: chosen });
  } catch (error) {
    console.error('Custom accounting XLSX export failed', error);
    toast('ساخت فایل اکسل ناموفق بود', 'error');
  }
}


export interface DoubleCountReview {
  phase1Count: number;
  phase2Count: number;
  bothCount: number;
  reviewCount: number;
  mismatchCount: number;
}

export function computeDoubleCountReview(list: Product[] = activeList()): DoubleCountReview {
  let phase1Count = 0, phase2Count = 0, bothCount = 0, reviewCount = 0, mismatchCount = 0;
  for (const p of list) {
    const has1 = p.countedQty != null;
    const has2 = p.countedQty2 != null;
    if (has1) phase1Count++;
    if (has2) phase2Count++;
    if (has1 && has2) {
      bothCount++;
      if (p.countedQty !== p.countedQty2) mismatchCount++;
    } else {
      reviewCount++;
    }
  }
  return { phase1Count, phase2Count, bothCount, reviewCount, mismatchCount };
}

export function exportDoubleCountMismatches(): void {
  if (!isDoubleCount()) {
    toast('شمارش دومرحله‌ای فعال نیست', 'info');
    return;
  }
  // Export incomplete items as well as unequal counts so an unfinished phase
  // cannot be mistaken for a clean reconciliation. Never overwrite either count.
  const list = activeList().filter((p) =>
    p.countedQty == null || p.countedQty2 == null || p.countedQty !== p.countedQty2
  );
  if (!list.length) {
    toast('همه کالاها در هر دو مرحله شمارش شده و برابر هستند', 'info');
    return;
  }
  const rows = list.map((p) => {
    const has1 = p.countedQty != null;
    const has2 = p.countedQty2 != null;
    return {
      بارکد: p.code || '',
      نام: p.name,
      'شمارش ۱': has1 ? p.countedQty : '',
      'شمارش ۲': has2 ? p.countedQty2 : '',
      اختلاف: has1 && has2 ? (p.countedQty2 as number) - (p.countedQty as number) : '',
      وضعیت: !has1 && !has2 ? 'هیچ‌کدام شمارش نشده' : !has1 ? 'شمارش اول ناقص' : !has2 ? 'شمارش دوم ناقص' : 'اختلاف دو شمارش',
      سیستم: p.systemQty,
      محل: p.location || '',
    };
  });
  downloadFile(rowsToCSV(rows), `double-count-review-${dateStr()}.csv`, 'text/csv;charset=utf-8');
  toast(`${list.length} کالا برای بازبینی خروجی گرفته شد`, 'success');
}





/** گردش مقداری اسناد تأییدشده؛ ارزش صرفاً برآوردی و با قیمت فعلی کالا است. */
export interface InventoryMovementSummary {
  kind: string;
  documentCount: number;
  totalQty: number;
  estimatedValue: number;
}
export function getInventoryMovementSummary(): InventoryMovementSummary[] {
  const kinds: Array<{ key: string; label: string }> = [
    { key: 'receipt', label: 'رسید' },
    { key: 'issue', label: 'حواله' },
    { key: 'adjustment', label: 'اصلاح موجودی' },
    { key: 'transfer', label: 'انتقال' },
  ];
  const currentWarehouse = settings.currentWarehouse || '';
  return kinds.map(({ key, label }) => {
    const docs = (inventoryDocs || []).filter((doc) =>
      doc.status === 'approved' && doc.kind === key &&
      (!currentWarehouse || doc.warehouse === currentWarehouse || doc.destinationWarehouse === currentWarehouse)
    );
    let totalQty = 0;
    let estimatedValue = 0;
    for (const doc of docs) {
      for (const line of (doc.lines || [])) {
        const product = products.find((p) => p.id === line.productId);
        const qty = Number(line.qty);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        totalQty += qty;
        estimatedValue += qty * Number(product?.price || 0);
      }
    }
    return { kind: label, documentCount: docs.length, totalQty, estimatedValue };
  });
}
export function renderInventoryMovementPanel(): string {
  const rows = getInventoryMovementSummary();
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
  const body = rows.map((r) => `<tr><td>${esc(r.kind)}</td><td>${formatFaNumber(r.documentCount)}</td><td>${formatFaNumber(r.totalQty)}</td><td>${formatFaNumber(Math.round(r.estimatedValue))}</td></tr>`).join('');
  const csv = rowsToCSV(rows.map((r) => ({
    نوع_سند: r.kind, تعداد_اسناد: r.documentCount, جمع_تعداد: r.totalQty,
    ارزش_برآوردی_با_قیمت_فعلی: Math.round(r.estimatedValue),
  })));
  return `<section class="report-panel-compact">
    <div class="report-compact-head"><strong>گردش اسناد</strong><span class="hint">فقط تأییدشده · ارزش برآوردی</span></div>
    <div class="table-wrap-compact"><table class="data-table data-table-compact"><thead><tr><th>نوع</th><th>اسناد</th><th>تعداد</th><th>ارزش</th></tr></thead><tbody>${body}</tbody></table></div>
    <button class="btn btn-secondary btn-sm" id="btnMovementSummaryCSV" style="margin-top:6px">CSV گردش</button>
    <textarea id="movementSummaryCSVData" hidden>${esc(csv)}</textarea>
  </section>`;
}

/** داشبورد فشرده یک‌صفحه‌ای: موجودی + پیشرفت انبارگردانی در یک شبکه */
export function renderManagementDashboard(): string {
  const list = activeList();
  const s = computeSummary(list);
  const alerts = getStockAlertRows();
  const totalQty = list.reduce((sum, p) => sum + Number(p.systemQty || 0), 0);
  const stockValue = list.reduce((sum, p) => sum + Number(p.systemQty || 0) * Number(p.price || 0), 0);
  const low = alerts.filter((r) => r.status.includes('کم‌موجود')).length;
  const over = alerts.filter((r) => r.status.includes('بیش‌موجود')).length;
  const expired = alerts.filter((r) => r.status.includes('منقضی‌شده')).length;
  const nearExpiry = alerts.filter((r) => r.status.includes('انقضای تا ۳۰ روز')).length;
  const money = (n: number) => formatFaNumber(Math.round(n));
  const wh = String(settings.currentWarehouse || 'همه انبارها').replace(/[&<>"']/g, '');
  return `<section class="report-compact-dash">
    <div class="report-compact-head">
      <strong>خلاصه انبارگردانی</strong>
      <span class="hint">${wh} · پیشرفت ${s.progressPct}٪</span>
    </div>
    <div class="stats-grid stats-grid-compact">
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.total)}</div><div class="stat-label">کل</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.counted)}</div><div class="stat-label">شمارش</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.uncounted)}</div><div class="stat-label">مانده</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.diffs)}</div><div class="stat-label">مغایرت</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.match)}</div><div class="stat-label">تطابق</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.over)}</div><div class="stat-label">اضافه</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(s.under)}</div><div class="stat-label">کسری</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(totalQty)}</div><div class="stat-label">موجودی</div></div>
      <div class="stat-card"><div class="stat-value">${money(stockValue)}</div><div class="stat-label">ارزش</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(low)}</div><div class="stat-label">کم‌موجود</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(over)}</div><div class="stat-label">بیش‌موجود</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(expired + nearExpiry)}</div><div class="stat-label">انقضا</div></div>
    </div>
    <p class="hint report-compact-foot">مغایرت ارزشی ≈ <strong>${s.valueDiff.toLocaleString('fa-IR')}</strong> · منقضی ${formatFaNumber(expired)} · نزدیک انقضا ${formatFaNumber(nearExpiry)}</p>
  </section>`;
}


export interface StockAlertRow {
  code: string; name: string; warehouse: string; location: string;
  quantity: number; min: number | null; max: number | null; expiry: string;
  status: string;
}

/** هشدارها بر اساس موجودی عملیاتی systemQty هستند؛ شمارش موقت مبنا نیست. */
export function getStockAlertRows(): StockAlertRow[] {
  const today = new Date();
  const horizon = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
  return activeList().map((p) => {
    const q = Number(p.systemQty ?? 0);
    const min = p.minQty == null ? null : Number(p.minQty);
    const max = p.maxQty == null ? null : Number(p.maxQty);
    const expiry = p.expiry || '';
    const expiryDate = expiry ? new Date(`${expiry}T00:00:00`) : null;
    const statuses: string[] = [];
    if (min != null && q < min) statuses.push('کم‌موجود');
    else if (min != null && min > 0 && q <= min * 1.2) statuses.push('نزدیک حداقل');
    if (max != null && q > max) statuses.push('بیش‌موجود');
    if (expiryDate && !Number.isNaN(expiryDate.getTime())) {
      if (expiryDate < new Date(today.getFullYear(), today.getMonth(), today.getDate())) statuses.push('منقضی‌شده');
      else if (expiryDate <= horizon) statuses.push('انقضای تا ۳۰ روز');
    }
    return { code: p.code || p.sku || '', name: p.name, warehouse: p.warehouse || 'انبار اصلی', location: p.location || '', quantity: q, min, max, expiry, status: statuses.join('، ') };
  }).filter((r) => !!r.status);
}

export function renderStockAlertsPanel(): string {
  const rows = getStockAlertRows();
  const count = (key: string) => rows.filter((r) => r.status.includes(key)).length;
  const escHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
  const shown = rows.slice(0, 25);
  const body = shown.map((r) => `<tr><td>${escHtml(r.name)}</td><td>${escHtml(r.code)}</td><td>${formatFaNumber(r.quantity)}</td><td>${escHtml(r.status)}</td></tr>`).join('');
  return `<section class="report-panel-compact">
    <div class="report-compact-head"><strong>هشدار موجودی</strong><span class="hint">${formatFaNumber(rows.length)} مورد · کم ${formatFaNumber(count('کم‌موجود'))} · انقضا ${formatFaNumber(count('انقضا'))}</span></div>
    <div class="actions report-actions-grid">
      <button class="btn btn-success btn-sm" id="btnStockAlertsExcel">Excel</button>
      <button class="btn btn-secondary btn-sm" id="btnStockAlertsPdf">چاپ</button>
    </div>
    ${rows.length
      ? `<div class="table-wrap-compact"><table class="data-table data-table-compact"><thead><tr><th>کالا</th><th>کد</th><th>موجودی</th><th>وضعیت</th></tr></thead><tbody>${body}</tbody></table></div>${rows.length > 25 ? `<p class="hint">نمایش ۲۵ از ${formatFaNumber(rows.length)} — بقیه در Excel</p>` : ''}`
      : '<p class="hint">هشداری نیست.</p>'}
  </section>`;
}

export function exportStockAlertsExcel(): void {
  const rows = getStockAlertRows();
  if (!rows.length) { toast('هشداری برای خروجی وجود ندارد', 'info'); return; }
  const data = [['نام کالا','کد کالا','انبار','محل','موجودی سیستم','حداقل','حداکثر','تاریخ انقضا','وضعیت'], ...rows.map(r => [r.name,r.code,r.warehouse,r.location,r.quantity,r.min ?? '',r.max ?? '',r.expiry,r.status])];
  try {
    const bytes = buildOfflineXlsx([{ name: 'هشدار موجودی', rows: data }]);
    downloadFile(new Blob([bytes], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), `stock-alerts-${dateStr()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    logAudit('export_stock_alerts_xlsx', {count: rows.length});
    toast(`خروجی ${rows.length} هشدار آماده شد`, 'success');
  } catch (e) { console.error(e); toast('ساخت فایل Excel ناموفق بود', 'error'); }
}

export async function printStockAlerts(): Promise<void> {
  const rows = getStockAlertRows();
  if (!rows.length) { toast('هشداری برای چاپ وجود ندارد', 'info'); return; }
  const size = await choosePaperSize({ mode: 'document', title: 'سایز چاپ هشدار موجودی' });
  if (!size) return;
  const escHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
  const rowsHtml = rows.map(r => `<tr><td>${escHtml(r.name)}</td><td>${escHtml(r.code)}</td><td>${escHtml(r.warehouse)}</td><td>${formatFaNumber(r.quantity)}</td><td>${r.min == null ? '—' : formatFaNumber(r.min)}</td><td>${escHtml(r.expiry || '—')}</td><td>${escHtml(r.status)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>گزارش هشدار موجودی انبارین</title><style>body{font-family:Tahoma,sans-serif;padding:16px;color:#18352b}h2{color:#176b4b}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:7px;text-align:right;font-size:12px}th{background:#e7f2ec}</style></head><body><h2>گزارش هشدار موجودی انبارین</h2><p>تاریخ: ${new Date().toLocaleString('fa-IR')} | تعداد هشدار: ${rows.length}</p><table><thead><tr><th>کالا</th><th>کد</th><th>انبار</th><th>موجودی</th><th>حداقل</th><th>انقضا</th><th>وضعیت</th></tr></thead><tbody>${rowsHtml}</tbody></table></body></html>`;
  printHtmlSafely(html, 'هشدار موجودی', {
    paperSize: size,
    onSuccess: () => toast('پنجره چاپ باز شد', 'success'),
    onError: () => toast('باز کردن چاپ ناموفق بود', 'error'),
  });
  logAudit('print_stock_alerts', { count: rows.length, paperSize: size });
}

export function exportStockAlerts(): void {
  const list = activeList().filter((p) => {
    const q = p.countedQty ?? p.systemQty ?? 0;
    if (p.minQty != null && q < p.minQty) return true;
    if (p.maxQty != null && q > p.maxQty) return true;
    return false;
  });
  if (!list.length) {
    toast('هشدار موجودی نیست', 'info');
    return;
  }
  const rows = list.map((p) => {
    const q = p.countedQty ?? p.systemQty ?? 0;
    let status = '';
    if (p.minQty != null && q < p.minQty) status = 'کم‌موجود';
    if (p.maxQty != null && q > p.maxQty) status = status ? status + '+بیش‌موجود' : 'بیش‌موجود';
    return {
      بارکد: p.code || '',
      نام: p.name,
      موجودی: q,
      حداقل: p.minQty ?? '',
      حداکثر: p.maxQty ?? '',
      وضعیت: status,
    };
  });
  downloadFile(rowsToCSV(rows), `stock-alerts-${dateStr()}.csv`, 'text/csv;charset=utf-8');
  toast(`${list.length} هشدار دانلود شد`, 'success');
}

export function copyTextReport(): void {
  const text = buildTextReport();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast('گزارش کپی شد', 'success'),
      () => fallbackCopy(text)
    );
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast('گزارش کپی شد', 'success');
  } catch {
    toast('کپی ممکن نشد', 'error');
  }
  document.body.removeChild(ta);
}



/** صفحه‌بندی تاریخچه محلی عملیات؛ سوابق ذخیره‌شده دست‌نخورده می‌مانند. */
let activityHistoryPage = 0;
let activityHistoryPageSize = 10;

export function setActivityHistoryPage(page: number): void {
  const totalPages = Math.max(1, Math.ceil((auditLog || []).length / activityHistoryPageSize));
  activityHistoryPage = Math.max(0, Math.min(totalPages - 1, Math.trunc(page) || 0));
}

export function setActivityHistoryPageSize(size: number): void {
  activityHistoryPageSize = [10, 25, 50, 100].includes(size) ? size : 10;
  activityHistoryPage = 0;
}

export function renderActivityHistoryPanel(): string {
  const allEntries = [...(auditLog || [])].slice(-100).reverse();
  const total = allEntries.length;
  const totalPages = Math.max(1, Math.ceil(total / activityHistoryPageSize));
  activityHistoryPage = Math.min(activityHistoryPage, totalPages - 1);
  const start = activityHistoryPage * activityHistoryPageSize;
  const entries = allEntries.slice(start, start + activityHistoryPageSize);
  const from = total ? start + 1 : 0;
  const to = Math.min(start + entries.length, total);
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
  const detailText = (detail: Record<string, unknown> | undefined) => {
    if (!detail) return '';
    try { return Object.entries(detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' | '); }
    catch { return ''; }
  };
  const csvRows = allEntries.map((e) => ({
    زمان: e.ts || '', کاربر: e.operator || 'نامشخص',
    عملیات: e.action || '', جزئیات: detailText(e.detail),
  }));
  const body = entries.length ? entries.map((e) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.operator || 'نامشخص')}</td><td>${esc(e.action)}</td><td style="white-space:normal;max-width:260px">${esc(detailText(e.detail))}</td></tr>`).join('') :
    '<tr><td colspan="4">هنوز رویدادی در تاریخچه ثبت نشده است.</td></tr>';
  const csv = rowsToCSV(csvRows);
  return `<section class="report-panel-compact">
    <div class="report-compact-head">
      <strong>تاریخچه</strong>
      <span class="hint">${formatFaNumber(from)}–${formatFaNumber(to)} از ${formatFaNumber(total)}</span>
    </div>
    <div class="report-history-tools">
      <label class="hint">در صفحه
        <select id="activityHistoryPageSize" class="search-input" style="width:auto;min-width:64px;padding:4px 6px;display:inline-block">
          ${[10,25,50].map((n) => `<option value="${n}" ${activityHistoryPageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
      <span>
        <button class="btn btn-secondary btn-sm" id="btnActivityHistoryPrev" data-page="${activityHistoryPage - 1}" ${activityHistoryPage <= 0 ? 'disabled' : ''}>قبلی</button>
        <button class="btn btn-secondary btn-sm" id="btnActivityHistoryNext" data-page="${activityHistoryPage + 1}" ${activityHistoryPage >= totalPages - 1 ? 'disabled' : ''}>بعدی</button>
      </span>
    </div>
    <div class="table-wrap-compact"><table class="data-table data-table-compact"><thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>جزئیات</th></tr></thead><tbody>${body}</tbody></table></div>
    <button class="btn btn-secondary btn-sm" id="btnActivityHistoryCSV" style="margin-top:6px">CSV تاریخچه</button>
    <textarea id="activityHistoryCSVData" hidden>${esc(csv)}</textarea>
  </section>`;
}

/** آمار در داشبورد فشرده ادغام شده؛ برای سازگاری خالی برمی‌گردد */
export function renderReportHTML(): string {
  return '';
}


export interface CardexRow {
  date: string; action: string; reference: string; before: number | string;
  change: number | string; after: number | string; operator: string; note: string;
}

/** سوابق قابل اتکا از لاگ موجود؛ برای قبل از ثبت لاگ، گردش فرضی ساخته نمی‌شود. */
export function getProductCardex(productId: string): CardexRow[] {
  const p = products.find((item) => item.id === productId);
  if (!p) return [];
  return auditLog
    .filter((entry) => {
      const d = entry.detail || {};
      return String(d.id || '') === productId && ['count', 'count2', 'undo'].includes(entry.action);
    })
    .map((entry) => {
      const d = entry.detail || {};
      const prev = typeof d.prev === 'number' ? d.prev : null;
      const next = typeof d.next === 'number' ? d.next :
        typeof d.restored === 'number' ? d.restored : null;
      const phase = Number(d.phase || (entry.action === 'count2' ? 2 : 1));
      const delta = prev !== null && next !== null ? next - prev : '';
      return {
        date: entry.ts ? new Date(entry.ts).toLocaleString('fa-IR') : '—',
        action: entry.action === 'count2' ? `شمارش ${phase === 1 ? 'اول' : 'دوم'}` : entry.action === 'undo' ? 'بازگردانی' : 'شمارش اول',
        reference: String(d.id || ''), before: prev ?? 'نامشخص', change: delta,
        after: next ?? 'نامشخص', operator: entry.operator || '—', note: 'ثبت‌شده در سوابق فعالیت',
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date, 'fa'));
}

export function renderCardex(productId: string): void {
  const host = document.getElementById('cardexResult');
  if (!host) return;
  const p = products.find((item) => item.id === productId);
  if (!p) { host.textContent = 'برای مشاهده کاردکس، یک کالا انتخاب کنید.'; return; }
  const rows = getProductCardex(productId);
  host.innerHTML = '';
  const title = document.createElement('h3');
  title.textContent = `${p.name} — کاردکس کالا`;
  host.appendChild(title);
  const meta = document.createElement('p');
  meta.className = 'hint';
  meta.textContent = `کد: ${p.code || p.sku || '—'} | انبار: ${p.warehouse || 'انبار اصلی'} | موجودی سیستم فعلی: ${p.systemQty} ${p.unit || ''}`;
  host.appendChild(meta);
  const notice = document.createElement('p');
  notice.className = 'hint';
  notice.textContent = 'توجه: فقط رویدادهایی نمایش داده می‌شوند که در سوابق فعالیت ذخیره شده‌اند؛ سوابق قبل از فعال‌شدن ثبت رویداد ممکن است کامل نباشند.';
  host.appendChild(notice);
  if (!rows.length) {
    const empty = document.createElement('p'); empty.textContent = 'برای این کالا سابقه گردش قابل اتکایی در گزارش فعالیت پیدا نشد.'; host.appendChild(empty); return;
  }
  const table = document.createElement('div'); table.className = 'table-wrap';
  const t = document.createElement('table'); t.className = 'data-table';
  const headers = ['تاریخ', 'عملیات', 'موجودی قبل', 'تغییر', 'مقدار ثبت‌شده', 'کاربر'];
  const thead = document.createElement('thead'); const hr = document.createElement('tr');
  headers.forEach((h) => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); }); thead.appendChild(hr); t.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((r) => { const tr = document.createElement('tr'); [r.date,r.action,String(r.before),String(r.change),String(r.after),r.operator].forEach((v) => { const td=document.createElement('td'); td.textContent=v; tr.appendChild(td); }); tbody.appendChild(tr); });
  t.appendChild(tbody); table.appendChild(t); host.appendChild(table);
}

export function exportProductCardexExcel(productId: string): void {
  const p = products.find((item) => item.id === productId);
  if (!p) { toast('ابتدا کالا را انتخاب کنید', 'error'); return; }
  const rows = getProductCardex(productId).map((r) => ({ تاریخ:r.date, عملیات:r.action, 'موجودی قبل':r.before, تغییر:r.change, 'مقدار ثبت‌شده':r.after, کاربر:r.operator, توضیحات:r.note }));
  const data = rows.length ? rows : [{ پیام: 'برای این کالا سابقه گردش ثبت‌شده‌ای وجود ندارد' }];
  const bytes = buildOfflineXlsx([{ name: 'کاردکس کالا', rows: [Object.keys(data[0]), ...data.map((r) => Object.values(r))] }]);
  downloadFile(new Blob([bytes], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}), `cardex-${dateStr()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  logAudit('export_product_cardex', { id: productId, count: rows.length });
  toast('فایل اکسل کاردکس آماده شد', 'success');
}

export async function printProductCardex(productId: string): Promise<void> {
  const p = products.find((item) => item.id === productId);
  if (!p) { toast('ابتدا کالا را انتخاب کنید', 'error'); return; }
  const size = await choosePaperSize({ mode: 'document', title: 'سایز چاپ کاردکس' });
  if (!size) return;
  const rows = getProductCardex(productId);
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const body = rows.length
    ? rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.action)}</td><td>${esc(r.before)}</td><td>${esc(r.change)}</td><td>${esc(r.after)}</td><td>${esc(r.operator)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">برای این کالا سابقه گردش ثبت‌شده‌ای وجود ندارد.</td></tr>';
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>کاردکس ${esc(p.name)}</title><style>
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#17231e;font-family:Tahoma,Arial,sans-serif;direction:rtl;font-size:11px}
    h2{font-size:18px;margin:0 0 12px;color:#176b4b}.meta{padding:9px 11px;border:1px solid #cbd5d0;border-radius:6px;margin-bottom:10px;line-height:2}.hint{color:#555;font-size:10px;line-height:1.8;margin:8px 0}
    table{width:100%;border-collapse:collapse;margin-top:12px;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th,td{border:1px solid #aebbb4;padding:7px 5px;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#e8f3ed;font-weight:700}tbody tr:nth-child(even){background:#f7faf8}.empty{text-align:center;padding:18px}
    .footer{margin-top:12px;text-align:left;color:#666;font-size:9px}@media screen{body{padding:18px;max-width:900px;margin:auto}}@media print{body{padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><h2>کاردکس کالا — انبارین پرو</h2><div class="meta"><strong>${esc(p.name)}</strong><br>کد: ${esc(p.code||p.sku||'—')} | انبار: ${esc(p.warehouse||'انبار اصلی')}<br>موجودی سیستم فعلی: ${esc(p.systemQty)} ${esc(p.unit||'')}</div><p class="hint">سوابق فقط شامل رویدادهای ثبت‌شده در گزارش فعالیت است؛ ممکن است تاریخچه قدیمی کامل نباشد.</p><table><thead><tr><th>تاریخ</th><th>عملیات</th><th>موجودی قبل</th><th>تغییر</th><th>موجودی بعد</th><th>کاربر</th></tr></thead><tbody>${body}</tbody></table><div class="footer">تاریخ تهیه گزارش: ${esc(new Date().toLocaleString('fa-IR'))}</div></body></html>`;

  printHtmlSafely(html, `کاردکس-${p.code || p.id}`, {
    paperSize: size,
    onSuccess: () => toast('پنجره چاپ باز شد؛ برای PDF گزینه ذخیره به‌صورت PDF را انتخاب کنید', 'success'),
    onError: () => toast('باز کردن چاپ ناموفق بود', 'error'),
  });
  logAudit('print_product_cardex', { id: productId, count: rows.length, paperSize: size });
}
