/** خروجی آفلاین داشبورد مدیریتی */
import { buildOfflineXlsx } from './import-export';
import { getAgingDashboard } from './accounting-aging';
import { getCashflowDashboard } from './accounting-cashflow';
import { getProfitabilityDashboard, getProfitabilityPeriodComparison, type ProfitabilityFilter } from './accounting-profitability';
import { getBankAccountBalances } from './accounting-bank';
import { loadCommerceData } from './accounting-commerce';
import { products } from './state';
import { printHtmlSafely } from '@/utils/helpers';
import { choosePaperSize } from './print-paper';

const fa=(n:number)=>new Intl.NumberFormat('fa-IR').format(Math.round(Number(n)||0));
const normalize=(v:string)=>String(v||'').replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/-/g,'/').slice(0,10);
function todayJalali():string{
 const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 return `${parts.find(x=>x.type==='year')?.value}/${parts.find(x=>x.type==='month')?.value}/${parts.find(x=>x.type==='day')?.value}`;
}
function download(bytes:Uint8Array,type:string,name:string):void{
 const blob=new Blob([bytes],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function collect(filter:ProfitabilityFilter={}){
 const periods=await getProfitabilityPeriodComparison();const period=periods.find(x=>x.periodId===filter.fiscalPeriodId);
 const from=normalize(filter.fromDate||period?.startDate||'');const to=normalize(filter.toDate||period?.endDate||'');const asOf=to||todayJalali();
 const inRange=(date:string)=>{const d=normalize(date);return (!from||d>=from)&&(!to||d<=to)};
 const [commerce,profit,aging,cashflow,banks]=await Promise.all([loadCommerceData(),getProfitabilityDashboard(filter),getAgingDashboard(asOf),getCashflowDashboard(asOf),getBankAccountBalances()]);
 const sales=commerce.invoices.filter(x=>x.status==='posted'&&x.type==='sale'&&inRange(x.date));
 const low=products.filter(p=>p.minQty!==null&&p.minQty!==undefined&&Number.isFinite(Number(p.minQty))&&p.systemQty<=Number(p.minQty));
 return {from,to,asOf,profit,aging,cashflow,banks,sales,low,stockQty:products.reduce((n,p)=>n+Math.max(0,Number(p.systemQty)||0),0),bankTotal:banks.reduce((n,a)=>n+a.balanceRial,0)};
}
export async function exportManagementDashboardXlsx(filter:ProfitabilityFilter={}):Promise<void>{
 const d=await collect(filter);const net30=d.cashflow.next30InRial-d.cashflow.next30OutRial;
 const rows:[string,number|string][]=[
  ['فروش قطعی در بازه',d.profit.salesRial],['فروش فاکتورهای قطعی',d.sales.reduce((n,x)=>n+x.grossRial,0)],['سود ناخالص قابل محاسبه',d.profit.grossProfitRial],['فروش دارای بهای معتبر',d.profit.costedSalesRial],['بهای تمام‌شده',d.profit.cogsRial],['مطالبات باز تا تاریخ مبنا',d.aging.receivableRial],['بدهی باز تا تاریخ مبنا',d.aging.payableRial],['مانده دفتری بانک و صندوق فعلی',d.bankTotal],['ورودی پیش‌بینی ۳۰ روز',d.cashflow.next30InRial],['خروجی پیش‌بینی ۳۰ روز',d.cashflow.next30OutRial],['خالص پیش‌بینی ۳۰ روز',net30],['تعداد کالا',products.length],['تعداد کالاهای در حداقل موجودی',d.low.length],['جمع تعداد موجودی فعلی',d.stockQty],['تعداد فاکتور فروش قطعی در بازه',d.sales.length]
 ];
 const sheets=[
  {name:'شاخص‌های داشبورد',rows:[['شاخص','مقدار'],...rows,['از تاریخ',d.from||'بدون محدودیت'],['تا تاریخ',d.to||'بدون محدودیت'],['تاریخ مبنای مطالبات و نقدینگی',d.asOf]]},
  {name:'فروش‌های قطعی',rows:[['شماره فاکتور','تاریخ','مبلغ ریال','وضعیت'],...d.sales.map(x=>[x.number,x.date,x.grossRial,x.status])]},
  {name:'مطالبات و بدهی',rows:[['نوع','مبلغ ریال'],['مطالبات باز',d.aging.receivableRial],['بدهی باز',d.aging.payableRial],['مطالبات سررسیدگذشته',d.aging.overdueReceivableRial],['بدهی سررسیدگذشته',d.aging.overduePayableRial]]},
  {name:'پیش‌بینی نقدینگی',rows:[['شاخص','مبلغ ریال'],['ورودی ۳۰ روز',d.cashflow.next30InRial],['خروجی ۳۰ روز',d.cashflow.next30OutRial],['خالص ۳۰ روز',net30],['ورودی ۷ روز',d.cashflow.next7InRial],['خروجی ۷ روز',d.cashflow.next7OutRial]]},
  {name:'وضعیت موجودی',rows:[['شاخص','مقدار'],['تعداد کالا',products.length],['جمع تعداد موجودی',d.stockQty],['تعداد در حداقل موجودی',d.low.length],...d.low.map(x=>[x.name,Number(x.systemQty)||0])]},
  {name:'بانک و صندوق',rows:[['حساب','مانده ریال'],...d.banks.map(x=>[x.title,x.balanceRial])]},
 ];
 download(buildOfflineXlsx(sheets),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','anbarin-management-dashboard-phase50.xlsx');
}
export async function printManagementDashboardPdf(filter:ProfitabilityFilter={}):Promise<void>{
  const size=await choosePaperSize({mode:'document',title:'سایز چاپ داشبورد مدیریتی'});
  if(!size)return;
  const d=await collect(filter);const net30=d.cashflow.next30InRial-d.cashflow.next30OutRial;
 const values:[string,number][]=[['فروش قطعی در بازه',d.profit.salesRial],['سود ناخالص قابل محاسبه',d.profit.grossProfitRial],['مطالبات باز',d.aging.receivableRial],['بدهی باز',d.aging.payableRial],['مانده دفتری بانک و صندوق',d.bankTotal],['خالص پیش‌بینی ۳۰ روز',net30],['تعداد کالا',products.length],['کالاهای در حداقل موجودی',d.low.length],['تعداد فاکتور فروش قطعی',d.sales.length]];
 const html=`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>داشبورد مدیریتی انبارین</title><style>body{font-family:Tahoma,Arial,sans-serif;margin:24px;color:#222}h1{font-size:22px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.k{border:1px solid #bbb;padding:12px}.k b{display:block;margin-bottom:7px}p{font-size:12px;line-height:2}.note{color:#555}@media print{body{margin:12mm}}</style><h1>داشبورد مدیریتی — انبارین پرو ۱.۵.۷</h1><p>تاریخ مبنا: ${d.asOf} · بازه: ${d.from||'ابتدا'} تا ${d.to||'امروز'} · مبالغ ریال</p><div class="grid">${values.map(([k,v])=>`<div class="k"><b>${k}</b>${fa(v)}</div>`).join('')}</div><p class="note">فروش و سود براساس فیلتر انتخابی هستند. مطالبات و بدهی‌ها تا تاریخ مبنا محاسبه شده‌اند. مانده بانک/صندوق و موجودی کالا وضعیت فعلی هستند و مانده تاریخی محسوب نمی‌شوند. پیش‌بینی نقدینگی تخمینی است. سود ناخالص فقط از فروش دارای بهای معتبر محاسبه شده و سود خالص رسمی نیست.</p></html>`;
 printHtmlSafely(html, 'چاپ گزارش', { paperSize: size });
}
