/** خروجی مستقل جزئیات ماهانه داشبورد مدیریتی */
import { loadAccountingData } from './accounting';
import { loadCommerceData } from './accounting-commerce';
import { buildOfflineXlsx } from './import-export';
import { printHtmlSafely } from '@/utils/helpers';

const fa=(n:number)=>new Intl.NumberFormat('fa-IR').format(Math.round(Number(n)||0));
const norm=(v:string)=>String(v||'').replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/-/g,'/').slice(0,10);
const esc=(v:string)=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function download(bytes:Uint8Array,type:string,name:string):void{const blob=new Blob([bytes],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function monthValid(month:string):boolean{return /^\d{4}\/\d{2}$/.test(norm(month))&&Number(norm(month).slice(5,7))>=1&&Number(norm(month).slice(5,7))<=12}
async function collect(month:string,fromDate='',toDate=''){
 const key=norm(month).replace('/','');if(!monthValid(month))throw new Error('ماه انتخاب‌شده معتبر نیست.');
 const [commerce,accounting]=await Promise.all([loadCommerceData(),loadAccountingData()]);
 const sameMonth=(date:string)=>{const d=norm(date);return d.replace('/','').slice(0,6)===key&&(!fromDate||d>=norm(fromDate))&&(!toDate||d<=norm(toDate))};
 const invoices=commerce.invoices.filter(i=>i.status==='posted'&&i.type==='sale'&&sameMonth(i.date)).map(i=>({number:i.number,date:i.date,party:commerce.parties.find(p=>p.id===i.partyId)?.name||'—',amount:i.grossRial}));
 const transactions=commerce.cashTransactions.filter(t=>sameMonth(t.date)&&t.chequeStatus!=='bounced'&&t.chequeStatus!=='void'&&(t.method!=='cheque'||t.chequeStatus==='cleared')).map(t=>({type:t.type==='receipt'?'دریافت':'پرداخت',number:t.number,date:t.date,party:commerce.parties.find(p=>p.id===t.partyId)?.name||'—',amount:t.amountRial}));
 const expenses=accounting.journalEntries.filter(j=>j.status==='posted'&&sameMonth(j.date)).flatMap(j=>j.lines.map(line=>{const account=accounting.accounts.find(a=>a.id===line.accountId);const code=line.accountCodeSnapshot||account?.code||'';const amount=Number(line.debitRial||0)-Number(line.creditRial||0);return code.startsWith('6')&&amount!==0?{number:j.number,date:j.date,account:line.accountTitleSnapshot||account?.title||code,description:line.description||j.description,amount}:null}).filter((x):x is {number:string;date:string;account:string;description:string;amount:number}=>!!x));
 return {month:norm(month),invoices,transactions,expenses};
}
export async function exportManagementMonthXlsx(month:string,fromDate='',toDate=''):Promise<void>{
 const d=await collect(month,fromDate,toDate);const total=(rows:{amount:number}[])=>rows.reduce((n,x)=>n+x.amount,0);
 const sheets=[
  {name:'خلاصه ماه',rows:[['شاخص','مقدار ریال'],['ماه',d.month],['تعداد فاکتور فروش قطعی',d.invoices.length],['جمع فروش قطعی',total(d.invoices)],['تعداد دریافت/پرداخت قطعی',d.transactions.length],['جمع دریافت قطعی',total(d.transactions.filter(x=>x.type==='دریافت'))],['جمع پرداخت قطعی',total(d.transactions.filter(x=>x.type==='پرداخت'))],['جمع خالص هزینه گروه ۶',total(d.expenses)]]},
  {name:'فاکتورهای فروش',rows:[['شماره فاکتور','تاریخ','مشتری','مبلغ ریال'],...d.invoices.map(x=>[x.number,x.date,x.party,x.amount])]},
  {name:'دریافت و پرداخت',rows:[['نوع','شماره','تاریخ','طرف حساب','مبلغ ریال'],...d.transactions.map(x=>[x.type,x.number,x.date,x.party,x.amount])]},
  {name:'هزینه‌های گروه ۶',rows:[['شماره سند','تاریخ','حساب','شرح','خالص هزینه ریال'],...d.expenses.map(x=>[x.number,x.date,x.account,x.description,x.amount])]}
 ];
 download(buildOfflineXlsx(sheets),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',`anbarin-month-${d.month.replace('/','-')}.xlsx`);
}
export async function printManagementMonthPdf(month:string,fromDate='',toDate=''):Promise<void>{
  const d=await collect(month,fromDate,toDate);const total=(rows:{amount:number}[])=>rows.reduce((n,x)=>n+x.amount,0);
 const table=(title:string,headers:string[],rows:string[][])=>`<h2>${title}</h2><table><thead><tr>${headers.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${headers.length}">موردی ثبت نشده است.</td></tr>`}</tbody></table>`;
 const html=`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>گزارش ماه ${esc(d.month)}</title><style>body{font-family:Tahoma,Arial,sans-serif;margin:20px;color:#222}h1{font-size:21px}h2{font-size:16px;margin-top:24px}table{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:11px}th,td{border:1px solid #bbb;padding:7px;text-align:right}th{background:#eee}.summary{display:flex;gap:12px;flex-wrap:wrap}.summary div{border:1px solid #bbb;padding:10px;min-width:130px}@media print{body{margin:10mm}}</style><h1>گزارش جزئیات ماهانه — انبارین پرو ۱.۵.۷</h1><p>ماه: ${esc(d.month)} · مبالغ به ریال</p><div class="summary"><div>فروش قطعی: ${fa(total(d.invoices))}</div><div>دریافت قطعی: ${fa(total(d.transactions.filter(x=>x.type==='دریافت')))}</div><div>پرداخت قطعی: ${fa(total(d.transactions.filter(x=>x.type==='پرداخت')))}</div><div>هزینه گروه ۶: ${fa(total(d.expenses))}</div></div>${table('فاکتورهای فروش قطعی',['شماره','تاریخ','مشتری','مبلغ ریال'],d.invoices.map(x=>[x.number,x.date,x.party,fa(x.amount)]))}${table('دریافت‌ها و پرداخت‌های قطعی',['نوع','شماره','تاریخ','طرف حساب','مبلغ ریال'],d.transactions.map(x=>[x.type,x.number,x.date,x.party,fa(x.amount)]))}${table('ریز هزینه‌های گروه ۶',['سند','تاریخ','حساب','شرح','خالص هزینه ریال'],d.expenses.map(x=>[x.number,x.date,x.account,x.description,fa(x.amount)]))}<p>گزارش فقط‌خواندنی است. چک‌های برگشتی، باطل و چک‌های وصول‌نشده در دریافت/پرداخت قطعی لحاظ نشده‌اند. هزینه‌ها بر مبنای مانده بدهکار منهای بستانکار حساب‌های گروه ۶ محاسبه شده‌اند.</p></html>`;
 printHtmlSafely(html, 'چاپ گزارش');
}
