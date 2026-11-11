/**
 * نقطه ورود برنامه انبارین
 */

import './styles/main.css';
import {
  bootState,
  products,
  settings,
  getCountStats,
  storageBackend,
  session,
} from './modules/state';
import { toast, showPage, loadTheme, bindThemeControls } from './modules/ui';
import { findProductByCode } from './modules/state';
import { initLocalAuth } from './modules/local-auth';
import { initExternalAutoBackupScheduler, tryRecoverFromExternalBackup, getAutoBackupLocationStatus, pickAutoBackupFolder, clearAutoBackupFolder, writeExternalAutoBackup, getGoogleDriveAccountStatus, connectGoogleDriveAccount, disconnectGoogleDriveAccount } from './modules/device-auto-backup';
import { initAccountingUI } from './modules/accounting-ui';
import { initAccountingCommerceUI } from './modules/accounting-commerce-ui';
import { initAccountingReportsUI } from './modules/accounting-reports';
import { renderDataHealth } from './modules/data-health';
import { initUnifiedDatePickers } from './modules/date-picker';

// پیام نهایی ذخیره‌سازی فایل در اپ اندروید (پس از انتخاب پوشه و نوشتن موفق).
window.addEventListener('anbarin:file-saved', (event: Event) => {
  const detail = (event as CustomEvent<{ filename?: string }>).detail;
  toast(`گزارش با موفقیت ذخیره شد: ${detail?.filename || 'فایل'}`, 'success');
});
window.addEventListener('anbarin:file-save-error', () => {
  toast('ذخیره گزارش ناموفق بود؛ دوباره تلاش کنید.', 'error');
});
import { formatFaNumber, qtyEqual } from './utils/helpers';
import { initInventoryDocumentsUI } from './modules/inventory-documents';
import { enhanceSelectWithSearch, refreshSearchableSelect } from './modules/searchable-select';
import {
  initScanner,
  openScanner,
  closeScanner,
  submitManualBarcode,
  toggleTorch,
  restartCamera,
  getScannerCapabilities,
  type ScanResult,
} from './modules/scanner';
import {
  handleScannedCode,
  confirmQtyModal,
  closeQtyModal,
  openQtyModal,
  adjustQtyModal,
  setQtyModalToSystem,
  updateQtyModalDiff,
  undoLast,
  canUndo,
  isQtyModalOpen,
  canCount,
  setCountChangeListener,
} from './modules/count';
import {
  exportExcel,
  exportCSV,
  exportJSON,
  processImportFile,
  loadSheetJS,
} from './modules/import-export';
import {
  getSessionLabel,
  actionStartSession,
  actionCloseSession,
  actionClearCounts,
  actionZeroUncounted,
  applySettingsFromForm,
  fillSettingsForm,
  actionSetPhase,
  bindBusinessLogoControls,
} from './modules/session-settings';
import {
  renderReportHTML,
  copyTextReport,
  exportAccountingDoc,
  exportDoubleCountMismatches,
  exportStockAlerts,
  renderStockAlertsPanel,
  renderManagementDashboard,
  renderInventoryMovementPanel,
  renderActivityHistoryPanel,
  setActivityHistoryPage,
  setActivityHistoryPageSize,
  exportStockAlertsExcel,
  printStockAlerts,
  exportDiffsExcel,
  exportCountedProductsExcel,
  initAccountingTemplateUI,
  renderCardex,
  exportProductCardexExcel,
  printProductCardex,
} from './modules/reports';
import {
  captureProductPhoto,
  showPhotoModal,
  exportPhotosPack,
  importPhotosPack,
  setPhotoChangeListener,
  countPhotos,
} from './modules/photos';
import {
  exportTeamSyncPack,
  importTeamSyncPack,
  exportPartialCount,
  copyTeamSessionCode,
  joinTeamSession,
  exportTeamConflictReport,
  refreshTeamSyncUI,
  saveTeamOnlineConfig,
  saveTeamSyncMode,
  syncTeamOnlineNow,
  refreshTeamOnlineStatus,
  initializeTeamOnlineSync,
} from './modules/team-sync';
import {
  openProductModal,
  offerAddProduct,
  setProductsChangeListener,
} from './modules/products-ui';
import {
  renderAuditList,
  exportAuditCSV,
  clearAuditLog,
  ensureAuditStyles,
} from './modules/audit-ui';
import {
  printLabelsBulk,
  applyCountsToSystem,
  resetCountsToSystem,
} from './modules/labels';
import {
  updateLicenseUI,
  activateLicenseFromInput,
  deactivateLicense,
  requirePremium,
  getDeviceId,
  saveStoredLicense
} from './modules/license';
import { activateOfflineLicenseFile } from './modules/offline-license';
import { applyLicenseModuleUI, moduleForPage, requireModule, describeActiveModules } from './modules/license-modules';
import {
  filterProductsAdvanced,
  setLocationFilter,
  locationFilter,
  fillLocationSelect,
  applyRoleUI,
  guardWrite,
} from './modules/filters-roles';
import { createVirtualList, type VirtualListHandle } from './modules/virtual-list';
import type { Product } from './types';

let productsVList: VirtualListHandle | null = null;
let countVList: VirtualListHandle | null = null;
let productSearchQuery = '';
let countFilter: 'all' | 'counted' | 'uncounted' | 'diff' = 'all';

function getFilteredProducts(): Product[] {
  return filterProductsAdvanced({
    query: productSearchQuery,
    location: locationFilter,
  });
}

function getFilteredCountList(): Product[] {
  return filterProductsAdvanced({
    query: productSearchQuery,
    location: locationFilter,
    countFilter,
  });
}

function renderProductRow(p: Product): HTMLElement {
  const el = document.createElement('div');
  el.className = 'vrow';
  const counted =
    p.countedQty != null
      ? `<span class="vrow-badge">شمارش: ${formatFaNumber(p.countedQty)}</span>`
      : '';
  el.innerHTML = `
    <div class="vrow-main">
      <div class="vrow-name"></div>
      <div class="vrow-meta"></div>
    </div>
    <div class="vrow-side">
      <span class="vrow-sys">${formatFaNumber(p.systemQty)}</span>
      ${counted}
    </div>
  `;
  (el.querySelector('.vrow-name') as HTMLElement).textContent = p.name;
  (el.querySelector('.vrow-meta') as HTMLElement).textContent =
    `${p.code || p.sku || '—'}${p.location ? ' · 📍 ' + p.location : ''}`;
  el.style.cursor = 'pointer';
  el.addEventListener('click', () => openProductModal(p.id));
  return el;
}

function renderCountRow(p: Product): HTMLElement {
  const el = document.createElement('div');
  el.className = 'vrow vrow-count';
  el.dataset.id = p.id;
  const c = p.countedQty;
  let diffHtml = '';
  if (c != null && !qtyEqual(c, p.systemQty)) {
    const d = c - (Number(p.systemQty) || 0);
    const color = d > 0 ? 'var(--success)' : 'var(--danger)';
    diffHtml = `<span class="vrow-diff" style="color:${color}">${d > 0 ? '+' : ''}${formatFaNumber(d)}</span>`;
  }
  const photoIcon = p.photo ? ' 📷' : '';
  el.innerHTML = `
    <div class="vrow-main">
      <div class="vrow-name"></div>
      <div class="vrow-meta"></div>
    </div>
    <div class="vrow-side">
      <span class="vrow-count-val">${c == null ? '—' : formatFaNumber(c)}</span>
      ${diffHtml}
    </div>
  `;
  (el.querySelector('.vrow-name') as HTMLElement).textContent = p.name + photoIcon;
  (el.querySelector('.vrow-meta') as HTMLElement).textContent =
    `${p.code || p.sku || '—'} · سیستم: ${formatFaNumber(p.systemQty)}`;
  el.addEventListener('click', (ev) => {
    // double-purpose: long-press style via alt or if photo exists open modal
    if (p.photo || (ev as MouseEvent).altKey) {
      showPhotoModal(p.id);
    }
  });
  return el;
}

function setupVirtualLists() {
  const prodBox = document.getElementById('productsVList');
  if (prodBox) {
    productsVList?.destroy();
    productsVList = createVirtualList<Product>({
      container: prodBox,
      rowHeight: 64,
      overscan: 8,
      getItems: getFilteredProducts,
      renderRow: (p) => renderProductRow(p),
      getKey: (p) => p.id,
    });
  }

  const countBox = document.getElementById('countVList');
  if (countBox) {
    countVList?.destroy();
    countVList = createVirtualList<Product>({
      container: countBox,
      rowHeight: 68,
      overscan: 8,
      getItems: getFilteredCountList,
      renderRow: (p) => renderCountRow(p),
      getKey: (p) => p.id,
    });
  }
}

function refreshLists() {
  fillLocationSelect();
  fillLocationSelect('locationFilterSelectProducts');
  productsVList?.refresh();
  countVList?.refresh();
  const pc = document.getElementById('productCount');
  if (pc) pc.textContent = formatFaNumber(getFilteredProducts().length);
  const cc = document.getElementById('countListCount');
  if (cc) cc.textContent = formatFaNumber(getFilteredCountList().length);
}

