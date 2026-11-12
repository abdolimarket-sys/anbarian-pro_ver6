/** مرکز سلامت داده‌ها؛ تمام بررسی‌ها فقط‌خواندنی هستند. */
import { products, auditLog, verifyAuditIntegrity, storageBackend } from './state';
import { idbGet } from './storage';
import { loadAccountingData } from './accounting';
import { loadCommerceData } from './accounting-commerce';
import { loadInventoryCostData } from './inventory-costing';
import { esc } from '@/utils/helpers';

export type HealthLevel = 'error' | 'warning' | 'info' | 'ok';
export interface HealthFinding { level: HealthLevel; title: string; detail: string; count?: number; }
export interface HealthReport { checkedAt:string; findings:HealthFinding[]; totals:{errors:number;warnings:number;info:number;ok:number}; }

export function analyzeHealth(input:{products:any[];auditValid:boolean;auditChecked:number;auditLegacy:number;accounting:any;commerce:any;costing:any;backupAvailable:boolean;backend:string}):HealthReport {
  const findings:HealthFinding[]=[];
  const add=(level:HealthLevel,title:string,detail:string,count?:number)=>findings.push({level,title,detail,count});
  const ids=new Set<string>(), codes=new Map<string,number>(); let duplicateIds=0,duplicateCodes=0,invalidQty=0;
  for(const p of input.products){
    const id=String(p?.id??''); if(!id||ids.has(id))duplicateIds++; else ids.add(id);
    const code=String(p?.code??'').trim(); if(code){const key=code.replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).toLowerCase();codes.set(key,(codes.get(key)||0)+1)}
    if(!Number.isFinite(Number(p?.systemQty))||Number(p.systemQty)<0)invalidQty++;
  }
  duplicateCodes=[...codes.values()].filter(n=>n>1).reduce((s,n)=>s+n-1,0);
  if(duplicateIds)add('error','شناسه کالای خالی یا تکراری',`${duplicateIds} مورد شناسه خالی/تکراری یافت شد.`,duplicateIds); else add('ok','شناسه کالاها','شناسه کالاها تکراری نیست.');
  if(duplicateCodes)add('warning','بارکدهای تکراری',`${duplicateCodes} مورد بارکد تکراری وجود دارد؛ قبل از اسکن انبوه بررسی شود.`,duplicateCodes); else add('ok','یکتایی بارکد','بارکد تکراری در فهرست فعلی پیدا نشد.');
  if(invalidQty)add('error','مقادیر موجودی نامعتبر',`${invalidQty} کالا مقدار موجودی منفی یا غیرعددی دارد.`,invalidQty); else add('ok','مقادیر موجودی','مقادیر موجودی عملیاتی معتبر هستند.');
  if(!input.auditValid)add('error','سلامت زنجیره لاگ','امضای زنجیره‌ای تاریخچه عملیات ناسازگار است؛ لاگ را پاک یا بازنویسی نکنید و نسخه پشتیبان را بررسی کنید.');
  else add('ok','سلامت زنجیره لاگ',`${input.auditChecked} رویداد امضاشده بررسی شد؛ ${input.auditLegacy} رویداد قدیمی بدون امضا وجود دارد.`);
  const a=input.accounting; let unbalanced=0,duplicateJournal=0; const jids=new Set<string>(), nums=new Set<string>();
  for(const j of a.journalEntries||[]){if(!j?.id||jids.has(j.id))duplicateJournal++;else jids.add(j.id);const nk=String(j.number??'');if(nk&&nums.has(nk))duplicateJournal++;else if(nk)nums.add(nk);
    if(j.status==='posted'){const debit=(j.lines||[]).reduce((s:number,l:any)=>s+(Number(l.debitRial)||0),0),credit=(j.lines||[]).reduce((s:number,l:any)=>s+(Number(l.creditRial)||0),0);if(!Number.isFinite(debit)||!Number.isFinite(credit)||Math.abs(debit-credit)>0)unbalanced++;}}
  if(unbalanced)add('error','اسناد قطعی نامتوازنه',`${unbalanced} سند قطعی تراز بدهکار و بستانکار ندارد.`,unbalanced);else add('ok','توازن اسناد قطعی','اسناد قطعی موجود از نظر جمع بدهکار و بستانکار متوازن هستند.');
  if(duplicateJournal)add('warning','شناسه یا شماره سند تکراری',`${duplicateJournal} مورد شناسه/شماره تکراری در اسناد حسابداری یافت شد.`,duplicateJournal);
  const parties=new Set((input.commerce.parties||[]).map((p:any)=>p.id)); const orphanInvoices=(input.commerce.invoices||[]).filter((i:any)=>i.partyId&&!parties.has(i.partyId)).length;
  if(orphanInvoices)add('warning','فاکتور با طرف حساب ناموجود',`${orphanInvoices} فاکتور به طرف حسابی ارجاع می‌دهد که در فهرست طرف‌حساب‌ها نیست.`,orphanInvoices);
  const balKeys=new Set<string>();let duplicateBalances=0,negativeBalances=0,badCost=0;
  for(const b of input.costing.balances||[]){const k=`${b.productId}|${b.warehouse}`;if(balKeys.has(k))duplicateBalances++;balKeys.add(k);if(Number(b.qtyMilli)<0)negativeBalances++;if(!Number.isFinite(Number(b.valueRial))||Number(b.valueRial)<0)badCost++;}
  if(duplicateBalances)add('error','مانده بهای تمام‌شده تکراری',`${duplicateBalances} ترکیب کالا/انبار بیش از یک مانده دارد.`,duplicateBalances);
  if(negativeBalances)add('warning','مانده منفی بهای تمام‌شده',`${negativeBalances} مانده منفی شناسایی شد.`,negativeBalances);
  if(badCost)add('error','ارزش‌گذاری نامعتبر',`${badCost} مانده ارزش ریالی نامعتبر دارد.`,badCost);
  if(!input.backupAvailable)add('warning','نسخه پشتیبان خودکار پیدا نشد','کلید پشتیبان خودکار در ذخیره‌ساز در دسترس نیست؛ پیش از عملیات حساس، خروجی پشتیبان مستقل بگیرید.');
  else add('ok','وجود نسخه پشتیبان خودکار','حداقل یک نسخه پشتیبان خودکار در ذخیره‌ساز پیدا شد.');
  if(input.backend==='localStorage')add('warning','ذخیره‌سازی جایگزین','برنامه از ذخیره‌سازی جایگزین استفاده می‌کند؛ وضعیت پایداری داده را بررسی کنید.');
  else add('info','وضعیت ذخیره‌سازی',`مسیر ذخیره‌سازی گزارش‌شده: ${input.backend}.`);
  if(!findings.length)add('ok','سلامت داده‌ها','بررسی‌ها بدون مغایرت انجام شد.');
  return {checkedAt:new Date().toISOString(),findings,totals:{errors:findings.filter(x=>x.level==='error').length,warnings:findings.filter(x=>x.level==='warning').length,info:findings.filter(x=>x.level==='info').length,ok:findings.filter(x=>x.level==='ok').length}};
}

