/** ظهرنویسی و واگذاری چک دریافتی به تأمین‌کننده */
import { loadAccountingData, saveAccountingData, upsertJournalEntry, postJournalEntry, type JournalEntry, type JournalLine } from './accounting';
import { loadCommerceData, saveCommerceData, invoiceOutstanding, type CommerceData, type CashTransaction } from './accounting-commerce';
import { logAudit } from './state';

const now=()=>new Date().toISOString();
const id=(p:string)=>`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
const validDate=(v:string)=>/^\d{4}\/\d{2}\/\d{2}$/.test(v);
function line(accountId:string,description:string,debitRial:number,creditRial:number,partyId?:string):JournalLine{return {id:id('line'),accountId,description,debitRial,creditRial,...(partyId?{partyId}:{})};}
function assertAccount(data:Awaited<ReturnType<typeof loadAccountingData>>,accountId:string,label:string){if(!data.accounts.some(a=>a.id===accountId&&a.isActive&&a.level==='detail'))throw new Error(`حساب تفصیلی فعال «${label}» در کدینگ پیدا نشد.`);}

export async function endorseCheque(transactionId:string,toPartyId:string,invoiceId:string,date:string,note:string,amountRial?:number):Promise<CommerceData>{
  const commerce=await loadCommerceData();
  const tx=commerce.cashTransactions.find(t=>t.id===transactionId);
  if(!tx||tx.method!=='cheque'||tx.type!=='receipt'||tx.chequeStatus!=='pending')throw new Error('فقط چک دریافتیِ در انتظار قابل ظهرنویسی است.');
  const prior=(commerce.chequeEndorsements||[]).filter(e=>e.transactionId===tx.id);
  const alreadyEndorsed=prior.reduce((sum,e)=>sum+e.amountRial,0);
  const remaining=tx.amountRial-alreadyEndorsed;
  if(remaining<=0)throw new Error('این چک قبلاً ظهرنویسی شده است؛ مانده‌ای برای واگذاری باقی نمانده است.');
  if(!validDate(date))throw new Error('تاریخ ظهرنویسی باید شمسی و به شکل YYYY/MM/DD باشد.');
  const party=commerce.parties.find(p=>p.id===toPartyId&&p.isActive&&(p.type==='supplier'||p.type==='both'));
  if(!party)throw new Error('ذی‌نفع باید تأمین‌کننده فعال باشد.');
  const invoice=commerce.invoices.find(i=>i.id===invoiceId&&i.status==='posted'&&i.type==='purchase'&&i.partyId===party.id);
  if(!invoice)throw new Error('فاکتور خرید قطعی متعلق به همین تأمین‌کننده را انتخاب کنید.');
  const amount=amountRial??remaining;
  if(!Number.isSafeInteger(amount)||amount<=0||amount>remaining)throw new Error('مبلغ واگذاری باید مثبت و حداکثر برابر مانده چک باشد.');
  if(invoiceOutstanding(invoice.id,commerce)<amount)throw new Error('مانده فاکتور خرید برای مبلغ واگذاری کافی نیست.');
  const accounting=await loadAccountingData();
  const sourceDocumentId=`${tx.id}:endorsement:${prior.length+1}`;
  const already=accounting.journalEntries.find(j=>j.sourceDocumentId===sourceDocumentId&&j.status==='posted');
  const journalId=already?.id||id('je');
  if(!already){
    const period=accounting.fiscalPeriods.find(p=>p.status==='open'&&date>=p.startDate&&date<=p.endDate);
    if(!period)throw new Error('برای تاریخ ظهرنویسی، سال مالی باز و معتبر پیدا نشد.');
    assertAccount(accounting,'det-cheques-receivable','چک‌های دریافتنی');
    assertAccount(accounting,'det-suppliers','حساب پرداختنی تأمین‌کنندگان');
    const lines=[line('det-suppliers','تسویه بدهی تأمین‌کننده از محل ظهرنویسی چک',amount,0,party.id),line('det-cheques-receivable','خروج چک از اسناد دریافتنی بابت واگذاری جزئی',0,amount)];
    const entry:JournalEntry={id:journalId,number:`EN-${Date.now().toString().slice(-6)}`,fiscalPeriodId:period.id,date,description:`ظهرنویسی چک ${tx.chequeNumber||tx.number} به ${party.name}`,status:'draft',source:'payment',sourceDocumentId,lines,createdAt:now(),updatedAt:now()};
    const posted=postJournalEntry(upsertJournalEntry(accounting,entry),entry.id);
    await saveAccountingData(posted);
  }
  const endorsement={id:id('endorse'),transactionId:tx.id,toPartyId:party.id,invoiceId:invoice.id,date,amountRial:amount,note:note.trim(),journalEntryId:journalId,createdAt:now()};
  const next={...commerce,chequeEndorsements:[...(commerce.chequeEndorsements||[]),endorsement]};
  await saveCommerceData(next);
  logAudit('cheque_endorsed',{transactionId:tx.id,toPartyId:party.id,invoiceId:invoice.id,amountRial:amount,remainingRial:remaining-amount,journalEntryId:journalId});
  return next;
}

export function getChequeEndorsements(transactionId:string,commerce:CommerceData){return (commerce.chequeEndorsements||[]).filter(e=>e.transactionId===transactionId);}
export function getChequeEndorsement(transactionId:string,commerce:CommerceData){return getChequeEndorsements(transactionId,commerce)[0];}
export function getChequeEndorsementRemaining(transactionId:string,commerce:CommerceData){const tx=commerce.cashTransactions.find(t=>t.id===transactionId);if(!tx)return 0;return Math.max(0,tx.amountRial-getChequeEndorsements(transactionId,commerce).reduce((sum,e)=>sum+e.amountRial,0));}