async function bootApp() {
  try {
    loadTheme();
    let source = await bootState();
    console.log('[Anbarin] boot source:', source, '| products:', products.length);

    // اگر داده داخلی خالی است، از پشتیبان Documents/AnbarinBackups بازیابی پیشنهاد می‌شود
    if (source === 'empty' || products.length === 0) {
      const recovered = await tryRecoverFromExternalBackup();
      if (recovered === 'restored') {
        source = await bootState();
      }
    }

    renderShell();
    initLocalAuth();
    try { applyLicenseModuleUI(); } catch { /* ignore */ }
    initExternalAutoBackupScheduler();
    initScannerModule();
    await initAccountingUI();
    await initAccountingCommerceUI();
    await initAccountingReportsUI();
    setCountChangeListener(() => {
      updateHeader();
      updateUndoBtn();
      refreshLists();
    });
    updateHeader();
    updateCapsInfo();
    updateUndoBtn();
    fillSettingsForm();
    bindBusinessLogoControls();
    updateRolePreview();
    refreshLists();
    loadSheetJS().then((ok) => console.log('[Anbarin] SheetJS:', ok));

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(
        (r) => console.log('[Anbarin] SW registered', r.scope),
        (e) => console.warn('[Anbarin] SW failed', e)
      );
    }

    if (source === 'localStorage-migrated') {
      toast('داده‌ها به حافظه امن (IndexedDB) منتقل شد', 'success');
    }
    // پیام خوش‌آمد / راهنمای کالا فقط بعد از ورود موفق نشان داده می‌شود (نه همزمان با برگه ساخت کاربر)
    window.addEventListener('anbarin:auth-ready', ((ev: Event) => {
      const detail = (ev as CustomEvent<{ isFirstAccount?: boolean; name?: string }>).detail || {};
      let justRestored = 0;
      try { justRestored = Number(sessionStorage.getItem('anbarin_just_restored_external') || 0); } catch { justRestored = 0; }
      if (detail.isFirstAccount) {
        toast(`خوش آمدید${detail.name ? ' ' + detail.name : ''} — حساب مدیر ساخته شد`, 'success');
        if (products.length === 0 && justRestored <= 0) {
          setTimeout(() => toast('قدم بعد: از بخش کالاها، کالا اضافه یا فایل اکسل وارد کنید', 'info'), 900);
        }
        return;
      }
      // اگر همین لحظه از پشتیبان بیرونی بازیابی شده، پیام «کالا خالی» نشان نده
      if (products.length === 0 && justRestored <= 0) {
        toast('هنوز کالایی ثبت نشده — از بخش کالاها شروع کنید', 'info');
      }
      try { sessionStorage.removeItem('anbarin_just_restored_external'); } catch { /* ignore */ }
    }) as EventListener, { once: false });
  } catch (err) {
    console.error('bootApp failed', err);
    toast('خطا در بارگذاری داده‌ها', 'error');
  }
}

function initScannerModule() {
  initScanner({
    containerId: 'scanner-container',
    getSettings: () => settings,
    canScan: () => !!(window as any).__anbarinInvoiceScanActive || canCount(),
    isQtyModalOpen: () => isQtyModalOpen(),
    onScan: (result: ScanResult) => {
      if ((window as any).__anbarinInvoiceScanActive) {
        window.dispatchEvent(new CustomEvent('anbarin:invoice-barcode-scan', { detail: { code: result.code } }));
        return;
      }
      handleScannedCode(result.code, {
        onNotFound: (code) =>
          offerAddProduct(code, {
            onSaved: (productId) => {
              const p = products.find((x) => x.id === productId);
              if (p) openQtyModal(p);
            },
          }),
      });
      const info = document.getElementById('lastScanInfo');
      if (info) {
        const product = findProductByCode(result.code);
        info.textContent = product ? `کالای انتخاب‌شده: ${product.name}` : `کالایی با بارکد ${result.code} پیدا نشد`;
      }
    },
    onFieldFill: (fieldId, code) => {
      const el = document.getElementById(fieldId) as HTMLInputElement | null;
      if (el) el.value = code;
    },
  });
}

