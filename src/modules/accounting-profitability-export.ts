/** خروجی آفلاین گزارش سودآوری */
import { buildOfflineXlsx } from './import-export';
import { getProfitabilityDashboard, getExpenseAdjustedProfitability, getProfitabilityPeriodComparison, type ProfitabilityFilter } from './accounting-profitability';
import { printHtmlSafely } from '@/utils/helpers';
import { choosePaperSize } from './print-paper';

const fa=(n:number)=>new Intl.NumberFormat('fa-IR').format(Math.round(Number(n)||0));
function download(bytes:BlobPart,type:string,name:string):void{
 const blob=new Blob(bytes instanceof Uint8Array?[bytes]:[bytes],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function exportProfitabilityXlsx(filter:ProfitabilityFilter={}):Promise<void>{
 const p=await getProfitabilityDashboard(filter),e=await getExpenseAdjustedProfitability(p,filter),periods=await getProfitabilityPeriodComparison(filter);
 const sheets=[
  {name:'خلاصه',rows:[['شاخص','مبلغ (ریال)'],['کل فروش قطعی',p.salesRial],['فروش دارای بهای معتبر',p.costedSalesRial],['بهای تمام‌شده',p.cogsRial],['سود ناخالص',p.grossProfitRial],['حاشیه سود ناخالص (%)',p.marginPercent],['هزینه ثبت‌شده گروه ۶',e.totalPostedExpensesRial],['هزینه تخصیص‌یافته',e.allocatedExpensesRial],['هزینه تخصیص‌نیافته',e.unallocatedExpensesRial],['سود تعدیل‌شده تحلیلی',e.adjustedProfitRial],['فروش فاقد بهای معتبر',p.uncostedRevenueRial],['فروش با بهای موقت',p.provisionalRevenueRial]]},
  {name:'سال‌های مالی',rows:[['سال مالی','شروع','پایان','فروش','فروش بهای معتبر','بهای تمام‌شده','سود ناخالص','هزینه ثبت‌شده','سود تعدیل‌شده','حاشیه (%)','فروش فاقد بهای معتبر'],...periods.map(x=>[x.periodTitle,x.startDate,x.endDate,x.salesRial,x.costedSalesRial,x.cogsRial,x.grossProfitRial,x.postedExpensesRial,x.adjustedProfitRial,x.marginPercent,x.uncostedRevenueRial])]},
  {name:'سود کالاها',rows:[['کالا','مقدار (هزارم واحد)','فروش','بهای تمام‌شده','سود ناخالص','حاشیه (%)'],...p.products.map(x=>[x.name,x.quantityMilli,x.revenueRial,x.costRial,x.grossProfitRial,x.marginPercent])]},
  {name:'سود مشتریان',rows:[['مشتری','فروش','بهای تمام‌شده','سود ناخالص','حاشیه (%)'],...p.customers.map(x=>[x.name,x.revenueRial,x.costRial,x.grossProfitRial,x.marginPercent])]},
  {name:'هزینه‌ها',rows:[['کد حساب','عنوان حساب','مبلغ (ریال)'],...e.expenseAccounts.map(x=>[x.code,x.title,x.amountRial])]},
  {name:'تخصیص کالا',rows:[['کالا','فروش','هزینه تخصیصی','سود تعدیل‌شده','حاشیه (%)'],...e.products.map(x=>[x.name,x.revenueRial,x.allocatedExpenseRial,x.adjustedProfitRial,x.adjustedMarginPercent])]},
  {name:'تخصیص مشتری',rows:[['مشتری','فروش','هزینه تخصیصی','سود تعدیل‌شده','حاشیه (%)'],...e.customers.map(x=>[x.name,x.revenueRial,x.allocatedExpenseRial,x.adjustedProfitRial,x.adjustedMarginPercent])]}
 ];
 const bytes=buildOfflineXlsx(sheets);download(bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','anbarin-profitability-filtered-phase47.xlsx');
}
export async function printProfitabilityPdf(filter:ProfitabilityFilter={}):Promise<void>{
  const size=await choosePaperSize({mode:'document',title:'سایز چاپ گزارش سودآوری'});
  if(!size)return;
  const p=await getProfitabilityDashboard(filter),e=await getExpenseAdjustedProfitability(p,filter),periods=await getProfitabilityPeriodComparison(filter);
 const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 const table=(title:string,heads:string[],rows:Array<Array<string|number>>)=>`<h2>${title}</h2><table><thead><tr>${heads.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${typeof v==='number'?fa(v):esc(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
 const html=`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>گزارش سودآوری انبارین</title><style>body{font-family:Tahoma,Arial,sans-serif;margin:24px;color:#222}h1{font-size:22px}h2{font-size:16px;margin-top:26px}p{font-size:12px;line-height:2}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.k{border:1px solid #bbb;padding:10px}.k b{display:block;margin-bottom:6px}table{width:100%;border-collapse:collapse;font-size:10px;margin:8px 0 20px}th,td{border:1px solid #bbb;padding:6px;text-align:right}th{background:#eee}.note{color:#555}@media print{button{display:none}body{margin:12mm}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}</style><h1>گزارش مدیریتی سودآوری — انبارین پرو ۱.۵.۷</h1><p>گزارش فقط‌خواندنی · مبالغ پایه ریال · تهیه‌شده در ${new Date().toLocaleDateString('fa-IR')}</p><div class="grid">${[['فروش قطعی',p.salesRial],['فروش دارای بهای معتبر',p.costedSalesRial],['بهای تمام‌شده',p.cogsRial],['سود ناخالص',p.grossProfitRial],['هزینه ثبت‌شده گروه ۶',e.totalPostedExpensesRial],['سود تعدیل‌شده تحلیلی',e.adjustedProfitRial]].map(([k,v])=>`<div class="k"><b>${k}</b>${fa(Number(v))} ریال</div>`).join('')}</div><p class="note">سود تعدیل‌شده صرفاً برآورد تحلیلی با تخصیص هزینه بر اساس نسبت فروش است و جایگزین سود خالص رسمی نیست. فروش فاقد بهای معتبر یا دارای بهای موقت در سود ناخالص لحاظ نشده است.</p>${table('مقایسه سال‌های مالی',['سال مالی','شروع','پایان','فروش','سود ناخالص','هزینه','سود تعدیل‌شده'],periods.map(x=>[x.periodTitle,x.startDate,x.endDate,x.salesRial,x.grossProfitRial,x.postedExpensesRial,x.adjustedProfitRial]))}${table('سودآوری کالاها',['کالا','مقدار (هزارم)','فروش','بهای تمام‌شده','سود ناخالص','حاشیه٪'],p.products.map(x=>[x.name,x.quantityMilli,x.revenueRial,x.costRial,x.grossProfitRial,`${x.marginPercent.toFixed(1)}٪`]))}${table('سودآوری مشتریان',['مشتری','فروش','بهای تمام‌شده','سود ناخالص','حاشیه٪'],p.customers.map(x=>[x.name,x.revenueRial,x.costRial,x.grossProfitRial,`${x.marginPercent.toFixed(1)}٪`]))}${table('هزینه‌های ثبت‌شده',['کد','عنوان حساب','مبلغ'],e.expenseAccounts.map(x=>[x.code,x.title,x.amountRial]))}<p class="note">برای ذخیره PDF، در پنجره چاپ مرورگر گزینه Save as PDF را انتخاب کنید.</p></html>`;
 printHtmlSafely(html, 'چاپ گزارش', { paperSize: size });
}
