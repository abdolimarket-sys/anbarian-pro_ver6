/**
 * مدیریت کالا — افزودن / ویرایش / حذف
 * ارتقا نسبت به نسخه یک‌فایلی: جدا، type-safe، قابل اتصال به لیست مجازی
 */

import type { Product } from '@/types';
import {
  products,
  settings,
  save,
  flushSave,
  rebuildIndex,
  invalidateStats,
  logAudit,
  findProductByCode,
} from './state';
import { toast } from './ui';
import { closeScanner } from './scanner';
import { generateId, normalizeDigits, roundQty } from '@/utils/helpers';
import { canCount, guardLocked } from './count';
import { guardPermission } from './filters-roles';
import { ensureProductStock, DEFAULT_WAREHOUSE } from './warehouse-stock';

let editingId: string | null = null;
let onProductsChanged: (() => void) | null = null;
let pendingProductSaveCallback: ((productId: string) => void) | null = null;

export function setProductsChangeListener(fn: (() => void) | null): void {
  onProductsChanged = fn;
}

function notify(): void {
  rebuildIndex();
  invalidateStats();
  onProductsChanged?.();
}

function ensureModal(): HTMLElement {
  let modal = document.getElementById('productModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'productModal';
  modal.className = 'modal-overlay';
  modal.style.cssText =
    'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10200;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:100%;max-height:90vh;overflow:auto">
      <h2 id="productModalTitle" style="margin-bottom:12px;color:var(--primary-dark)">کالای جدید</h2>
      <form id="productForm">
        <input type="hidden" id="productId" />
        <label class="field"><span>نام *</span><input id="productName" required autocomplete="off" /></label>
        <label class="field"><span>بارکد</span><input id="productCode" direction="ltr" style="direction:ltr;text-align:left" autocomplete="off" /></label>
        <label class="field"><span>کد کالا (SKU)</span><input id="productSku" style="direction:ltr;text-align:left" autocomplete="off" /></label>
        <div style="display:flex;gap:8px">
          <label class="field" style="flex:1"><span>موجودی سیستم</span><input id="productSystemQty" type="number" step="any" value="0" /></label>
          <label class="field" style="flex:1"><span>واحد پایه</span>
            <select id="productUnit">
              <option value="عدد">عدد</option>
              <option value="کیلوگرم">کیلوگرم</option>
              <option value="گرم">گرم</option>
              <option value="میلی‌گرم">میلی‌گرم</option>
              <option value="لیتر">لیتر</option>
              <option value="میلی‌لیتر">میلی‌لیتر</option>
              <option value="متر">متر</option>
              <option value="سانتی‌متر">سانتی‌متر</option>
              <option value="مترمربع">مترمربع</option>
              <option value="جفت">جفت</option>
              <option value="دست">دست</option>
              <option value="شاخه">شاخه</option>
              <option value="رول">رول</option>
              <option value="قوطی">قوطی</option>
              <option value="بسته">بسته</option>
              <option value="کارتن">کارتن</option>
              <option value="جعبه">جعبه</option>
              <option value="گونی">گونی</option>
              <option value="پالت">پالت</option>
            </select>
          </label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:120px"><span>قیمت خرید</span><input id="productPurchasePrice" type="number" step="any" min="0" value="0" inputmode="decimal" title="بهای خرید کالا" /></label>
          <label class="field" style="flex:1;min-width:120px"><span>قیمت مصرف‌کننده</span><input id="productConsumerPrice" type="number" step="any" min="0" value="0" inputmode="decimal" /></label>
          <label class="field" style="flex:1;min-width:100px"><span>تخفیف فروش (%)</span><input id="productSellDiscount" type="number" step="any" min="0" max="100" value="0" inputmode="decimal" placeholder="مثلاً ۵" /></label>
          <label class="field" style="flex:1;min-width:120px"><span>قیمت فروش</span><input id="productPrice" type="number" step="any" min="0" value="0" inputmode="decimal" title="قیمت نهایی در فاکتور فروش" /></label>
          <label class="field" style="flex:1;min-width:120px"><span>بهای استاندارد</span><input id="productStandardCost" type="number" step="any" min="0" value="0" inputmode="decimal" title="بهای استاندارد واحد — برای انحراف خرید؛ خالی/صفر = غیرفعال" /></label>
        </div>
        <p class="hint" id="productPriceHint" style="margin:4px 0 8px">قیمت خرید برای بهای تمام‌شده است؛ قیمت فروش پس از تخفیف نسبت به مصرف‌کننده در فاکتور فروش استفاده می‌شود. اگر بهای استاندارد بیشتر از صفر باشد، در خرید موجودی با استاندارد ثبت و انحراف قیمت جداگانه شناسایی می‌شود.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:120px"><span>ضریب واحد</span><input id="productUnitFactor" type="number" step="any" min="0" value="1" title="تعداد واحد پایه در هر بسته" /></label>
          <label class="field" style="flex:1;min-width:120px"><span>واحد بسته</span><input id="productPackUnit" list="anbarin-pack-unit-list" placeholder="کارتن / بسته / جعبه..." title="نام واحد بسته‌بندی برای تبدیل در فاکتور" autocomplete="off" /></label>
        </div>
        <datalist id="anbarin-pack-unit-list">
          <option value="کارتن"></option>
          <option value="بسته"></option>
          <option value="جعبه"></option>
          <option value="گونی"></option>
          <option value="پالت"></option>
          <option value="رول"></option>
          <option value="قوطی"></option>
          <option value="دسته"></option>
          <option value="جین"></option>
        </datalist>
        <p class="hint" style="margin:0 0 8px">مثال: واحد پایه «عدد»، واحد بسته «کارتن»، ضریب ۱۲ یعنی هر کارتن = ۱۲ عدد. در فاکتور می‌توان تعداد را بر حسب بسته زد؛ موجودی بر حسب واحد پایه تغییر می‌کند.</p>
        <div style="display:flex;gap:8px">
          <label class="field" style="flex:1"><span>حداقل</span><input id="productMinQty" type="number" step="any" /></label>
          <label class="field" style="flex:1"><span>حداکثر</span><input id="productMaxQty" type="number" step="any" /></label>
        </div>
        <label class="field"><span>محل / قفسه</span><input id="productLocation" autocomplete="off" /></label>
        <label class="field"><span>انبار</span><input id="productWarehouse" autocomplete="off" /></label>
        <div style="display:flex;gap:8px">
          <label class="field" style="flex:1"><span>سریال</span><input id="productSerial" /></label>
          <label class="field" style="flex:1"><span>بچ</span><input id="productBatch" /></label>
        </div>
        <label class="field"><span>تاریخ انقضا</span><input id="productExpiry" type="date" /></label>
        <label class="field"><span>یادداشت</span><textarea id="productNote" rows="2"></textarea></label>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button type="button" class="btn btn-secondary" id="productCancel" style="flex:1">انصراف</button>
          <button type="submit" class="btn btn-primary" style="flex:1.4">ذخیره</button>
        </div>
        <button type="button" class="btn btn-secondary btn-block" id="productDelete" style="margin-top:8px;display:none;color:var(--danger)">حذف کالا</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // styles for fields once
  if (!document.getElementById('product-form-styles')) {
    const st = document.createElement('style');
    st.id = 'product-form-styles';
    st.textContent = `
      .field{display:block;margin-bottom:8px;font-size:.82rem;font-weight:700;color:var(--text-soft)}
      .field span{display:block;margin-bottom:4px}
      .field input,.field textarea{
        width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);
        background:var(--bg);color:var(--text);font-size:.95rem;font-weight:600
      }
      .field textarea{resize:vertical}
    `;
    document.head.appendChild(st);
  }

  modal.querySelector('#productCancel')?.addEventListener('click', () => closeProductModal());
  modal.querySelector('#productDelete')?.addEventListener('click', () => {
    if (editingId) deleteProduct(editingId);
  });
  modal.querySelector('#productForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    saveProductFromForm();
  });
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) closeProductModal();
  });

  return modal;
}

