/**
 * لایه سازگاری موجودی — مدل فعلی برنامه: یک انبار
 * stockByWarehouse فقط برای سازگاری داده ذخیره می‌شود؛ منبع اصلی systemQty است.
 */
import type { Product } from '@/types';
import { roundQty } from '@/utils/helpers';

export const DEFAULT_WAREHOUSE = 'انبار اصلی';

export function warehouseName(value?: string | null): string {
  const w = String(value || '').trim();
  return w || DEFAULT_WAREHOUSE;
}

/** همگام‌سازی ایمن بدون recursion — همیشه یک انبار */
export function ensureProductStock(product: Product): Product {
  if (!product || typeof product !== 'object') return product;
  try {
    const wh = DEFAULT_WAREHOUSE;
    const qty = Number(product.systemQty);
    const safe = Number.isFinite(qty) ? roundQty(qty) : 0;
    product.warehouse = wh;
    product.systemQty = safe;
    product.stockByWarehouse = { [wh]: safe };
  } catch (e) {
    console.warn('[warehouse-stock] ensureProductStock failed', product?.id, e);
    product.warehouse = DEFAULT_WAREHOUSE;
    product.stockByWarehouse = { [DEFAULT_WAREHOUSE]: Number(product.systemQty) || 0 };
  }
  return product;
}

export function totalStock(product: Product): number {
  return Number(product.systemQty) || 0;
}

export function getWarehouseQty(product: Product, _warehouse?: string | null): number {
  return Number(product.systemQty) || 0;
}

export function primaryWarehouse(_product?: Product): string {
  return DEFAULT_WAREHOUSE;
}

export function setWarehouseQty(product: Product, _warehouse: string, qty: number): void {
  const n = Number(qty);
  if (!Number.isFinite(n)) throw new Error('مقدار موجودی نامعتبر است.');
  const safe = roundQty(n);
  product.systemQty = safe;
  product.warehouse = DEFAULT_WAREHOUSE;
  product.stockByWarehouse = { [DEFAULT_WAREHOUSE]: safe };
}

export function adjustWarehouseQty(product: Product, warehouse: string, delta: number): number {
  const next = (Number(product.systemQty) || 0) + (Number(delta) || 0);
  setWarehouseQty(product, warehouse, next);
  return next;
}

/** در مدل تک‌انباره انتقال بین انبار معنا ندارد */
export function transferWarehouseQty(
  product: Product,
  _fromWarehouse: string,
  _toWarehouse: string,
  qty: number,
  _options?: { allowNegative?: boolean }
): void {
  void product; void qty;
  throw new Error('در این نسخه فقط یک انبار فعال است؛ انتقال بین انبارها غیرفعال است.');
}

export function migrateProductsStock(list: Product[]): void {
  if (!Array.isArray(list)) return;
  for (const p of list) {
    try { ensureProductStock(p); } catch (e) { console.warn('[warehouse-stock] migrate skip', p?.id, e); }
  }
}

/** همه کالاها در انبار واحد دیده می‌شوند */
export function productVisibleInWarehouse(_product: Product, _warehouse: string): boolean {
  return true;
}
