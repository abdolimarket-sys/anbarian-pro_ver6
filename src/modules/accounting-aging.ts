/** داشبورد سن مطالبات، بدهی‌ها و ریسک سررسید اسناد */
import { loadCommerceData, invoiceOutstanding, type CommerceData, type CommercialInvoice, type CashTransaction } from './accounting-commerce';

export type AgingBucket = 'current'|'1_30'|'31_60'|'61_90'|'over_90';
export interface AgingInvoiceRow { invoiceId:string; number:string; type:import('./accounting-commerce').InvoiceType; partyId:string; partyName:string; issueDate:string; dueDate:string; outstandingRial:number; overdueDays:number; bucket:AgingBucket; }
export interface AgingChequeRow { transactionId:string; number:string; chequeNumber:string; type:'receipt'|'payment'; partyName:string; dueDate:string; amountRial:number; overdueDays:number; risk:'overdue'|'due_soon'|'normal'; }
export interface AgingDashboard { asOf:string; receivableRial:number; payableRial:number; netPositionRial:number; buckets:Record<AgingBucket,number>; overdueReceivableRial:number; overduePayableRial:number; chequesReceivableRial:number; chequesPayableRial:number; overdueCheques:AgingChequeRow[]; dueSoonCheques:AgingChequeRow[]; invoices:AgingInvoiceRow[]; }
const validDate=(s:string)=>/^\d{4}\/\d{2}\/\d{2}$/.test(s);
const mod=(a:number,b:number)=>((a%b)+b)%b;
/** Julian day number for a Jalali date; used only for day-age calculations. */
function jalaliJdn(date:string):number {
 const [jy,jm,jd]=date.split('/').map(Number);
 const jy2=jy-(jy>=0?474:473); const epyear=474+mod(jy2,2820);
 const monthDays=jm<=7?(jm-1)*31:(jm-1)*30+6;
 return jd+monthDays+Math.floor((epyear*682-110)/2816)+(epyear-1)*365+Math.floor(jy2/2820)*1029983+1948320-1;
}
function bucket(days:number):AgingBucket { if(days<=0)return 'current';if(days<=30)return '1_30';if(days<=60)return '31_60';if(days<=90)return '61_90';return 'over_90'; }
function chequeRows(c:CommerceData,today:string):AgingChequeRow[]{
 const base=jalaliJdn(today);
 return c.cashTransactions.filter(t=>t.method==='cheque'&&t.chequeStatus==='pending'&&!!t.chequeDueDate&&validDate(t.chequeDueDate!)).map(t=>{
  const overdueDays=Math.max(0,base-jalaliJdn(t.chequeDueDate!));
  const dueIn=jalaliJdn(t.chequeDueDate!)-base;
  return {transactionId:t.id,number:t.number,chequeNumber:t.chequeNumber||'',type:t.type,partyName:c.parties.find(p=>p.id===t.partyId)?.name||'—',dueDate:t.chequeDueDate!,amountRial:t.amountRial,overdueDays,risk:overdueDays>0?'overdue':dueIn<=7?'due_soon':'normal'};
 });
}
export function buildAgingDashboard(c:CommerceData,today:string):AgingDashboard {
 if(!validDate(today))throw new Error('تاریخ گزارش باید شمسی و به شکل YYYY/MM/DD باشد.');
 const base=jalaliJdn(today);const buckets:Record<AgingBucket,number>={current:0,'1_30':0,'31_60':0,'61_90':0,over_90:0};
 const invoices:AgingInvoiceRow[]=c.invoices.filter(i=>i.status==='posted').flatMap(i=>{
  const outstanding=invoiceOutstanding(i.id,c);if(outstanding<=0)return [];
  const due=i.dueDate&&validDate(i.dueDate)?i.dueDate:i.date;const overdueDays=Math.max(0,base-jalaliJdn(due));const b=bucket(overdueDays);buckets[b]+=outstanding;
  return [{invoiceId:i.id,number:i.number,type:i.type,partyId:i.partyId,partyName:c.parties.find(p=>p.id===i.partyId)?.name||'—',issueDate:i.date,dueDate:due,outstandingRial:outstanding,overdueDays,bucket:b}];
 });
 const receivableRial=invoices.filter(x=>x.type==='sale'||x.type==='return-purchase').reduce((s,x)=>s+x.outstandingRial,0);
 const payableRial=invoices.filter(x=>x.type==='purchase'||x.type==='return-sale').reduce((s,x)=>s+x.outstandingRial,0);
 const cheques=chequeRows(c,today);
 const overdueCheques=cheques.filter(x=>x.risk==='overdue');const dueSoonCheques=cheques.filter(x=>x.risk==='due_soon');
 return {asOf:today,receivableRial,payableRial,netPositionRial:receivableRial-payableRial,buckets,overdueReceivableRial:invoices.filter(x=>(x.type==='sale'||x.type==='return-purchase')&&x.overdueDays>0).reduce((s,x)=>s+x.outstandingRial,0),overduePayableRial:invoices.filter(x=>(x.type==='purchase'||x.type==='return-sale')&&x.overdueDays>0).reduce((s,x)=>s+x.outstandingRial,0),chequesReceivableRial:cheques.filter(x=>x.type==='receipt').reduce((s,x)=>s+x.amountRial,0),chequesPayableRial:cheques.filter(x=>x.type==='payment').reduce((s,x)=>s+x.amountRial,0),overdueCheques,dueSoonCheques,invoices:invoices.sort((a,b)=>b.overdueDays-a.overdueDays)};
}
export async function getAgingDashboard(today:string):Promise<AgingDashboard>{return buildAgingDashboard(await loadCommerceData(),today);}