export async function collectHealthReport():Promise<HealthReport>{
  const [accounting,commerce,costing,backup,previous]=await Promise.all([
    loadAccountingData(),loadCommerceData(),loadInventoryCostData(),idbGet<unknown>('autobackup').catch(()=>undefined),idbGet<unknown>('autobackup_prev').catch(()=>undefined)
  ]);
  const audit=verifyAuditIntegrity();
  return analyzeHealth({products,auditValid:audit.valid,auditChecked:audit.checked,auditLegacy:audit.legacy,accounting,commerce,costing,backupAvailable:!!backup||!!previous,backend:storageBackend});
}

export async function renderDataHealth(containerId='dataHealthWorkspace'):Promise<void>{
  const host=document.getElementById(containerId);if(!host)return;
  host.innerHTML='<p class="hint">در حال بررسی سلامت داده‌ها...</p>';
  try{const report=await collectHealthReport();const labels:Record<HealthLevel,string>={error:'خطا',warning:'هشدار',info:'اطلاعات',ok:'سالم'};
    const rows=report.findings.map(f=>`<div class="health-finding health-${f.level}"><div><b>${esc(labels[f.level])} — ${esc(f.title)}</b><p>${esc(f.detail)}</p></div>${f.count!==undefined?`<strong>${f.count}</strong>`:''}</div>`).join('');
    host.innerHTML=`<div class="health-summary"><div><b>${report.totals.errors}</b><span>خطا</span></div><div><b>${report.totals.warnings}</b><span>هشدار</span></div><div><b>${report.totals.ok}</b><span>مورد سالم</span></div></div><p class="hint">زمان بررسی: ${esc(new Date(report.checkedAt).toLocaleString('fa-IR'))} — این گزارش فقط‌خواندنی است و هیچ داده‌ای را اصلاح یا حذف نمی‌کند.</p>${rows}`;
  }catch(e){host.innerHTML=`<p class="hint">بررسی کامل نشد: ${esc(e instanceof Error?e.message:'خطای نامشخص')}</p>`;}
}