function ensureProductUnitOption(unit: string): void {
  const select = document.getElementById('productUnit') as HTMLSelectElement | null;
  const value = (unit || '').trim();
  if (!select || !value) return;
  const exists = Array.from(select.options).some((option) => option.value === value);
  if (!exists) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value?.trim() || '';
}

function num(id: string): number {
  const v = parseFloat(val(id));
  return isNaN(v) ? 0 : roundQty(v);
}

function numOrNull(id: string): number | null {
  const raw = val(id);
  if (raw === '') return null;
  const v = parseFloat(raw);
  return isNaN(v) ? null : roundQty(v);
}


/** محاسبه قیمت فروش از مصرف‌کننده و درصد تخفیف */
function calcSellFromConsumer(consumer: number, discountPercent: number): number {
  const c = Number(consumer) || 0;
  const d = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  if (c <= 0) return 0;
  return Math.round(c * (1 - d / 100) * 1000) / 1000;
}
function calcDiscountFromPrices(consumer: number, sell: number): number {
  const c = Number(consumer) || 0;
  const s = Number(sell) || 0;
  if (c <= 0) return 0;
  if (s >= c) return 0;
  return Math.round((1 - s / c) * 10000) / 100;
}
function syncProductPriceFields(source: 'consumer' | 'discount' | 'sell'): void {
  const consumerEl = document.getElementById('productConsumerPrice') as HTMLInputElement | null;
  const discEl = document.getElementById('productSellDiscount') as HTMLInputElement | null;
  const sellEl = document.getElementById('productPrice') as HTMLInputElement | null;
  const hint = document.getElementById('productPriceHint');
  if (!consumerEl || !discEl || !sellEl) return;
  const consumer = Number(consumerEl.value) || 0;
  let disc = Number(discEl.value) || 0;
  let sell = Number(sellEl.value) || 0;
  if (source === 'consumer' || source === 'discount') {
    sell = calcSellFromConsumer(consumer, disc);
    sellEl.value = String(sell);
  } else if (source === 'sell') {
    disc = calcDiscountFromPrices(consumer, sell);
    discEl.value = String(disc);
  }
  if (hint) {
    if (consumer > 0 && disc > 0) {
      hint.textContent = `فروش با ${disc}٪ کمتر از مصرف‌کننده → قیمت فاکتور: ${sell}`;
    } else if (consumer > 0) {
      hint.textContent = 'بدون تخفیف؛ قیمت فروش برابر قیمت مصرف‌کننده است و در فاکتور استفاده می‌شود.';
    } else {
      hint.textContent = 'قیمت فروش در فاکتور استفاده می‌شود. برای تخفیف ثابت، قیمت مصرف‌کننده و درصد را پر کنید.';
    }
  }
}
function bindProductPriceSync(): void {
  const consumerEl = document.getElementById('productConsumerPrice');
  const discEl = document.getElementById('productSellDiscount');
  const sellEl = document.getElementById('productPrice');
  if (!consumerEl || consumerEl.dataset.priceSyncBound === '1') return;
  consumerEl.dataset.priceSyncBound = '1';
  consumerEl.addEventListener('input', () => syncProductPriceFields('consumer'));
  discEl?.addEventListener('input', () => syncProductPriceFields('discount'));
  sellEl?.addEventListener('input', () => syncProductPriceFields('sell'));
}