function renderShell() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <header>
      <div class="header-top">
        <div class="logo-area">
          <img class="brand-logo" src="./logo.png" alt="لوگوی انبارین" />
          <div class="brand-title"><strong>انبارین</strong>
          <span class="version">v1.5.16</span>
          <span class="role-badge" id="roleBadge">—</span></div>
        </div>
        <div class="header-stats" id="headerStats"></div>
      </div>
    </header>

    <main>
      <section class="page active" id="page-count">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
            <h2 style="margin:0">شمارش انبار</h2>
            <button class="btn btn-sm btn-secondary" id="undoBtn" disabled title="برگشت آخرین عمل">↩ Undo</button>
          </div>
          <p class="hint" id="sessionHint">—</p>
          <div id="statsBox" class="stats-grid"></div>

          <div id="phaseBar" class="phase-bar" style="display:none;margin-top:10px">
            <button type="button" class="filter-chip" data-phase="1">شمارش اول</button>
            <button type="button" class="filter-chip" data-phase="2">شمارش دوم</button>
          </div>

          <div class="session-bar" id="sessionBar">
            <span id="sessionLabel" class="hint">—</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-sm btn-primary" id="btnStartSession">جلسه جدید</button>
              <button class="btn btn-sm btn-secondary" id="btnCloseSession">بستن جلسه</button>
            </div>
          </div>

          <div class="actions" style="margin-top:16px">
            <button class="btn btn-primary" id="btnOpenScanner">📷 باز کردن اسکنر</button>
            <button class="btn btn-secondary" id="btnQuickCount">⚡ شمارش سریع (+۱)</button>
            <button class="btn btn-secondary" id="btnTakePhoto">🖼 عکس کالای آخر</button>
          </div>
          <p class="hint" id="lastScanInfo" style="margin-top:8px"></p>
          <p class="hint" id="btStatus" style="margin-top:4px;direction:ltr;text-align:left"></p>

          <div style="margin-top:16px">
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              <button type="button" class="filter-chip active" data-cf="all">همه</button>
              <button type="button" class="filter-chip" data-cf="counted">شمارش‌شده</button>
              <button type="button" class="filter-chip" data-cf="uncounted">مانده</button>
              <button type="button" class="filter-chip" data-cf="diff">مغایرت</button>
            </div>
            <input type="search" id="searchCount" placeholder="جستجو در شمارش..." class="search-input" />
            <select id="locationFilterSelect" class="search-input" style="margin-top:8px">
              <option value="">همه محل‌ها</option>
            </select>
            <p class="hint" style="margin-top:6px">نمایش: <strong id="countListCount">0</strong></p>
            <div id="countVList" class="vlist"></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-products">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <h2 style="margin:0">لیست کالاها</h2>
            <button class="btn btn-sm btn-primary" id="btnAddProduct">＋ کالا</button>
          </div>
          <p class="hint" style="margin-top:8px">نمایش: <strong id="productCount">0</strong></p>
          <input type="search" id="searchProducts" placeholder="جستجو نام / بارکد / محل..." class="search-input" style="margin-top:10px" />
          <select id="locationFilterSelectProducts" class="search-input" style="margin-top:8px">
            <option value="">همه محل‌ها</option>
          </select>
          <div id="productsVList" class="vlist vlist-tall" style="margin-top:12px"></div>
        </div>
      </section>

      <section class="page page-reports-compact" id="page-reports">
        <div class="card report-page-card">
          <h2 style="margin:0 0 8px">گزارش انبارگردانی</h2>
          <div id="managementDashboard"></div>
          <div id="reportSummary"></div>
          <div class="actions report-actions-grid" style="margin-top:10px">
            <button class="btn btn-primary btn-sm" id="btnCopyReport">کپی خلاصه</button>
            <button class="btn btn-success btn-sm" id="btnExportDiffs">اکسل مغایرت</button>
            <button class="btn btn-success btn-sm" id="btnExportCountedProducts">اکسل شمارش</button>
            <button class="btn btn-secondary btn-sm" id="btnDoubleDiff">اختلاف ۱و۲</button>
            <button class="btn btn-secondary btn-sm" id="btnStockAlerts">هشدار موجودی</button>
            <button class="btn btn-secondary btn-sm" id="btnPrintLabels">چاپ لیبل</button>
            <button class="btn btn-secondary btn-sm" id="btnAccGeneric">سند اصلاح</button>
            <button class="btn btn-secondary btn-sm" id="btnAccHeloo">قالب هلو</button>
            <button class="btn btn-secondary btn-sm" id="btnAccSepidar">قالب سپیدار</button>
          </div>
          <details class="report-fold">
            <summary>اسناد انبار</summary>
            <p class="hint">پیش‌نویس → بعد از تأیید روی موجودی اثر می‌گذارد.</p>
            <div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin-top:6px">
              <label>نوع سند<select id="invDocKind" class="search-input"><option value="receipt">رسید</option><option value="issue">حواله</option><option value="adjustment">اصلاح</option><option value="transfer">انتقال</option></select></label>
              <label>کالا<select id="invDocProduct" class="search-input"><option value="">انتخاب...</option></select></label>
              <label>مقدار<input id="invDocQty" class="search-input" type="number" min="0.0001" step="any" placeholder="مقدار" /></label>
              <label id="invDocDestinationWrap" hidden>مقصد<select id="invDocDestination" class="search-input"><option value="">انبار مقصد</option></select></label>
            </div>
            <label style="display:block;margin-top:6px">علت<input id="invDocReason" class="search-input" placeholder="علت ثبت سند" /></label>
            <div class="actions report-actions-grid" style="margin-top:8px">
              <button class="btn btn-primary btn-sm" id="btnCreateInvDoc">پیش‌نویس</button>
              <button class="btn btn-secondary btn-sm" id="btnExportInventoryDocs">CSV اسناد</button>
            </div>
            <div id="inventoryDocumentsList" style="margin-top:8px"></div>
          </details>
          <details class="report-fold">
            <summary>کاردکس کالا</summary>
            <select id="cardexProductSelect" class="search-input" style="width:100%;margin:6px 0"><option value="">انتخاب کالا...</option></select>
            <div class="actions report-actions-grid">
              <button class="btn btn-success btn-sm" id="btnCardexExcel">Excel</button>
              <button class="btn btn-secondary btn-sm" id="btnCardexPdf">چاپ</button>
            </div>
            <div id="cardexResult" style="margin-top:8px" class="hint">کالا را انتخاب کنید.</div>
          </details>
          <details class="report-fold">
            <summary>هشدار · گردش · تاریخچه</summary>
            <div id="stockAlertsPanel"></div>
            <div id="inventoryMovementPanel"></div>
            <div id="activityHistoryPanel"></div>
          </details>
          <details class="report-fold">
            <summary>تنظیم ستون اکسل هلو / سپیدار</summary>
            <p class="hint" style="margin:6px 0">خروجی فقط کالاهای شمارش‌شده.</p>
            <select id="accountingTemplateTarget" class="search-input" style="margin:4px 0 8px;width:100%">
              <option value="heloo">هلو</option><option value="sepidar">سپیدار</option>
            </select>
            <div id="accountingTemplateFields" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:2px"></div>
            <div class="actions report-actions-grid" style="margin-top:8px">
              <button class="btn btn-secondary btn-sm" id="btnSaveAccountingTemplate" type="button">ذخیره قالب</button>
              <button class="btn btn-primary btn-sm" id="btnExportAccountingTemplate" type="button">خروجی اکسل</button>
            </div>
          </details>
          <div class="actions report-actions-grid" style="margin-top:10px">
            <button class="btn btn-primary btn-sm" id="btnApplySystem">اعمال شمارش → سیستم</button>
            <button class="btn btn-secondary btn-sm" id="btnResetToSystem">شمارش = سیستم</button>
          </div>
        </div>
      </section>

      <section class="page" id="page-accounting">
        <div class="card">
          <h2>حسابداری حرفه‌ای</h2>
          <p class="hint">بازرگانی، اسناد، کدینگ و گزارش‌ها هر کدام در برگه تمام‌صفحه جدا باز می‌شوند. مبالغ در پایگاه داده به ریال ذخیره می‌شوند.</p>
          <div id="accountingWorkspace"><p class="hint">در حال بارگذاری حسابداری...</p></div>
          <div id="accountingCommerceWorkspace" hidden><p class="hint">در حال بارگذاری فاکتورها و دریافت‌وپرداخت...</p></div>
          <div id="accountingReportsWorkspace" hidden><p class="hint">در حال بارگذاری گزارش‌های مالی...</p></div>
        </div>
      </section>

      <section class="page" id="page-health">
        <div class="card">
          <h2>مرکز سلامت داده‌ها</h2>
          <p class="hint">بررسی ساختار کالاها، بارکدها، اسناد حسابداری، بهای تمام‌شده، پشتیبان و زنجیره لاگ. این بخش فقط گزارش می‌دهد و اطلاعات را تغییر نمی‌دهد.</p>
          <button class="btn btn-primary" id="btnRunDataHealth" type="button">اجرای دوباره بررسی</button>
          <div id="dataHealthWorkspace" style="margin-top:12px"><p class="hint">برای شروع بررسی وارد این بخش شوید.</p></div>
        </div>
      </section>

      <section class="page" id="page-audit">
        <div class="card">
          <h2>لاگ عملیات</h2>
          <p class="hint">تاریخچه شمارش، ورود، ادغام، ویرایش کالا و …</p>
          <input type="search" id="auditSearch" placeholder="جستجو در لاگ..." class="search-input" style="margin-top:10px" />
          <div id="auditList" style="margin-top:10px"></div>
          <div class="actions" style="margin-top:12px">
            <button class="btn btn-audit-export btn-block" id="btnExportAudit" type="button">📄 دانلود CSV لاگ</button>
            <button class="btn btn-audit-clear btn-block" id="btnClearAudit" type="button">🗑 پاک کردن لاگ</button>
          </div>
        </div>
      </section>

      <section class="page" id="page-admin">
        <div class="card">
          <h2>وضعیت سیستم</h2>
          <ul class="info-list">
            <li>منبع داده: <code id="storageInfo">—</code></li>
            <li>انبار فعال: <code id="warehouseInfo">—</code></li>
            <li>نقش: <code id="roleInfo">—</code></li>
            <li>قابلیت اسکنر: <code id="capsInfo">—</code></li>
            <li>شمارش دومرحله‌ای: <code id="doubleInfo">—</code></li>
          </ul>
        </div>
        <div class="card" style="margin-top:12px">
          <h2>تنظیمات</h2>
          <div class="theme-pref-card" style="margin:10px 0 12px;padding:12px;border:1px solid var(--border);background:var(--primary-soft);border-radius:var(--radius-sm)">
            <h3 style="margin:0 0 6px;font-size:1rem">ظاهر برنامه</h3>
            <p class="hint" style="margin:0 0 8px">روشن، تاریک، یا خودکار مطابق تنظیمات گوشی</p>
            <div class="auto-backup-actions" role="radiogroup" aria-label="تم ظاهر">
              <button type="button" class="btn btn-sm auto-backup-btn" data-theme-pref="light" aria-pressed="false">روشن</button>
              <button type="button" class="btn btn-sm auto-backup-btn" data-theme-pref="dark" aria-pressed="false">تاریک</button>
              <button type="button" class="btn btn-sm auto-backup-btn" data-theme-pref="auto" aria-pressed="false">خودکار</button>
            </div>
          </div>
          <div class="settings-grid">
            <label class="set-row"><span>اسکن پیوسته</span><input type="checkbox" id="setContinuous" /></label>
            <label class="set-row"><span>پرش خودکار بعد از اسکن</span><input type="checkbox" id="setAutoNext" /></label>
            <label class="set-row"><span>صدای اسکن</span><input type="checkbox" id="setSound" /></label>
            <label class="set-row"><span>ویبره</span><input type="checkbox" id="setVibrate" /></label>
            <label class="set-row"><span>افزایش خودکار (+۱)</span><input type="checkbox" id="setAutoInc" /></label>
            <label class="set-row"><span>شمارش کور (بدون نمایش مغایرت)</span><input type="checkbox" id="setBlind" /></label>
            <label class="set-row"><span>اسکنر USB/Bluetooth</span><input type="checkbox" id="setBt" /></label>
            <label class="set-row"><span>شمارش دومرحله‌ای</span><input type="checkbox" id="setDouble" /></label>
            <div class="role-settings-panel" id="roleSettingsPanel">
              <div class="role-settings-heading">
                <div>
                  <strong>نقش و سطح دسترسی</strong>
                  <p>نقش را انتخاب کنید؛ دسترسی‌ها پس از ذخیره دوباره اعمال و بررسی می‌شوند.</p>
                </div>
                <span class="role-current-pill" id="rolePreviewPill">مدیر</span>
              </div>
              <label class="set-row" for="setRole"><span>نقش کاربر</span>
                <select id="setRole" aria-describedby="rolePreviewDescription">
                  <option value="admin">مدیر</option>
                  <option value="counter">شمارنده</option>
                  <option value="viewer">مشاهده‌گر</option>
                </select>
              </label>
              <p class="role-preview-description" id="rolePreviewDescription" aria-live="polite">دسترسی کامل به تنظیمات و عملیات مدیریتی.</p>
              <div class="role-permission-list" id="rolePermissionList" aria-live="polite">
                <span>✓ مدیریت تنظیمات و مجوزها</span><span>✓ شمارش و ویرایش کالا</span><span>✓ ورود و خروج اطلاعات</span>
              </div>
            </div>
            <label class="set-row"><span>انبار فعال</span><input type="text" id="setWarehouse" /></label>
            <label class="set-row"><span>نام اپراتور</span><input type="text" id="setOperator" placeholder="نام شما" /></label>
          </div>

          <div class="card" style="margin-top:14px;padding:12px;border:1px solid var(--border);background:var(--primary-soft);border-radius:var(--radius-sm)">
            <h3 style="margin:0 0 6px;font-size:1rem">فروشگاه / شرکت (فاکتور)</h3>
            <p class="hint" style="margin:0 0 10px">این اطلاعات روی فاکتور چاپ و اشتراک نمایش داده می‌شود.</p>
            <div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
              <label class="field">نام فروشگاه / شرکت<input id="setBusinessName" class="search-input" placeholder="مثلاً فروشگاه انبارین" /></label>
              <label class="field">شعار / عنوان فرعی<input id="setBusinessSlogan" class="search-input" placeholder="اختیاری" /></label>
              <label class="field">تلفن<input id="setBusinessPhone" class="search-input" placeholder="021-..." /></label>
              <label class="field">شناسه ملی / کد ملی<input id="setBusinessNationalId" class="search-input" /></label>
              <label class="field">کد اقتصادی<input id="setBusinessEconomicCode" class="search-input" /></label>
              <label class="field">کد پستی<input id="setBusinessPostalCode" class="search-input" /></label>
            </div>
            <label class="field" style="display:block;margin-top:8px">نشانی
              <input id="setBusinessAddress" class="search-input" placeholder="آدرس کامل فروشگاه" />
            </label>
            <div class="logo-picker-card" style="margin-top:10px">
              <div class="logo-picker-head">
                <strong>لوگوی فروشگاه</strong>
                <span class="hint">PNG / JPG / WebP — ترجیحاً زیر ۲۰۰KB</span>
              </div>
              <div class="logo-picker-body">
                <div class="logo-picker-preview-wrap">
                  <img id="setBusinessLogoPreview" class="logo-picker-preview" alt="پیش‌نمایش لوگو" style="display:none" />
                  <span class="logo-picker-placeholder" id="setBusinessLogoPlaceholder">بدون لوگو</span>
                </div>
                <div class="logo-picker-actions">
                  <label class="btn btn-primary btn-sm logo-picker-file-btn" for="setBusinessLogo">انتخاب لوگو</label>
                  <input id="setBusinessLogo" type="file" accept="image/png,image/jpeg,image/webp,image/*" hidden />
                  <button type="button" class="btn btn-secondary btn-sm" id="btnClearBusinessLogo">حذف لوگو</button>
                </div>
              </div>
            </div>
          </div>


          <div class="card auto-backup-card" style="margin-top:14px;padding:12px;border:1px solid var(--border);background:var(--primary-soft);border-radius:var(--radius-sm)">
            <h3 style="margin:0 0 6px;font-size:1rem">پشتیبان خودکار و آنلاین</h3>
            <p class="hint" style="margin:0 0 8px"><b>Google Drive:</b> روی «ورود Google Drive» بزنید. اگر ورود مستقیم حساب ممکن باشد بدون انتخاب پوشه وصل می‌شود؛ در غیر این صورت یک‌بار پوشه Drive را انتخاب می‌کنید و بعدش خودکار ادامه می‌یابد. بدون اتصال، پشتیبان محلی فعال است.</p>
            <p class="hint auto-backup-status" id="autoBackupLocationLabel" style="margin:0 0 10px">وضعیت: —</p>
            <div class="auto-backup-actions" role="group" aria-label="گزینه‌های پشتیبان">
              <button type="button" class="btn btn-sm auto-backup-btn" id="btnConnectGoogleDriveAccount" data-backup-role="drive-connect">ورود Google Drive</button>
              <button type="button" class="btn btn-sm auto-backup-btn" id="btnDisconnectGoogleDriveAccount" data-backup-role="drive-disconnect">قطع Drive</button>
              <button type="button" class="btn btn-sm auto-backup-btn" id="btnPickAutoBackupFolder" data-backup-role="local-pick">پوشه محلی</button>
              <button type="button" class="btn btn-sm auto-backup-btn" id="btnResetAutoBackupFolder" data-backup-role="local-default">پیش‌فرض محلی</button>
              <button type="button" class="btn btn-sm auto-backup-btn auto-backup-btn-run" id="btnRunAutoBackupNow" data-backup-role="run-now">پشتیبان همین حالا</button>
            </div>
          </div>

          <button class="btn btn-primary btn-block" id="btnSaveSettings" style="margin-top:12px">💾 ذخیره تنظیمات</button>
          <div class="actions" style="margin-top:12px">
            <button class="btn btn-secondary btn-block" id="btnClearCounts">پاک کردن همه شمارش‌ها</button>
            <button class="btn btn-secondary btn-block" id="btnZeroUncounted">صفر کردن شمارش‌نشده‌ها</button>
          </div>
        </div>

        <div class="card license-settings-card" style="margin-top:12px">
          <h2>لایسنس</h2>
          <p class="hint license-status-box" id="licenseDetail">—</p>
          <label class="field" style="margin-top:8px;display:block">
            <span style="font-size:.82rem;font-weight:700;color:var(--text-soft)">شناسه دستگاه</span>
            <input id="deviceIdDisplay" readonly style="width:100%;margin-top:4px;direction:ltr;text-align:left;font-family:monospace;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
          </label>
          <label class="field" style="margin-top:8px;display:block">
            <span style="font-size:.82rem;font-weight:700;color:var(--text-soft)">کلید لایسنس</span>
            <input id="licenseKeyInput" placeholder="ANB3...." style="width:100%;margin-top:4px;direction:ltr;text-align:left;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
          </label>
          <label class="field" style="margin-top:8px;display:block">
            <span style="font-size:.82rem;font-weight:700;color:var(--text-soft)">فایل لایسنس امضاشده (.anblic)</span>
            <p class="hint" style="margin:0 0 6px">روش اصلی آفلاین: فایل امضاشده <code>.anblic</code> (RSA). کلید متنی فقط برای سازگاری است.</p>
            <input id="offlineLicenseFile" type="file" accept=".anblic,.json,application/json" style="width:100%;margin-top:4px" />
          </label>
          <div class="auto-backup-actions" style="margin-top:10px">
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnActivateOfflineLicense" data-license-role="activate-file">فعال‌سازی لایسنس آفلاین (فایل)</button>
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnActivateLicense" data-license-role="activate-key">فعال‌سازی کلید متنی (سازگاری)</button>
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnDeactivateLicense" data-license-role="deactivate">حذف لایسنس</button>
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnCopyDeviceId" data-license-role="copy-id">کپی شناسه دستگاه</button>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <h2>همگام‌سازی تیمی</h2>
          <p class="hint" id="teamSyncInfo">—</p>
          <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
            <input type="text" id="teamSessionCode" readonly style="flex:1;direction:ltr;text-align:left;font-family:monospace;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
            <button class="btn btn-sm btn-secondary" id="btnCopyTeamCode">کپی</button>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input type="text" id="joinSessionInput" placeholder="کد جلسه برای پیوستن" style="flex:1;direction:ltr;text-align:left;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
            <button class="btn btn-sm btn-primary" id="btnJoinSession">پیوستن</button>
          </div>
          <label class="set-row" style="margin-top:10px">
            <span>حالت ادغام تداخل</span>
            <select id="teamMergeMode">
              <option value="sum">جمع (sum)</option>
              <option value="max">بیشینه (max)</option>
              <option value="incoming">فایل ورودی</option>
              <option value="local">مقدار محلی</option>
            </select>
          </label>
          <div class="card" style="margin-top:12px;padding:12px;background:var(--bg)">
            <h3 style="margin:0 0 8px">انتخاب روش همگام‌سازی تیمی</h3>
            <span class="settlement-method-label" style="margin-top:6px">روش کار</span>
            <div class="auto-backup-actions team-sync-mode-chips" role="radiogroup" aria-label="روش همگام‌سازی" style="margin:6px 0 10px">
              <button type="button" class="btn btn-sm auto-backup-btn" data-team-mode="offline" aria-pressed="false">آفلاین</button>
              <button type="button" class="btn btn-sm auto-backup-btn" data-team-mode="live" aria-pressed="false">آنلاین زنده</button>
              <button type="button" class="btn btn-sm auto-backup-btn" data-team-mode="hybrid" aria-pressed="false">ترکیبی</button>
            </div>
            <select id="teamSyncMode" hidden aria-hidden="true">
              <option value="offline">آفلاین — انتقال با فایل JSON</option>
              <option value="live">آنلاین زنده — همگام‌سازی خودکار</option>
              <option value="hybrid">ترکیبی — آنلاین خودکار + ابزار آفلاین</option>
            </select>
            <p class="hint">حالت آنلاین زنده در این نسخه با بررسی خودکار دوره‌ای Firebase کار می‌کند، نه WebSocket/Supabase. در حالت ترکیبی، فایل‌های JSON هم برای انتقال دستی در دسترس می‌مانند. در قطع اینترنت، شمارش محلی حفظ می‌شود.</p>
            <label class="field" style="display:block;margin-top:8px"><span>نشانی پایگاه داده آنلاین</span><input id="teamOnlineUrl" type="url" placeholder="https://your-project-default-rtdb.firebaseio.com" style="width:100%;direction:ltr;text-align:left" /></label>
            <label class="field" style="display:block;margin-top:8px"><span>توکن دسترسی (در صورت نیاز)</span><input id="teamOnlineToken" type="password" placeholder="اختیاری؛ مطابق تنظیمات پایگاه داده" style="width:100%;direction:ltr;text-align:left" autocomplete="off" /></label>
            <div class="auto-backup-actions" style="margin-top:8px">
              <button type="button" class="btn btn-sm auto-backup-btn" id="btnSaveTeamOnline" data-team-action="save-online">ذخیره تنظیمات آنلاین</button>
              <button type="button" class="btn btn-sm auto-backup-btn auto-backup-btn-run" id="btnSyncTeamOnline" data-team-action="sync-now">همگام‌سازی آنلاین اکنون</button>
            </div>
            <p class="hint auto-backup-status" id="teamOnlineStatus" role="status" aria-live="polite">همگام‌سازی آنلاین تنظیم نشده است.</p>
          </div>
          <div class="auto-backup-actions" style="margin-top:12px">
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnExportTeam" data-team-action="export-pack">📤 ارسال بسته همگام‌سازی</button>
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnImportTeam" data-team-action="import-pack">📥 دریافت و ادغام بسته</button>
            <input type="file" id="teamSyncFile" accept=".json" style="display:none" />
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnExportPartial" data-team-action="export-partial">📤 خروجی شمارش این دستگاه</button>
            <button type="button" class="btn btn-sm auto-backup-btn" id="btnExportMergeReport" data-team-action="export-report">📄 گزارش آخرین ادغام</button>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <h2>ورود و خروجی</h2>
          <p class="hint">پشتیبانی از XLSX، CSV و JSON</p>
          <div class="actions" style="margin-top:12px">
            <button class="btn btn-primary btn-block" id="btnImport">📥 ورود از فایل</button>
            <input type="file" id="importFile" accept=".xlsx,.xls,.csv,.txt,.json" style="display:none" />
            <button class="btn btn-success btn-block" id="btnExportExcel">📥 دانلود اکسل کامل</button>
            <button class="btn btn-primary btn-block" id="btnExportDiff">📥 دانلود فقط مغایرت‌ها</button>
            <button class="btn btn-secondary btn-block" id="btnExportCsv">📄 دانلود CSV</button>
            <button class="btn btn-secondary btn-block" id="btnExportJson">💾 پشتیبان JSON</button>
            <button class="btn btn-secondary btn-block" id="btnExportPhotos">🖼 خروجی بسته عکس‌ها</button>
            <button class="btn btn-secondary btn-block" id="btnImportPhotos">📥 ورود بسته عکس‌ها</button>
            <input type="file" id="photoPackFile" accept=".json" style="display:none" />
          </div>
          <p class="hint" id="importStatus" style="margin-top:8px"></p>
          <p class="hint" id="photoCountInfo" style="margin-top:4px"></p>
        </div>
      </section>
    </main>

    <!-- Scanner Modal -->
    <div id="scannerModal" class="modal-overlay scanner-modal">
      <div class="modal-sheet">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <strong id="scannerTitle">اسکن بارکد</strong>
          <button class="btn btn-sm btn-secondary" id="btnCloseScanner">بستن</button>
        </div>
        <div id="scanner-container"></div>
        <div class="scanner-toolbar">
          <button class="btn btn-sm btn-secondary" id="torchBtn">🔦 نور</button>
          <button class="btn btn-sm btn-secondary" id="btnRestartCam">🔄 راه‌اندازی مجدد</button>
          <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;margin-right:auto">
            <input type="checkbox" id="scannerContinuous" checked /> پیوسته
          </label>
        </div>
        <div class="manual-row">
          <input type="text" id="manualBarcode" placeholder="ورود دستی بارکد..." inputmode="text" autocomplete="off" />
          <button class="btn btn-primary btn-sm" id="btnManualSubmit">ثبت</button>
        </div>
      </div>
    </div>

    <!-- Qty Modal -->
    <div id="qtyModal" class="modal-overlay qty-modal">
      <div class="modal-card">
        <div id="qtyModalName" style="font-size:1.15rem;font-weight:800;color:var(--primary-deeper)"></div>
        <div id="qtyModalMeta" class="hint" style="margin-top:4px"></div>
        <div class="qty-controls">
          <button class="btn btn-secondary qty-step" id="qtyMinus" aria-label="کم کردن تعداد">−</button>
          <input type="number" id="qtyModalInput" min="0" step="any" inputmode="decimal" class="qty-input" />
          <button class="btn btn-secondary qty-step" id="qtyPlus" aria-label="زیاد کردن تعداد">+</button>
        </div>
        <div id="qtyModalDiff" style="text-align:center;font-size:.85rem;margin:10px 0;min-height:22px"></div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn btn-sm btn-secondary" id="qtyModalEqBtn" style="flex:1">= سیستم</button>
          <button class="btn btn-sm btn-secondary" id="qtySet0" style="flex:1">۰</button>
          <button class="btn btn-sm btn-secondary" id="qtySet1" style="flex:1">۱</button>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary" id="qtyCancel" style="flex:1">انصراف</button>
          <button class="btn btn-primary" id="qtyConfirm" style="flex:1.4">✓ تأیید</button>
        </div>
      </div>
    </div>

    <nav class="nav">
      <button class="nav-item active" data-page="count">شمارش</button>
      <button class="nav-item" data-page="products">کالاها</button>
      <button class="nav-item" data-page="reports">گزارش</button>
      <button class="nav-item" data-page="accounting">حسابداری</button>
      <button class="nav-item" data-page="health">سلامت داده</button>
      <button class="nav-item" data-page="audit">لاگ</button>
      <button class="nav-item" data-page="admin">تنظیمات</button>
    </nav>
  `;


  // دسته‌بندی جمع‌وجور تنظیمات؛ محتوای اصلی و شناسه کنترل‌ها بدون تغییر می‌مانند.
  compactAdminSections();
  compactReportSections();
  bindEvents();
  setupVirtualLists();
}


function compactAdminSections(): void {
  const page = document.getElementById('page-admin');
  if (!page) return;
  const cards = Array.from(page.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.classList.contains('card')
  );
  const icons = ['📊', '⚙️', '🔐', '🔄', '💾'];
  cards.forEach((card, index) => {
    const heading = card.querySelector(':scope > h2');
    if (!heading) return;
    const title = heading.textContent?.trim() || 'بخش تنظیمات';
    const details = document.createElement('details');
    details.className = 'settings-category';
    details.open = index === 0;
    const summary = document.createElement('summary');
    summary.className = 'category-summary';
    summary.innerHTML = `<span class="category-icon" aria-hidden="true">${icons[index] || '🧩'}</span><span class="category-title"></span><span class="category-chevron" aria-hidden="true">⌄</span>`;
    summary.querySelector('.category-title')!.textContent = title;
    const body = document.createElement('div');
    body.className = 'category-content';
    Array.from(card.childNodes).forEach((child) => {
      if (child === heading) return;
      body.appendChild(child);
    });
    details.append(summary, body);
    card.replaceWith(details);
  });
}

function compactReportSections(): void {
  // صفحه گزارش از قبل با details و شبکه فشرده چیده شده؛ فقط کلاس یکدست می‌شود.
  const page = document.getElementById('page-reports');
  page?.querySelectorAll('details.report-fold > summary').forEach((summary) => {
    summary.classList.add('category-summary');
  });
}

function bindEvents() {
  bindBusinessLogoControls();
  bindThemeControls();
  const refreshBackupLoc = async () => {
    const el = document.getElementById('autoBackupLocationLabel');
    const setActive = (role: string | null) => {
      document.querySelectorAll<HTMLElement>('.auto-backup-btn[data-backup-role]').forEach((btn) => {
        const r = btn.dataset.backupRole || '';
        const isRun = r === 'run-now';
        const isDisconnect = r === 'drive-disconnect';
        let on = false;
        if (role === 'drive' && r === 'drive-connect') on = true;
        if (role === 'custom' && r === 'local-pick') on = true;
        if (role === 'default' && r === 'local-default') on = true;
        // قطع Drive فقط وقتی Drive وصل است برجسته می‌شود (قابل اقدام)
        if (role === 'drive' && isDisconnect) {
          btn.classList.remove('is-active');
          btn.classList.add('is-available');
          btn.removeAttribute('aria-pressed');
          return;
        }
        if (isRun) {
          btn.classList.remove('is-active');
          btn.classList.add('is-available');
          btn.removeAttribute('aria-pressed');
          return;
        }
        btn.classList.toggle('is-active', on);
        btn.classList.toggle('is-available', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    if (!el) return;
    try {
      const drive = await getGoogleDriveAccountStatus();
      if (drive.connected) {
        el.textContent = `Google Drive خودکار: وصل (${drive.email || 'حساب گوگل'}) · پوشه AnbarinBackups`;
        setActive('drive');
        return;
      }
      const s = await getAutoBackupLocationStatus();
      el.textContent = s.mode === 'unsupported'
        ? `مسیر فعلی: ${s.label}`
        : s.mode === 'custom'
          ? `مسیر محلی/انتخابی: ${s.label}`
          : `مسیر پیش‌فرض محلی: ${s.label}`;
      setActive(s.mode === 'custom' ? 'custom' : 'default');
    } catch {
      el.textContent = 'مسیر فعلی: Documents/AnbarinBackups';
      setActive('default');
    }
  };
  void refreshBackupLoc();
  document.getElementById('btnConnectGoogleDriveAccount')?.addEventListener('click', async () => {
    const r = await connectGoogleDriveAccount();
    if (r === 'ok') {
      toast('Google Drive وصل شد — پشتیبان خودکار بدون انتخاب پوشه فعال است', 'success');
      void writeExternalAutoBackup(true);
    } else if (r === 'folder-fallback-ok') {
      toast('پشتیبان آنلاین Drive فعال شد (اتصال یک‌باره پوشه). از این به بعد خودکار ذخیره می‌شود', 'success');
      void writeExternalAutoBackup(true);
    } else if (r === 'cancelled') toast('لغو شد', 'info');
    else if (r === 'unsupported') toast('فقط در اپ اندروید', 'info');
    else if (r === 'folder-fallback-needed') toast('برای Drive از منوی بالا Google Drive را انتخاب و یک پوشه بسازید', 'info');
    else toast('اتصال ناموفق بود. اینترنت و اپ Google Drive را بررسی کنید', 'error');
    void refreshBackupLoc();
  });
  document.getElementById('btnDisconnectGoogleDriveAccount')?.addEventListener('click', async () => {
    const r = await disconnectGoogleDriveAccount();
    toast(r === 'ok' ? 'اتصال Google Drive قطع شد' : 'قطع اتصال انجام نشد', r === 'ok' ? 'success' : 'error');
    void refreshBackupLoc();
  });
  document.getElementById('btnPickAutoBackupFolder')?.addEventListener('click', async () => {
    const r = await pickAutoBackupFolder();
    if (r === 'ok') { toast('پوشه پشتیبان تنظیم شد', 'success'); void writeExternalAutoBackup(true); }
    else if (r === 'cancelled') toast('انتخاب پوشه لغو شد', 'info');
    else if (r === 'unsupported') toast('انتخاب پوشه فقط در اپ اندروید فعال است', 'info');
    else toast('انتخاب پوشه ناموفق بود', 'error');
    void refreshBackupLoc();
  });
  document.getElementById('btnResetAutoBackupFolder')?.addEventListener('click', async () => {
    const r = await clearAutoBackupFolder();
    if (r === 'ok') toast('مسیر به پیش‌فرض برگشت', 'success');
    else if (r === 'unsupported') toast('فقط در اپ اندروید', 'info');
    else toast('بازنشانی مسیر ناموفق بود', 'error');
    void refreshBackupLoc();
  });
  document.getElementById('btnRunAutoBackupNow')?.addEventListener('click', async () => {
    const ok = await writeExternalAutoBackup(true);
    toast(ok ? 'پشتیبان خودکار ذخیره شد' : 'پشتیبان نوشته نشد (داده خالی یا فقط وب)', ok ? 'success' : 'info');
    void refreshBackupLoc();
  });
  // Session controls: ensure both visible buttons are wired to their actions.
  // Refresh dependent UI only after the action returns; preserve existing state/data.
  document.getElementById('btnStartSession')?.addEventListener('click', () => {
    if (!guardWrite('شروع جلسه جدید')) return;
    try {
      actionStartSession();
      updateHeader();
      refreshLists();
      updateUndoBtn();
      refreshTeamSyncUI();
    } catch (err) {
      console.error('[Anbarin] start session failed:', err);
      toast('شروع جلسه جدید انجام نشد؛ اطلاعات ذخیره‌سازی را بررسی کنید', 'error');
    }
  });
  document.getElementById('btnCloseSession')?.addEventListener('click', () => {
    if (!guardWrite('بستن جلسه')) return;
    try {
      actionCloseSession();
      updateHeader();
      refreshLists();
      updateUndoBtn();
      refreshTeamSyncUI();
    } catch (err) {
      console.error('[Anbarin] close session failed:', err);
      toast('بستن جلسه انجام نشد؛ دوباره تلاش کنید', 'error');
    }
  });
  document.getElementById('setRole')?.addEventListener('change', () => {
    // پیش‌نمایش فقط نمایشی است؛ سطح دسترسی واقعی پس از ذخیره از تنظیمات معتبر خوانده می‌شود.
    updateRolePreview();
  });
  document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
    try {
      applySettingsFromForm();
      // هم نشان نقش و هم محدودیت‌های UI را بلافاصله با نقش جدید هماهنگ کن.
      updateHeader();
      fillSettingsForm();
      updateRolePreview();
      refreshLists();
    } catch (err) {
      console.error('[Anbarin] saving settings failed:', err);
      toast('ذخیره تنظیمات انجام نشد؛ فضای ذخیره‌سازی را بررسی کنید', 'error');
    }
  });
  // دکمه‌های عملیات شمارش باید به توابع واقعی متصل باشند؛ قبلاً فقط در رابط نمایش داده می‌شدند.
  document.getElementById('btnClearCounts')?.addEventListener('click', () => {
    if (!guardWrite('پاک کردن شمارش‌ها')) return;
    actionClearCounts();
    updateHeader();
    refreshLists();
  });
  document.getElementById('btnZeroUncounted')?.addEventListener('click', () => {
    if (!guardWrite('صفر کردن شمارش‌نشده‌ها')) return;
    actionZeroUncounted();
    updateHeader();
    refreshLists();
  });

  // عملیات همگام‌سازی شمارش با موجودی سیستم؛ این دکمه‌ها قبلاً تابع داشتند
  // اما رویداد کلیک به آن‌ها متصل نشده بود.
  document.getElementById('btnApplySystem')?.addEventListener('click', () => {
    if (!guardWrite('اعمال شمارش روی موجودی سیستم')) return;
    try {
      if (applyCountsToSystem()) {
        updateHeader();
        refreshLists();
        updateUndoBtn();
      }
    } catch (err) {
      console.error('[Anbarin] apply counts to system failed:', err);
      toast('اعمال شمارش روی موجودی سیستم ناموفق بود؛ دوباره تلاش کنید', 'error');
    }
  });
  document.getElementById('btnResetToSystem')?.addEventListener('click', () => {
    if (!guardWrite('برگرداندن شمارش به مقدار سیستم')) return;
    try {
      if (resetCountsToSystem()) {
        updateHeader();
        refreshLists();
        updateUndoBtn();
      }
    } catch (err) {
      console.error('[Anbarin] reset counts to system failed:', err);
      toast('همسان‌سازی شمارش با موجودی سیستم ناموفق بود؛ دوباره تلاش کنید', 'error');
    }
  });

  // چاپ لیبل بارکد؛ دکمه قبلاً در رابط بود اما رویداد کلیک نداشت.
  document.getElementById('btnPrintLabels')?.addEventListener('click', () => {
    try {
      printLabelsBulk(50);
    } catch (err) {
      console.error('[Anbarin] print barcode labels failed:', err);
      toast('چاپ لیبل انجام نشد؛ مرورگر یا مجوز چاپ را بررسی کنید', 'error');
    }
  });

  // لاگ عملیات: دکمه‌ها قبلاً در صفحه وجود داشتند اما رویداد کلیک نداشتند.
  document.getElementById('btnExportAudit')?.addEventListener('click', () => {
    try {
      exportAuditCSV();
    } catch (err) {
      console.error('[Anbarin] export audit failed:', err);
      toast('دانلود لاگ ناموفق بود؛ دوباره تلاش کنید', 'error');
    }
  });
  document.getElementById('btnClearAudit')?.addEventListener('click', () => {
    try {
      clearAuditLog();
      renderAuditList();
    } catch (err) {
      console.error('[Anbarin] clear audit failed:', err);
      toast('پاک کردن لاگ ناموفق بود', 'error');
    }
  });
  document.getElementById('auditSearch')?.addEventListener('input', () => renderAuditList());
  document.getElementById('btnRunDataHealth')?.addEventListener('click', () => { void renderDataHealth(); });

  document.getElementById('btnOpenScanner')?.addEventListener('click', () => {
    (window as any).__anbarinInvoiceScanActive = false;
    if (!guardWrite('اسکن')) return;
    const modal = document.getElementById('scannerModal');
    if (modal) modal.style.display = 'flex';
    settings.quickAutoConfirm = false;
    openScanner({ title: 'اسکن بارکد' });
  });

  document.getElementById('btnQuickCount')?.addEventListener('click', () => {
    (window as any).__anbarinInvoiceScanActive = false;
    if (!guardWrite('شمارش سریع')) return;
    settings.quickAutoConfirm = true;
    const modal = document.getElementById('scannerModal');
    if (modal) modal.style.display = 'flex';
    openScanner({ quick: true, title: 'شمارش سریع ⚡' });
  });

  document.getElementById('btnCloseScanner')?.addEventListener('click', () => {
    (window as any).__anbarinInvoiceScanActive = false;
    const continuous = document.getElementById('scannerContinuous') as HTMLInputElement | null;
    if (continuous) continuous.checked = (window as any).__anbarinScannerContinuousBeforeInvoice ?? true;
    settings.quickAutoConfirm = false;
    closeScanner();
    const modal = document.getElementById('scannerModal');
    if (modal) modal.style.display = 'none';
  });

  document.getElementById('torchBtn')?.addEventListener('click', () => toggleTorch());
  document.getElementById('btnRestartCam')?.addEventListener('click', () => restartCamera());
  document.getElementById('btnManualSubmit')?.addEventListener('click', () => submitManualBarcode());
  document.getElementById('manualBarcode')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitManualBarcode();
    }
  });

  document.getElementById('qtyMinus')?.addEventListener('click', () => adjustQtyModal(-1));
  document.getElementById('qtyPlus')?.addEventListener('click', () => adjustQtyModal(1));
  document.getElementById('qtyModalEqBtn')?.addEventListener('click', () => setQtyModalToSystem());
  document.getElementById('qtySet0')?.addEventListener('click', () => {
    const inp = document.getElementById('qtyModalInput') as HTMLInputElement;
    if (inp) {
      inp.value = '0';
      updateQtyModalDiff();
    }
  });
  document.getElementById('qtySet1')?.addEventListener('click', () => {
    const inp = document.getElementById('qtyModalInput') as HTMLInputElement;
    if (inp) {
      inp.value = '1';
      updateQtyModalDiff();
    }
  });
  document.getElementById('qtyCancel')?.addEventListener('click', () => closeQtyModal());
  document.getElementById('qtyConfirm')?.addEventListener('click', () => {
    if (confirmQtyModal()) {
      updateHeader();
      refreshLists();
      const continuous =
        (document.getElementById('scannerContinuous') as HTMLInputElement)?.checked ??
        settings.continuousScan;
      if (!continuous) {
        closeScanner();
        const modal = document.getElementById('scannerModal');
        if (modal) modal.style.display = 'none';
      }
    }
  });
  document.getElementById('qtyModalInput')?.addEventListener('input', () => updateQtyModalDiff());
  document.getElementById('qtyModalInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('qtyConfirm')?.click();
    }
  });

  document.getElementById('undoBtn')?.addEventListener('click', () => {
    undoLast();
    updateUndoBtn();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
      const tag = ((e.target as HTMLElement)?.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') {
        e.preventDefault();
        undoLast();
        updateUndoBtn();
      }
    }
  });

  // Location filters
  const onLoc = (val: string) => {
    setLocationFilter(val);
    // sync both selects
    const a = document.getElementById('locationFilterSelect') as HTMLSelectElement | null;
    const b = document.getElementById('locationFilterSelectProducts') as HTMLSelectElement | null;
    if (a) a.value = val;
    if (b) b.value = val;
    refreshLists();
  };
  document.getElementById('locationFilterSelect')?.addEventListener('change', (e) => {
    onLoc((e.target as HTMLSelectElement).value);
  });
  document.getElementById('locationFilterSelectProducts')?.addEventListener('change', (e) => {
    onLoc((e.target as HTMLSelectElement).value);
  });

  // Search & filters
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  const onSearch = (val: string) => {
    productSearchQuery = val;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshLists(), 180);
  };
  document.getElementById('searchProducts')?.addEventListener('input', (e) => {
    onSearch((e.target as HTMLInputElement).value);
  });
  document.getElementById('searchCount')?.addEventListener('input', (e) => {
    onSearch((e.target as HTMLInputElement).value);
  });
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      countFilter = ((chip as HTMLElement).dataset.cf as typeof countFilter) || 'all';
      refreshLists();
    });
  });

  // Products CRUD
  document.getElementById('btnAddProduct')?.addEventListener('click', () => {
    if (!guardWrite('افزودن کالا')) return;
    openProductModal();
  });
  setProductsChangeListener(() => {
    updateHeader();
    refreshLists();
  });

  // Team sync: keep offline JSON tools and let the user choose offline, live, or hybrid.
  const syncModeSelect = document.getElementById('teamSyncMode') as HTMLSelectElement | null;
  const paintTeamModeChips = () => {
    const mode = syncModeSelect?.value || 'offline';
    document.querySelectorAll<HTMLElement>('[data-team-mode]').forEach((btn) => {
      const on = btn.dataset.teamMode === mode;
      btn.classList.toggle('is-active', on);
      btn.classList.toggle('is-available', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  document.querySelectorAll<HTMLElement>('[data-team-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!syncModeSelect) return;
      const mode = btn.dataset.teamMode || 'offline';
      syncModeSelect.value = mode;
      saveTeamSyncMode();
      refreshTeamOnlineStatus();
      initializeTeamOnlineSync();
      paintTeamModeChips();
    });
  });
  paintTeamModeChips();
  document.getElementById('teamSyncMode')?.addEventListener('change', () => {
    saveTeamSyncMode();
    refreshTeamOnlineStatus();
    initializeTeamOnlineSync();
    paintTeamModeChips();
  });
  document.getElementById('btnSaveTeamOnline')?.addEventListener('click', () => {
    saveTeamOnlineConfig();
    refreshTeamOnlineStatus();
  });
  document.getElementById('btnSyncTeamOnline')?.addEventListener('click', async () => {
    await syncTeamOnlineNow();
    updateHeader();
    refreshLists();
    refreshTeamSyncUI();
  });
  document.getElementById('btnCopyTeamCode')?.addEventListener('click', () => copyTeamSessionCode());
  document.getElementById('btnActivateLicense')?.addEventListener('click', () => activateLicenseFromInput());
  document.getElementById('btnDeactivateLicense')?.addEventListener('click', () => deactivateLicense());
  document.getElementById('btnActivateOfflineLicense')?.addEventListener('click', async () => {
    const input = document.getElementById('offlineLicenseFile') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) { toast('ابتدا فایل .anblic را انتخاب کنید', 'error'); return; }
    try {
      const license = await activateOfflineLicenseFile(file);
      // یک منبع فعال: فایل RSA جایگزین کلید متنی ANB3 می‌شود
      try { saveStoredLicense(null); } catch { /* ignore */ }
      toast('لایسنس آفلاین برای ' + license.customerName + ' فعال شد', 'success');
      updateLicenseUI();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'فعال‌سازی لایسنس ناموفق بود', 'error');
    }
  });
  document.getElementById('btnCopyDeviceId')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getDeviceId()); toast('شناسه دستگاه کپی شد', 'success'); }
    catch { toast('کپی خودکار ممکن نیست؛ شناسه دستگاه را دستی انتخاب کنید', 'error'); }
  });
  document.getElementById('btnJoinSession')?.addEventListener('click', () => {
    if (joinTeamSession()) {
      refreshTeamSyncUI();
      updateHeader();
    }
  });
  document.getElementById('btnExportTeam')?.addEventListener('click', () => {
    if (!requirePremium('همگام‌سازی تیمی')) return;
    exportTeamSyncPack();
  });
  document.getElementById('btnExportPartial')?.addEventListener('click', () => exportPartialCount());
  document.getElementById('btnExportMergeReport')?.addEventListener('click', () => exportTeamConflictReport());
  document.getElementById('btnImportTeam')?.addEventListener('click', () => {
    document.getElementById('teamSyncFile')?.click();
  });
  document.getElementById('teamSyncFile')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    await importTeamSyncPack(f);
    (e.target as HTMLInputElement).value = '';
    updateHeader();
    refreshLists();
    refreshTeamSyncUI();
  });

  // Photos
  document.getElementById('btnTakePhoto')?.addEventListener('click', () => {
    captureProductPhoto();
  });
  document.getElementById('btnExportPhotos')?.addEventListener('click', () => exportPhotosPack());
  document.getElementById('btnImportPhotos')?.addEventListener('click', () => {
    document.getElementById('photoPackFile')?.click();
  });
  document.getElementById('photoPackFile')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    await importPhotosPack(f);
    (e.target as HTMLInputElement).value = '';
    updateHeader();
    refreshLists();
  });

  // Reports
  document.getElementById('btnCopyReport')?.addEventListener('click', () => copyTextReport());
  document.getElementById('btnExportDiffs')?.addEventListener('click', () => exportDiffsExcel());
  document.getElementById('btnExportCountedProducts')?.addEventListener('click', () => exportCountedProductsExcel());
  document.getElementById('btnAccGeneric')?.addEventListener('click', () => exportAccountingDoc('generic'));
  document.getElementById('btnAccHeloo')?.addEventListener('click', () => exportAccountingDoc('heloo'));
  document.getElementById('btnAccSepidar')?.addEventListener('click', () => exportAccountingDoc('sepidar'));
  initAccountingTemplateUI();
  initInventoryDocumentsUI();
  document.getElementById('btnDoubleDiff')?.addEventListener('click', () => exportDoubleCountMismatches());
  document.getElementById('btnStockAlerts')?.addEventListener('click', () => exportStockAlerts());
  document.getElementById('btnStockAlertsExcel')?.addEventListener('click', () => exportStockAlertsExcel());
  document.getElementById('btnStockAlertsPdf')?.addEventListener('click', () => printStockAlerts());
  const cardexSelect = document.getElementById('cardexProductSelect') as HTMLSelectElement | null;
  if (cardexSelect) {
    cardexSelect.replaceChildren(new Option('انتخاب کالا...', ''));
    products.forEach((p) => cardexSelect.add(new Option(`${p.name} — ${p.code || p.sku || p.id}`, p.id)));
    cardexSelect.addEventListener('change', () => renderCardex(cardexSelect.value));
    enhanceSelectWithSearch(cardexSelect, { placeholder: 'جستجوی کالا برای کاردکس...' });
    refreshSearchableSelect(cardexSelect);
  }
  document.getElementById('btnCardexExcel')?.addEventListener('click', () => { if (cardexSelect?.value) exportProductCardexExcel(cardexSelect.value); else toast('ابتدا کالا را انتخاب کنید', 'error'); });
  document.getElementById('btnCardexPdf')?.addEventListener('click', () => { if (cardexSelect?.value) printProductCardex(cardexSelect.value); else toast('ابتدا کالا را انتخاب کنید', 'error'); });

  // Import / Export
  document.getElementById('btnImport')?.addEventListener('click', () => {
    document.getElementById('importFile')?.click();
  });
  document.getElementById('importFile')?.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const status = document.getElementById('importStatus');
    if (status) status.textContent = 'در حال پردازش...';
    await loadSheetJS();
    const result = await processImportFile(file);
    if (status) {
      status.textContent = result
        ? `انجام شد: ${result.added} جدید، ${result.updated} به‌روز`
        : 'لغو یا ناموفق';
    }
    input.value = '';
    updateHeader();
    refreshLists();
  });
  document.getElementById('btnExportExcel')?.addEventListener('click', async () => {
    if (!requirePremium('خروجی اکسل')) return;
    await loadSheetJS();
    exportExcel(false);
  });
  document.getElementById('btnExportDiff')?.addEventListener('click', async () => {
    if (!requirePremium('خروجی مغایرت')) return;
    await loadSheetJS();
    exportExcel(true);
  });
  document.getElementById('btnExportCsv')?.addEventListener('click', () => exportCSV(false));
  document.getElementById('btnExportJson')?.addEventListener('click', () => exportJSON());

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = (btn as HTMLElement).dataset.page;
      if (page) {
        const mod = moduleForPage(page);
        if (mod && !requireModule(mod)) return;
        showPage(page);
        requestAnimationFrame(() => {
          refreshLists();
          if (page === 'audit') renderAuditList();
          if (page === 'health') void renderDataHealth();
        });
      }
    });
  });

  const cont = document.getElementById('scannerContinuous') as HTMLInputElement | null;
  if (cont) cont.checked = settings.continuousScan !== false;
}

function updateRolePreview(): void {
  const select = document.getElementById('setRole') as HTMLSelectElement | null;
  const description = document.getElementById('rolePreviewDescription');
  const pill = document.getElementById('rolePreviewPill');
  const list = document.getElementById('rolePermissionList');
  if (!select) return;
  const role = select.value;
  const roles: Record<string, { label: string; description: string; permissions: string[] }> = {
    admin: {
      label: 'مدیر',
      description: 'دسترسی کامل به تنظیمات و عملیات مدیریتی؛ مناسب مسئول اصلی انبار.',
      permissions: ['✓ مدیریت تنظیمات و مجوزها', '✓ شمارش، ویرایش و ورود اطلاعات', '✓ عملیات حساس مدیریتی'],
    },
    counter: {
      label: 'شمارنده',
      description: 'مناسب تیم شمارش؛ امکان ثبت شمارش و کار با کالاها، بدون عملیات مدیریتی حساس.',
      permissions: ['✓ شمارش و ویرایش شمارش', '✓ اسکن و مشاهده کالاها', '— عملیات حساس مدیریتی محدود است'],
    },
    viewer: {
      label: 'مشاهده‌گر',
      description: 'فقط مشاهده اطلاعات؛ دکمه‌های تغییر داده و عملیات شمارش غیرفعال می‌شوند.',
      permissions: ['✓ مشاهده کالاها و گزارش‌ها', '— ثبت یا تغییر شمارش', '— ورود اطلاعات و عملیات مدیریتی'],
    },
  };
  const selected = roles[role] || roles.admin;
  if (description) description.textContent = selected.description;
  if (pill) pill.textContent = selected.label;
  if (list) {
    list.replaceChildren(...selected.permissions.map((permission) => {
      const item = document.createElement('span');
      item.textContent = permission;
      return item;
    }));
  }
}

function updateHeader() {
  const stats = getCountStats();
  const el = document.getElementById('headerStats');
  if (el) {
    el.innerHTML = `<span>${formatFaNumber(stats.counted)} / ${formatFaNumber(stats.total)}</span>`;
  }

  const box = document.getElementById('statsBox');
  if (box) {
    box.innerHTML = `
      <div class="stat-card"><div class="stat-value">${formatFaNumber(stats.total)}</div><div class="stat-label">کل کالا</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(stats.counted)}</div><div class="stat-label">شمارش‌شده</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(stats.diffs)}</div><div class="stat-label">مغایرت</div></div>
      <div class="stat-card"><div class="stat-value">${formatFaNumber(stats.withPhoto)}</div><div class="stat-label">با عکس</div></div>
    `;
  }

  const sh = document.getElementById('sessionHint');
  if (sh) sh.textContent = getSessionLabel();
  const sl = document.getElementById('sessionLabel');
  if (sl) sl.textContent = getSessionLabel();

  const phaseBar = document.getElementById('phaseBar');
  if (phaseBar) phaseBar.style.display = settings.doubleCount ? 'flex' : 'none';


  const si = document.getElementById('storageInfo');
  if (si) si.textContent = String(storageBackend);
  const wi = document.getElementById('warehouseInfo');
  if (wi) wi.textContent = settings.currentWarehouse || '—';
  const ri = document.getElementById('roleInfo');
  if (ri) ri.textContent = settings.role || '—';
  const di = document.getElementById('doubleInfo');
  if (di) di.textContent = settings.doubleCount ? 'فعال' : 'غیرفعال';

  const dashboard = document.getElementById('managementDashboard');
  if (dashboard) dashboard.innerHTML = renderManagementDashboard();
  const movementPanel = document.getElementById('inventoryMovementPanel');
  if (movementPanel) {
    movementPanel.innerHTML = renderInventoryMovementPanel();
    document.getElementById('btnMovementSummaryCSV')?.addEventListener('click', () => {
      const data = (document.getElementById('movementSummaryCSVData') as HTMLTextAreaElement | null)?.value || '';
      if (!data) { toast('داده‌ای برای خروجی وجود ندارد', 'info'); return; }
      const blob = new Blob(['\\ufeff' + data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'inventory-movement-summary.csv'; a.click();
      URL.revokeObjectURL(url);
    });
  }
  const activityPanel = document.getElementById('activityHistoryPanel');
  if (activityPanel) {
    activityPanel.innerHTML = renderActivityHistoryPanel();
    document.getElementById('btnActivityHistoryPrev')?.addEventListener('click', (event) => {
      setActivityHistoryPage(Number((event.currentTarget as HTMLButtonElement).dataset.page));
      updateHeader();
    });
    document.getElementById('btnActivityHistoryNext')?.addEventListener('click', (event) => {
      setActivityHistoryPage(Number((event.currentTarget as HTMLButtonElement).dataset.page));
      updateHeader();
    });
    document.getElementById('activityHistoryPageSize')?.addEventListener('change', (event) => {
      setActivityHistoryPageSize(Number((event.target as HTMLSelectElement).value));
      updateHeader();
    });
    document.getElementById('btnActivityHistoryCSV')?.addEventListener('click', () => {
      const data = (document.getElementById('activityHistoryCSVData') as HTMLTextAreaElement | null)?.value || '';
      if (!data) { toast('داده‌ای برای خروجی وجود ندارد', 'info'); return; }
      const blob = new Blob(['\\ufeff' + data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'activity-history.csv'; a.click();
      URL.revokeObjectURL(url);
    });
  }
  const rs = document.getElementById('reportSummary');
  if (rs) rs.innerHTML = renderReportHTML();
  const alertsPanel = document.getElementById('stockAlertsPanel');
  if (alertsPanel) {
    alertsPanel.innerHTML = renderStockAlertsPanel();
    document.getElementById('btnStockAlertsExcel')?.addEventListener('click', () => exportStockAlertsExcel());
    document.getElementById('btnStockAlertsPdf')?.addEventListener('click', () => printStockAlerts());
  }

  const pci = document.getElementById('photoCountInfo');
  if (pci) pci.textContent = 'عکس‌های ذخیره‌شده: ' + countPhotos();
  refreshTeamSyncUI();
  initializeTeamOnlineSync();
  refreshTeamOnlineStatus();
  updateLicenseUI();
  applyRoleUI();
}

function updateUndoBtn() {
  const btn = document.getElementById('undoBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !canUndo();
}

function updateCapsInfo() {
  const caps = getScannerCapabilities();
  const el = document.getElementById('capsInfo');
  if (!el) return;
  const parts = [
    caps.barcodeDetector ? 'BarcodeDetector' : null,
    caps.html5Qrcode ? 'Html5Qrcode' : null,
    caps.mediaDevices ? 'Camera' : null,
    'USB/BT',
  ].filter(Boolean);
  el.textContent = parts.join(' + ') || 'فقط دستی';
}

initUnifiedDatePickers();
bootApp();
