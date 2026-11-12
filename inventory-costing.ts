/** موتور بهای تمام‌شده و اتصال گردش فاکتور به موجودی */
import { idbGet, idbPut } from './storage';
import type { AccountingSettings } from './accounting';

export interface CostLayer { id:string; productId:string; warehouse:string; qtyMilli:number; unitCostRial:number; date:string; sourceDocumentId:string; }
export interface CostBalance { productId:string; warehouse:string; qtyMilli:number; valueRial:number; averageUnitCostRial:number; }
export interface StockMovement { id:string; sourceDocumentId:string; productId:string; warehouse:string; type:'purchase'|'sale'; qtyMilli:number; unitCostRial:number; totalCostRial:number; beforeQtyMilli:number; afterQtyMilli:number; date:string; provisional:boolean; }
export interface InventoryCostData { schemaVersion:1; layers:CostLayer[]; balances:CostBalance[]; movements:StockMovement[]; }
const KEY='accounting_phase23_costing', BACKUP='accounting_phase23_costing_backup';
const id=(p:string)=>`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export const emptyInventoryCostData=():InventoryCostData=>({schemaVersion:1,layers:[],balances:[],movements:[]});
export async function loadInventoryCostData():Promise<InventoryCostData>{
  for(const key of [KEY,BACKUP])try{const x=await idbGet<InventoryCostData>(key);if(x?.schemaVersion===1&&Array.isArray(x.layers)&&Array.isArray(x.balances)&&Array.isArray(x.movements))return x;}catch(e){console.warn('costing read failed',e)}
  return emptyInventoryCostData();
}
export async function saveInventoryCostData(x:InventoryCostData):Promise<void>{if(x.schemaVersion!==1)throw new Error('ساختار بهای تمام‌شده معتبر نیست.');await idbPut(BACKUP,x);await idbPut(KEY,x)}
export function seedOpeningStock(data:InventoryCostData,productId:string,warehouse:string,qtyMilli:number):void{if(!data.balances.some(x=>x.productId===productId&&x.warehouse===warehouse)&&qtyMilli>0)throw new Error('برای موجودی اول دوره، ابتدا بهای واحد موجودی را در بخش «ارزش‌گذاری موجودی اولیه» ثبت کنید.');}
export function setOpeningStockCost(data:InventoryCostData,input:{productId:string;warehouse:string;qtyMilli:number;unitCostRial:number;date:string}):InventoryCostData{if(!safe(input.qtyMilli)||input.qtyMilli<=0||!safe(input.unitCostRial)||input.unitCostRial<=0)throw new Error('تعداد و بهای واحد موجودی اولیه باید بیشتر از صفر باشد.');if(data.movements.some(m=>m.productId===input.productId&&m.warehouse===input.warehouse))throw new Error('برای این کالا گردش ثبت شده؛ ارزش‌گذاری اولیه پس از شروع گردش مجاز نیست.');if(data.balances.some(b=>b.productId===input.productId&&b.warehouse===input.warehouse))throw new Error('موجودی اولیه این کالا قبلاً ارزش‌گذاری شده است.');const value=Math.round(input.qtyMilli*input.unitCostRial/1000);setBalance(data,{productId:input.productId,warehouse:input.warehouse,qtyMilli:input.qtyMilli,valueRial:value,averageUnitCostRial:input.unitCostRial});data.layers.push({id:id('opening'),productId:input.productId,warehouse:input.warehouse,qtyMilli:input.qtyMilli,unitCostRial:input.unitCostRial,date:input.date,sourceDocumentId:`opening:${input.productId}:${input.warehouse}`});return data;}
export function getCostBalance(data:InventoryCostData,productId:string,warehouse:string):CostBalance{return data.balances.find(x=>x.productId===productId&&x.warehouse===warehouse)||{productId,warehouse,qtyMilli:0,valueRial:0,averageUnitCostRial:0}}
function setBalance(data:InventoryCostData,b:CostBalance){const i=data.balances.findIndex(x=>x.productId===b.productId&&x.warehouse===b.warehouse);if(i<0)data.balances.push(b);else data.balances[i]=b}
/**
 * خرید: ثبت لایه FIFO و به‌روزرسانی میانگین متحرک.
 * unitCostRial = بهای ثبت در موجودی (واقعی یا استاندارد).
 * actualUnitCostRial اختیاری: بهای واقعی فاکتور برای محاسبه انحراف (اگر با واحد ثبت فرق کند).
 */
export function receiveStock(data:InventoryCostData,input:{productId:string;warehouse:string;qtyMilli:number;unitCostRial:number;date:string;sourceDocumentId:string;actualUnitCostRial?:number}):{data:InventoryCostData;totalCostRial:number;inventoryValueRial:number;negativeOffsetCostRial:number;priceVarianceRial:number}{
  if(!safe(input.qtyMilli)||input.qtyMilli<=0||!safe(input.unitCostRial))throw new Error('مقدار یا بهای خرید نامعتبر است.');
  if(data.movements.some(m=>m.sourceDocumentId===input.sourceDocumentId&&m.productId===input.productId)){
    const old=data.movements.find(m=>m.sourceDocumentId===input.sourceDocumentId&&m.productId===input.productId)!;
    return {data,totalCostRial:old.totalCostRial,inventoryValueRial:old.totalCostRial,negativeOffsetCostRial:0,priceVarianceRial:0};
  }
  const total=Math.round(input.qtyMilli*input.unitCostRial/1000);
  // actualUnitCostRial فقط وقتی جدا از بهای ثبت موجودی است معنا دارد (انحراف قیمت)
  const hasActual=input.actualUnitCostRial!=null && Number.isFinite(input.actualUnitCostRial) && (input.actualUnitCostRial as number)>=0;
  const actualUnit=hasActual?Math.round(input.actualUnitCostRial as number):input.unitCostRial;
  const actualTotal=Math.round(input.qtyMilli*actualUnit/1000);
  const priceVarianceRial=actualTotal-total; // مثبت = بهای واقعی بالاتر از بهای ثبت‌شده در موجودی
  const b=getCostBalance(data,input.productId,input.warehouse);const nextQty=b.qtyMilli+input.qtyMilli;
  // رسید ابتدا کسری منفی قبلی را پوشش می‌دهد؛ فقط بخش باقی‌مانده دارایی موجودی می‌شود.
  const offsetQty=Math.min(input.qtyMilli,Math.max(0,-b.qtyMilli));const remainingQty=input.qtyMilli-offsetQty;const negativeOffsetCostRial=Math.round(offsetQty*input.unitCostRial/1000);const inventoryValueRial=Math.round(remainingQty*input.unitCostRial/1000);const nextValue=(b.qtyMilli<0?inventoryValueRial:Math.max(0,b.valueRial)+total);setBalance(data,{...b,qtyMilli:nextQty,valueRial:nextValue,averageUnitCostRial:nextQty>0?Math.round(nextValue*1000/nextQty):0});
  if(remainingQty>0)data.layers.push({id:id('layer'),productId:input.productId,warehouse:input.warehouse,qtyMilli:remainingQty,unitCostRial:input.unitCostRial,date:input.date,sourceDocumentId:input.sourceDocumentId});
  data.movements.push({id:id('move'),sourceDocumentId:input.sourceDocumentId,productId:input.productId,warehouse:input.warehouse,type:'purchase',qtyMilli:input.qtyMilli,unitCostRial:input.unitCostRial,totalCostRial:total,beforeQtyMilli:b.qtyMilli,afterQtyMilli:nextQty,date:input.date,provisional:false});
  return {data,totalCostRial:total,inventoryValueRial,negativeOffsetCostRial,priceVarianceRial};
}
/** فروش: مصرف FIFO یا میانگین متحرک؛ کسری فقط با تنظیم همان انبار مجاز است. */
export function issueStock(data:InventoryCostData,input:{productId:string;warehouse:string;qtyMilli:number;date:string;sourceDocumentId:string;method:AccountingSettings['defaultCostingMethod'];allowNegative:boolean;productName?:string}):{data:InventoryCostData;totalCostRial:number;provisional:boolean}{
  if(!safe(input.qtyMilli)||input.qtyMilli<=0)throw new Error('مقدار خروج نامعتبر است.');
  if(data.movements.some(m=>m.sourceDocumentId===input.sourceDocumentId&&m.productId===input.productId)){const m=data.movements.find(m=>m.sourceDocumentId===input.sourceDocumentId&&m.productId===input.productId)!;return {data,totalCostRial:m.totalCostRial,provisional:m.provisional};}
  const b=getCostBalance(data,input.productId,input.warehouse);
  if(!input.allowNegative&&b.qtyMilli<input.qtyMilli){
    const name=(input.productName||'').trim() || 'نامشخص';
    const have=b.qtyMilli/1000;
    const need=input.qtyMilli/1000;
    throw new Error(`کالای «${name}» موجودی ندارد. موجودی فعلی: ${have} — مقدار درخواستی: ${need} (انبار: ${input.warehouse})`);
  }
  let remaining=input.qtyMilli,total=0;const provisional=b.qtyMilli<input.qtyMilli;
  if(input.method==='fifo'){
    const layers=data.layers.filter(l=>l.productId===input.productId&&l.warehouse===input.warehouse&&l.qtyMilli>0).sort((a,b)=>a.date.localeCompare(b.date));
    for(const layer of layers){if(!remaining)break;const take=Math.min(remaining,layer.qtyMilli);total+=Math.round(take*layer.unitCostRial/1000);layer.qtyMilli-=take;remaining-=take;}
    // کسری منفی با بهای موقت صفر ثبت می‌شود؛ خرید بعدی هزینه واقعی کسری را به بهای تمام‌شده منتقل می‌کند.
  }else total=Math.round(Math.min(input.qtyMilli,Math.max(0,b.qtyMilli))*b.averageUnitCostRial/1000);
  const nextQty=b.qtyMilli-input.qtyMilli;const nextValue=Math.max(0,b.valueRial-total);setBalance(data,{...b,qtyMilli:nextQty,valueRial:nextValue,averageUnitCostRial:nextQty>0?Math.round(nextValue*1000/nextQty):b.averageUnitCostRial});
  data.movements.push({id:id('move'),sourceDocumentId:input.sourceDocumentId,productId:input.productId,warehouse:input.warehouse,type:'sale',qtyMilli:input.qtyMilli,unitCostRial:input.qtyMilli?Math.round(total*1000/input.qtyMilli):0,totalCostRial:total,beforeQtyMilli:b.qtyMilli,afterQtyMilli:nextQty,date:input.date,provisional});return {data,totalCostRial:total,provisional};
}

/** ——— NRV (IAS 2): بهای تمام‌شده یا خالص ارزش فروش، هرکدام کمتر ——— */

export interface NrvRow {
  productId: string;
  productName: string;
  warehouse: string;
  quantityMilli: number;
  costUnitRial: number;
  costValueRial: number;
  /** قیمت فروش واحد مبنای NRV (ریال) */
  sellingUnitRial: number;
  /** درصد هزینه فروش برآوردی از قیمت فروش (۰–۱۰۰) */
  sellingCostPercent: number;
  nrvUnitRial: number;
  nrvValueRial: number;
  /** ارزش گزارش‌شده = min(cost, NRV) */
  reportedValueRial: number;
  writeDownRial: number;
  hasSellingPrice: boolean;
}

/**
 * خالص ارزش فروش واحد = قیمت فروش − هزینه برآوردی تکمیل/فروش
 * قیمت فروش: price (فروش) و در صورت نبود consumerPrice
 */
export function estimateNrvUnitRial(
  product: { price?: number; consumerPrice?: number } | undefined,
  sellingCostPercent = 0,
): { sellingUnitRial: number; nrvUnitRial: number; hasSellingPrice: boolean } {
  const selling = Math.max(0, Math.round(Number(product?.price) || Number(product?.consumerPrice) || 0));
  if (selling <= 0) return { sellingUnitRial: 0, nrvUnitRial: 0, hasSellingPrice: false };
  const pct = Math.min(100, Math.max(0, Number(sellingCostPercent) || 0));
  const nrv = Math.max(0, Math.round(selling * (1 - pct / 100)));
  return { sellingUnitRial: selling, nrvUnitRial: nrv, hasSellingPrice: true };
}

export function buildNrvAnalysis(
  data: InventoryCostData,
  productList: Array<{ id: string; name: string; price?: number; consumerPrice?: number }>,
  opts?: { sellingCostPercent?: number },
): NrvRow[] {
  const pct = opts?.sellingCostPercent ?? 0;
  const rows: NrvRow[] = [];
  for (const b of data.balances) {
    if (!b.qtyMilli || b.qtyMilli <= 0) continue;
    const p = productList.find(x => x.id === b.productId);
    const est = estimateNrvUnitRial(p, pct);
    const costUnit = b.qtyMilli > 0 ? Math.round((b.valueRial * 1000) / b.qtyMilli) : b.averageUnitCostRial;
    const costValue = Math.max(0, b.valueRial);
    const nrvValue = est.hasSellingPrice ? Math.round((b.qtyMilli * est.nrvUnitRial) / 1000) : costValue;
    const reported = est.hasSellingPrice ? Math.min(costValue, nrvValue) : costValue;
    const writeDown = Math.max(0, costValue - reported);
    rows.push({
      productId: b.productId,
      productName: p?.name || b.productId,
      warehouse: b.warehouse,
      quantityMilli: b.qtyMilli,
      costUnitRial: costUnit,
      costValueRial: costValue,
      sellingUnitRial: est.sellingUnitRial,
      sellingCostPercent: pct,
      nrvUnitRial: est.nrvUnitRial,
      nrvValueRial: nrvValue,
      reportedValueRial: reported,
      writeDownRial: writeDown,
      hasSellingPrice: est.hasSellingPrice,
    });
  }
  return rows.sort((a, b) => b.writeDownRial - a.writeDownRial || a.productName.localeCompare(b.productName, 'fa'));
}

/**
 * اعمال کاهش ارزش موجودی تا سطح NRV (فقط کاهش ارزش دفتر بها؛ تعداد تغییر نمی‌کند).
 * لایه‌های FIFO نیز به‌نسبت کاهش می‌یابند تا میانگین/خروج بعدی سازگار بماند.
 */
/** انحراف بهای استاندارد نسبت به خرید واقعی (از روی فاکتور خرید قطعی) */
export interface StandardCostVarianceRow {
  productId: string;
  productName: string;
  invoiceId: string;
  invoiceNumber: string;
  date: string;
  quantityMilli: number;
  standardUnitRial: number;
  actualUnitRial: number;
  standardTotalRial: number;
  actualTotalRial: number;
  varianceRial: number; // actual - standard ؛ مثبت = نامساعد
}

export function buildPurchaseStandardVariance(
  invoices: Array<{
    id: string;
    number: string;
    date: string;
    type: string;
    status: string;
    lines: Array<{ productId?: string; quantityMilli: number; unitPriceRial: number; allocatedLandedRial?: number; description?: string }>;
  }>,
  productList: Array<{ id: string; name: string; standardCostRial?: number }>,
): StandardCostVarianceRow[] {
  const rows: StandardCostVarianceRow[] = [];
  for (const inv of invoices) {
    if (inv.type !== 'purchase' || inv.status !== 'posted') continue;
    for (const line of inv.lines) {
      if (!line.productId || line.quantityMilli <= 0) continue;
      const p = productList.find(x => x.id === line.productId);
      const std = Math.round(Number(p?.standardCostRial) || 0);
      if (std <= 0) continue;
      const landedShare = Math.max(0, Math.round(Number(line.allocatedLandedRial) || 0));
      const actualTotal = Math.round(line.quantityMilli * line.unitPriceRial / 1000) + landedShare;
      const actualUnit = line.quantityMilli > 0 ? Math.round(actualTotal * 1000 / line.quantityMilli) : line.unitPriceRial;
      const standardTotal = Math.round(line.quantityMilli * std / 1000);
      rows.push({
        productId: line.productId,
        productName: p?.name || line.description || line.productId,
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        date: inv.date,
        quantityMilli: line.quantityMilli,
        standardUnitRial: std,
        actualUnitRial: actualUnit,
        standardTotalRial: standardTotal,
        actualTotalRial: actualTotal,
        varianceRial: actualTotal - standardTotal,
      });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.productName.localeCompare(b.productName, 'fa'));
}

export function applyNrvWriteDown(
  data: InventoryCostData,
  input: { productId: string; warehouse: string; writeDownRial: number },
): InventoryCostData {
  if (!safe(input.writeDownRial) || input.writeDownRial <= 0) throw new Error('مبلغ کاهش ارزش باید بیشتر از صفر باشد.');
  const b = getCostBalance(data, input.productId, input.warehouse);
  if (b.qtyMilli <= 0) throw new Error('برای این کالا موجودی مثبت جهت کاهش ارزش وجود ندارد.');
  if (input.writeDownRial > b.valueRial) throw new Error('مبلغ کاهش ارزش نمی‌تواند از ارزش دفتری موجودی بیشتر باشد.');
  const nextValue = b.valueRial - input.writeDownRial;
  const nextAvg = b.qtyMilli > 0 ? Math.round((nextValue * 1000) / b.qtyMilli) : 0;
  // کاهش تناسبی بهای لایه‌های باقی‌مانده
  const layers = data.layers.filter(l => l.productId === input.productId && l.warehouse === input.warehouse && l.qtyMilli > 0);
  const layerValue = layers.reduce((s, l) => s + Math.round((l.qtyMilli * l.unitCostRial) / 1000), 0);
  if (layers.length && layerValue > 0 && nextValue >= 0) {
    const ratio = nextValue / layerValue;
    for (const layer of layers) {
      layer.unitCostRial = Math.max(0, Math.round(layer.unitCostRial * ratio));
    }
  }
  setBalance(data, { ...b, valueRial: nextValue, averageUnitCostRial: nextAvg });
  return data;
}