export function openProductModal(
  id?: string | null,
  presetCode?: string,
  opts?: { presetName?: string; onSaved?: (productId: string) => void },
): void {
  if (!guardPermission('inventory.edit', 'ویرایش کالا')) return;

  // اسکنر را ببند تا مودال کالا دیده شود و روی همه لایه‌ها باشد
  try { closeScanner(); } catch { /* ignore */ }
  const modal = ensureModal();
  modal.style.zIndex = '10550';
  document.body.appendChild(modal);
  const title = document.getElementById('productModalTitle');
  const delBtn = document.getElementById('productDelete') as HTMLButtonElement | null;

  editingId = id || null;
  pendingProductSaveCallback = opts?.onSaved || null;

  const fields = [
    'productId',
    'productName',
    'productCode',
    'productSku',
    'productSystemQty',
    'productUnit',
    'productPurchasePrice',
    'productConsumerPrice',
    'productSellDiscount',
    'productPrice',
    'productStandardCost',
    'productUnitFactor',
    'productPackUnit',
    'productMinQty',
    'productMaxQty',
    'productLocation',
    'productWarehouse',
    'productSerial',
    'productBatch',
    'productExpiry',
    'productNote',
  ];
  fields.forEach((fid) => {
    const el = document.getElementById(fid) as HTMLInputElement | null;
    if (el) el.value = '';
  });

  (document.getElementById('productUnit') as HTMLSelectElement).value = 'عدد';
  (document.getElementById('productUnitFactor') as HTMLInputElement).value = '1';
  (document.getElementById('productSystemQty') as HTMLInputElement).value = '0';
  (document.getElementById('productPurchasePrice') as HTMLInputElement).value = '0';
  (document.getElementById('productConsumerPrice') as HTMLInputElement).value = '0';
  (document.getElementById('productSellDiscount') as HTMLInputElement).value = '0';
  (document.getElementById('productPrice') as HTMLInputElement).value = '0';
  (document.getElementById('productStandardCost') as HTMLInputElement).value = '0';
  (document.getElementById('productWarehouse') as HTMLInputElement).value =
    settings.currentWarehouse || 'انبار اصلی';

  if (id) {
    const p = products.find((x) => x.id === id);
    if (!p) {
      toast('کالا پیدا نشد', 'error');
      return;
    }
    if (title) title.textContent = 'ویرایش کالا';
    if (delBtn) delBtn.style.display = 'block';
    (document.getElementById('productId') as HTMLInputElement).value = p.id;
    (document.getElementById('productName') as HTMLInputElement).value = p.name || '';
    (document.getElementById('productCode') as HTMLInputElement).value = p.code || '';
    (document.getElementById('productSku') as HTMLInputElement).value = p.sku || '';
    (document.getElementById('productSystemQty') as HTMLInputElement).value = String(roundQty(Number(p.systemQty) || 0));
    ensureProductUnitOption(p.unit || 'عدد');
    (document.getElementById('productUnit') as HTMLSelectElement).value = p.unit || 'عدد';
    (document.getElementById('productPurchasePrice') as HTMLInputElement).value = String(p.purchasePrice ?? 0);
    const consumer = Number(p.consumerPrice ?? 0);
    const sell = Number(p.price ?? 0);
    let disc = Number(p.sellDiscountPercent ?? 0);
    if ((!disc || disc<=0) && consumer>0 && sell>=0 && sell<=consumer) {
      disc = Math.round((1 - sell/consumer) * 10000) / 100;
    }
    (document.getElementById('productConsumerPrice') as HTMLInputElement).value = String(consumer || sell || 0);
    (document.getElementById('productSellDiscount') as HTMLInputElement).value = String(disc || 0);
    (document.getElementById('productPrice') as HTMLInputElement).value = String(sell || consumer || 0);
    (document.getElementById('productStandardCost') as HTMLInputElement).value = String(p.standardCostRial ?? 0);
    (document.getElementById('productUnitFactor') as HTMLInputElement).value = String(p.unitFactor ?? 1);
    (document.getElementById('productPackUnit') as HTMLInputElement).value = p.packUnit || '';
    (document.getElementById('productMinQty') as HTMLInputElement).value =
      p.minQty != null ? String(p.minQty) : '';
    (document.getElementById('productMaxQty') as HTMLInputElement).value =
      p.maxQty != null ? String(p.maxQty) : '';
    (document.getElementById('productLocation') as HTMLInputElement).value = p.location || '';
    (document.getElementById('productWarehouse') as HTMLInputElement).value =
      p.warehouse || settings.currentWarehouse || '';
    (document.getElementById('productSerial') as HTMLInputElement).value = p.serial || '';
    (document.getElementById('productBatch') as HTMLInputElement).value = p.batch || '';
    (document.getElementById('productExpiry') as HTMLInputElement).value = p.expiry || '';
    (document.getElementById('productNote') as HTMLTextAreaElement).value = p.note || '';
  } else {
    if (title) title.textContent = 'کالای جدید';
    if (delBtn) delBtn.style.display = 'none';
    if (presetCode) {
      const looksLikeBarcode = /^[0-9۰-۹٠-٩\-\s]{4,}$/.test(presetCode.trim());
      if (looksLikeBarcode) {
        (document.getElementById('productCode') as HTMLInputElement).value = normalizeDigits(presetCode);
      } else if (!opts?.presetName) {
        (document.getElementById('productName') as HTMLInputElement).value = presetCode;
      } else {
        (document.getElementById('productCode') as HTMLInputElement).value = normalizeDigits(presetCode);
      }
    }
    if (opts?.presetName) {
      (document.getElementById('productName') as HTMLInputElement).value = opts.presetName;
    }
  }

  modal.style.display = 'flex';
  bindProductPriceSync();
  syncProductPriceFields('discount');
  setTimeout(() => document.getElementById('productName')?.focus(), 100);
}

