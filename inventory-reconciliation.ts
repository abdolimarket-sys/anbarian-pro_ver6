/** گزارش تطبیق موجودی عملیاتی، بهای تمام‌شده و دفتر کل
 * این ماژول فقط گزارش می‌سازد و هیچ داده‌ای را تغییر نمی‌دهد.
 */
import type { Product } from '@/types';
import type { AccountingData } from './accounting';
import type { InventoryCostData } from './inventory-costing';

export type InventoryReconciliationIssue = 'quantity-mismatch' | 'value-missing' | 'negative-balance' | 'orphan-cost-balance';
export interface InventoryReconciliationRow {
  productId:string; productName:string; warehouse:string;
  systemQtyMilli:number; costQtyMilli:number; quantityDiffMilli:number;
  valueRial:number; averageUnitCostRial:number; issue:InventoryReconciliationIssue|null;
}
export interface InventoryReconciliationReport {
  rows:InventoryReconciliationRow[]; totalProducts:number; issueCount:number;
  systemQuantityMilli:number; costQuantityMilli:number; quantityDiffMilli:number;
  inventoryValueRial:number; ledgerInventoryRial:number; ledgerDiffRial:number;
  ledgerAccountTitle:string; ledgerAccountFound:boolean;
}

/**
 * مقدار کالاها در state عملیاتی با موجودی بهای تمام‌شده به تفکیک انبار مقایسه می‌شود.
 * دفتر کل فقط خطوط ثبت‌شده روی حساب معین «موجودی کالا» را جمع می‌کند تا والد و فرزند دوباره‌شماری نشوند.
 */
export function buildInventoryReconciliation(products:Product[], costing:InventoryCostData, accounting:AccountingData):InventoryReconciliationReport {
  const key=(productId:string,warehouse:string)=>`${productId}\u0000${warehouse}`;
  const operational=new Map<string,{productId:string;productName:string;warehouse:string;qty:number}>();
  for(const p of products){
    const warehouse=(p.warehouse||'انبار اصلی').trim()||'انبار اصلی';
    const k=key(p.id,warehouse), old=operational.get(k);
    const qty=Math.round((Number.isFinite(Number(p.systemQty))?Number(p.systemQty):0)*1000);
    if(old)old.qty+=qty; else operational.set(k,{productId:p.id,productName:p.name,warehouse,qty});
  }
  const costMap=new Map(costing.balances.map(b=>[key(b.productId,b.warehouse),b]));
  const keys=new Set([...operational.keys(),...costMap.keys()]);
  const rows:InventoryReconciliationRow[]=[];
  for(const k of keys){
    const op=operational.get(k), b=costMap.get(k);
    const productId=op?.productId||b!.productId, warehouse=op?.warehouse||b!.warehouse;
    const systemQtyMilli=op?.qty||0, costQtyMilli=b?.qtyMilli||0;
    const quantityDiffMilli=systemQtyMilli-costQtyMilli;
    let issue:InventoryReconciliationIssue|null=null;
    if(costQtyMilli<0)issue='negative-balance';
    else if(!op&&b)issue='orphan-cost-balance';
    else if(Math.abs(quantityDiffMilli)>0)issue='quantity-mismatch';
    else if(costQtyMilli>0&&(!b||b.valueRial<=0))issue='value-missing';
    rows.push({productId,productName:op?.productName||`کالای حذف‌شده (${productId})`,warehouse,systemQtyMilli,costQtyMilli,quantityDiffMilli,valueRial:b?.valueRial||0,averageUnitCostRial:b?.averageUnitCostRial||0,issue});
  }
  rows.sort((a,b)=>Number(!!b.issue)-Number(!!a.issue)||a.productName.localeCompare(b.productName,'fa'));
  const inventoryAccount=accounting.accounts.find(a=>a.id==='sub-inventory');
  const ledgerInventoryRial=inventoryAccount?accounting.journalEntries.filter(j=>j.status==='posted').flatMap(j=>j.lines).filter(l=>l.accountId===inventoryAccount.id).reduce((s,l)=>s+l.debitRial-l.creditRial,0):0;
  const inventoryValueRial=costing.balances.reduce((s,b)=>s+b.valueRial,0);
  const systemQuantityMilli=rows.reduce((s,r)=>s+r.systemQtyMilli,0), costQuantityMilli=rows.reduce((s,r)=>s+r.costQtyMilli,0);
  return {rows,totalProducts:rows.length,issueCount:rows.filter(r=>r.issue!==null).length,systemQuantityMilli,costQuantityMilli,quantityDiffMilli:systemQuantityMilli-costQuantityMilli,inventoryValueRial,ledgerInventoryRial,ledgerDiffRial:inventoryValueRial-ledgerInventoryRial,ledgerAccountTitle:inventoryAccount?.title||'حساب معین موجودی کالا یافت نشد',ledgerAccountFound:!!inventoryAccount};
}