export function closeProductModal(): void {
  const modal = document.getElementById('productModal');
  if (modal) modal.style.display = 'none';
  editingId = null;
  pendingProductSaveCallback = null;
}

export function saveProductFromForm(): boolean {
  // تعریف/ویرایش کالا نباید به قفل جلسهٔ شمارش وابسته باشد
  if (!guardPermission('inventory.edit', 'ذخیره کالا')) return false;

  const name = val('productName').trim();
  if (!name) {
    toast('نام الزامی است', 'error');
    document.getElementById('productName')?.focus();
    return false;
  }

  const id = val('productId').trim();
  const data = {
    name,
    code: normalizeDigits(val('productCode')).trim(),
    sku: val('productSku').trim(),
    unit: val('productUnit').trim() || 'عدد',
    unitFactor: num('productUnitFactor') || 1,
    packUnit: val('productPackUnit').trim() || undefined,
    systemQty: num('productSystemQty'),
    purchasePrice: num('productPurchasePrice'),
    consumerPrice: num('productConsumerPrice'),
    sellDiscountPercent: num('productSellDiscount'),
    price: num('productPrice'),
    standardCostRial: num('productStandardCost') || undefined,
    minQty: numOrNull('productMinQty'),
    maxQty: numOrNull('productMaxQty'),
    location: val('productLocation').trim(),
    warehouse: DEFAULT_WAREHOUSE,
    serial: val('productSerial').trim(),
    batch: val('productBatch').trim(),
    expiry: val('productExpiry').trim(),
    note: val('productNote').trim(),
  };

  // جلوگیری از بارکد تکراری روی کالای دیگر
  if (data.code) {
    const other = findProductByCode(data.code);
    if (other && other.id !== id) {
      toast('این بارکد قبلاً برای کالای دیگری ثبت شده', 'error');
      return false;
    }
  }

  let savedId = id;
  if (id) {
    const idx = products.findIndex((x) => x.id === id);
    if (idx < 0) {
      toast('کالا پیدا نشد', 'error');
      return false;
    }
    products[idx] = { ...products[idx], ...data };
    ensureProductStock(products[idx]);
    logAudit('product_edit', { id, name: data.name, code: data.code });
    toast('ویرایش شد', 'success');
  } else {
    const p: Product = {
      id: generateId('p'),
      ...data,
      countedQty: null,
      createdAt: new Date().toISOString(),
    };
    ensureProductStock(p);
    products.push(p);
    savedId = p.id;
    logAudit('product_add', { id: p.id, name: p.name, code: p.code });
    toast('کالا ثبت شد', 'success');
  }

  // ایندکس بارکد فوری تا در همان جلسهٔ شمارش قابل اسکن باشد
  rebuildIndex();
  invalidateStats();
  save(true);
  void flushSave().catch((e) => console.warn('product persist failed', e));
  notify();

  const cb = pendingProductSaveCallback;
  pendingProductSaveCallback = null;
  closeProductModal();
  if (cb && savedId) {
    try { cb(savedId); } catch (e) { console.warn('product onSaved failed', e); }
  }
  return true;
}

export function deleteProduct(id: string): boolean {
  if (!guardPermission('inventory.edit', 'حذف کالا')) return false;
  if (guardLocked()) return false;
  if (!confirm('این کالا حذف شود؟')) return false;
  const idx = products.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  const name = products[idx].name;
  products.splice(idx, 1);
  save(true);
  logAudit('product_delete', { id, name });
  toast('حذف شد', 'success');
  notify();
  closeProductModal();
  return true;
}

/** اتصال از اسکن یا جستجوی فاکتور وقتی کالا نیست */
export function offerAddProduct(
  codeOrName: string,
  opts?: { onSaved?: (productId: string) => void; asName?: boolean },
): void {
  const raw = (codeOrName || '').trim();
  if (!raw) return;
  const asName = opts?.asName ?? !/^[0-9۰-۹٠-٩\-\s]{4,}$/.test(raw);
  const label = asName ? `نام «${raw}»` : `بارکد «${normalizeDigits(raw)}»`;
  if (!confirm(`کالایی با ${label} پیدا نشد.\nآیا می‌خواهید همین الان تعریف کنید؟`)) return;
  openProductModal(
    null,
    asName ? undefined : normalizeDigits(raw),
    {
      presetName: asName ? raw : undefined,
      onSaved: opts?.onSaved,
    },
  );
}
