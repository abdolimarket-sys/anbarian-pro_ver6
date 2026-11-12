/** مدیریت حساب‌های نقد و بانک، انتقال داخلی و مغایرت‌گیری صورت‌حساب */
import { idbGet, idbPut } from './storage';
import { loadAccountingData, saveAccountingData, upsertJournalEntry, postJournalEntry, type AccountingData, type JournalEntry, type JournalLine } from './accounting';
import { logAudit } from './state';

export interface BankStatementRow { id:string; accountId:string; date:string; description:string; reference:string; amountRial:number; balanceRial?:number; matchedTransactionId?:string; matched:boolean; importedAt:string; }
export interface BankReconciliationData { schemaVersion:1; rows:BankStatementRow[]; }
const KEY='accounting_phase35_bank_reconciliation';
const now=()=>new Date().toISOString();
const uid=(p:string)=>`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
const moneyOk=(n:number)=>Number.isSafeInteger(n)&&n>0;
export async function loadBankReconciliation():Promise<BankReconciliationData>{const v=await idbGet<unknown>(KEY);if(v&&typeof v==='object'&&(v as BankReconciliationData).schemaVersion===1&&Array.isArray((v as BankReconciliationData).rows))return v as BankReconciliationData;return {schemaVersion:1,rows:[]};}
async function saveBankReconciliation(v:BankReconciliationData){await idbPut(KEY,v);}
function validatePeriod(date:string,periodId:string,a:AccountingData){if(!/^\d{4}\/\d{2}\/\d{2}$/.test(date))throw new Error('تاریخ باید شمسی و به شکل سال/ماه/روز باشد.');const p=a.fiscalPeriods.find(x=>x.id===periodId);if(!p||p.status!=='open'||date<p.startDate||date>p.endDate)throw new Error('سال مالی باز و متناسب با تاریخ انتخاب کنید.');}
function bankAccount(a:AccountingData,id:string){const x=a.accounts.find(v=>v.id===id&&v.isActive&&v.level==='detail');if(!x||!['det-cash','det-bank'].includes(x.id)&&!/(بانک|صندوق|تنخواه)/.test(x.title))throw new Error('حساب فعال تفصیلی صندوق یا بانک انتخاب کنید.');return x;}
function line(accountId:string,description:string,debitRial:number,creditRial:number):JournalLine{return {id:uid('jl'),accountId,description,debitRial,creditRial};}
export async function createInternalTransfer(input:{number:string;date:string;fiscalPeriodId:string;fromAccountId:string;toAccountId:string;amountRial:number;feeRial?:number;feeAccountId?:string;description?:string}):Promise<void>{
 const a=await loadAccountingData();validatePeriod(input.date,input.fiscalPeriodId,a);if(!input.number.trim())throw new Error('شماره انتقال الزامی است.');if(input.fromAccountId===input.toAccountId)throw new Error('حساب مبدأ و مقصد باید متفاوت باشند.');if(!moneyOk(input.amountRial))throw new Error('مبلغ انتقال باید عدد صحیح و بیشتر از صفر باشد.');const from=bankAccount(a,input.fromAccountId),to=bankAccount(a,input.toAccountId);const fee=input.feeRial||0;if(!Number.isSafeInteger(fee)||fee<0)throw new Error('کارمزد معتبر نیست.');if(fee&&!input.feeAccountId)throw new Error('برای کارمزد، حساب هزینه بانکی انتخاب کنید.');const lines=[line(to.id,'انتقال ورودی به حساب مقصد',input.amountRial,0),line(from.id,'انتقال خروجی از حساب مبدأ',0,input.amountRial+fee)];if(fee){const expense=a.accounts.find(x=>x.id===input.feeAccountId&&x.isActive&&x.level==='detail');if(!expense)throw new Error('حساب هزینه بانکی فعال و تفصیلی انتخاب کنید.');lines.push(line(expense.id,'کارمزد انتقال بانکی',fee,0));}
 const id=uid('bank-transfer');const entry:JournalEntry={id:uid('je'),number:`TR-${input.number.trim()}`,fiscalPeriodId:input.fiscalPeriodId,date:input.date,description:input.description?.trim()||`انتقال بین حساب‌ها ${input.number}`,status:'draft',source:'manual',sourceDocumentId:id,lines,createdAt:now(),updatedAt:now()};const posted=postJournalEntry(upsertJournalEntry(a,entry),entry.id);await saveAccountingData(posted);logAudit('bank_internal_transfer_posted',{id,number:input.number,from:from.id,to:to.id,amountRial:input.amountRial,feeRial:fee});
}
/** CSV با ستون‌های date,description,reference,amount,balance؛ مبلغ مثبت و منفی */
export function parseBankStatementCsv(text:string,accountId:string):BankStatementRow[]{const normalize=(v:string)=>v.replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));const lines=normalize(text).replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.trim());if(lines.length<2)throw new Error('فایل صورت‌حساب خالی یا فاقد ردیف داده است.');const split=(s:string)=>{const out:string[]=[];let cur='',q=false;for(let i=0;i<s.length;i++){const c=s[i];if(c==='"'&&s[i+1]==='"'&&q){cur+='"';i++;}else if(c==='"')q=!q;else if(c===','&&!q){out.push(cur.trim());cur='';}else cur+=c;}out.push(cur.trim());return out;};const head=split(lines[0]).map(x=>x.toLowerCase());const ix=(...names:string[])=>head.findIndex(x=>names.includes(x));const d=ix('date','تاریخ'),desc=ix('description','شرح'),ref=ix('reference','پیگیری','شماره'),amt=ix('amount','مبلغ','مبلغ (ریال)'),bal=ix('balance','مانده');if([d,desc,amt].some(x=>x<0))throw new Error('ستون‌های تاریخ، شرح و مبلغ در فایل پیدا نشد.');return lines.slice(1).map((raw,i)=>{const c=split(raw);const date=(c[d]||'').replace(/-/g,'/');const amount=Number((c[amt]||'').replace(/[٬,\s]/g,''));const balance=bal>=0?Number((c[bal]||'').replace(/[٬,\s]/g,'')):undefined;if(!/^\d{4}\/\d{2}\/\d{2}$/.test(date)||!Number.isSafeInteger(amount)||amount===0)throw new Error(`اطلاعات ردیف ${i+2} معتبر نیست.`);return {id:uid('stmt'),accountId,date,description:c[desc]||'',reference:ref>=0?c[ref]||'':'',amountRial:amount,...(balance!==undefined&&Number.isSafeInteger(balance)?{balanceRial:balance}:{}),matched:false,importedAt:now()};});}
export async function importBankStatement(rows:BankStatementRow[]):Promise<{imported:number;matched:number}>{const a=await loadAccountingData();for(const r of rows)bankAccount(a,r.accountId);const data=await loadBankReconciliation();const known=new Set(data.rows.map(r=>`${r.accountId}|${r.date}|${r.amountRial}|${r.reference}`));const commerce=await idbGet<any>('accounting_phase22_commerce');let matched=0,imported=0;const usedTransactions=new Set(data.rows.filter(r=>r.matchedTransactionId).map(r=>r.matchedTransactionId));for(const r of rows){const key=`${r.accountId}|${r.date}|${r.amountRial}|${r.reference}`;if(known.has(key))continue;const candidates=(commerce?.cashTransactions||[]).filter((t:any)=>t.cashAccountId===r.accountId&&t.date===r.date&&((t.type==='receipt'?1:-1)*t.amountRial)===r.amountRial);const eligible=candidates.filter((t:any)=>(t.method!=='cheque'||t.chequeStatus==='cleared')&&!usedTransactions.has(t.id));if(eligible.length===1){r.matched=true;r.matchedTransactionId=eligible[0].id;usedTransactions.add(eligible[0].id);matched++;}data.rows.push(r);known.add(key);imported++;}await saveBankReconciliation(data);logAudit('bank_statement_imported',{rows:rows.length,matched});return {imported,matched};}
export async function matchStatementRow(rowId:string,transactionId:string):Promise<void>{const data=await loadBankReconciliation();const row=data.rows.find(x=>x.id===rowId);if(!row)throw new Error('ردیف صورت‌حساب پیدا نشد.');const commerce=await idbGet<any>('accounting_phase22_commerce');const tx=(commerce?.cashTransactions||[]).find((x:any)=>x.id===transactionId);if(!tx||tx.cashAccountId!==row.accountId||tx.date!==row.date||((tx.type==='receipt'?1:-1)*tx.amountRial)!==row.amountRial)throw new Error('تراکنش انتخابی از نظر حساب، تاریخ یا مبلغ با ردیف بانکی تطبیق ندارد.');if(data.rows.some(x=>x.id!==rowId&&x.matchedTransactionId===transactionId))throw new Error('این تراکنش قبلاً با ردیف دیگری تطبیق داده شده است.');row.matched=true;row.matchedTransactionId=transactionId;await saveBankReconciliation(data);logAudit('bank_statement_row_matched',{rowId,transactionId});}
export async function getBankAccountBalances():Promise<Array<{id:string;code:string;title:string;balanceRial:number}>>{const a=await loadAccountingData();return a.accounts.filter(x=>x.isActive&&x.level==='detail'&&(['det-cash','det-bank'].includes(x.id)||/(بانک|صندوق|تنخواه)/.test(x.title))).map(x=>({id:x.id,code:x.code,title:x.title,balanceRial:a.journalEntries.filter(j=>j.status==='posted').flatMap(j=>j.lines).filter(l=>l.accountId===x.id).reduce((s,l)=>s+l.debitRial-l.creditRial,0)}));}

/** واریز نقد به بانک یا برداشت از بانک به صندوق */
export async function createCashBankMove(input:{
  kind:'deposit'|'withdraw';
  number:string;
  date:string;
  fiscalPeriodId:string;
  cashAccountId:string;
  bankAccountId:string;
  amountRial:number;
  description?:string;
}):Promise<void>{
  const a=await loadAccountingData();
  validatePeriod(input.date,input.fiscalPeriodId,a);
  if(!input.number.trim())throw new Error('شماره سند الزامی است.');
  if(!moneyOk(input.amountRial))throw new Error('مبلغ باید عدد صحیح و بیشتر از صفر باشد.');
  if(input.cashAccountId===input.bankAccountId)throw new Error('حساب صندوق و بانک باید متفاوت باشند.');
  const cash=bankAccount(a,input.cashAccountId);
  const bank=bankAccount(a,input.bankAccountId);
  const isDeposit=input.kind==='deposit';
  const desc=input.description?.trim()||(isDeposit?`واریز نقد به بانک ${input.number}`:`برداشت از بانک به صندوق ${input.number}`);
  const lines=isDeposit
    ?[line(bank.id,desc,input.amountRial,0),line(cash.id,desc,0,input.amountRial)]
    :[line(cash.id,desc,input.amountRial,0),line(bank.id,desc,0,input.amountRial)];
  const id=uid(`bank-${input.kind}`);
  const entry:JournalEntry={
    id:uid('je'),number:`${isDeposit?'BD':'BW'}-${input.number.trim()}`,
    fiscalPeriodId:input.fiscalPeriodId,date:input.date,description:desc,
    status:'draft',source:'manual',sourceDocumentId:id,lines,createdAt:now(),updatedAt:now()
  };
  const posted=postJournalEntry(upsertJournalEntry(a,entry),entry.id);
  await saveAccountingData(posted);
  logAudit(isDeposit?'bank_cash_deposit':'bank_cash_withdraw',{id,amountRial:input.amountRial,cash:cash.id,bank:bank.id});
}

/** ثبت کارمزد بانکی مستقل */
export async function createBankFee(input:{
  number:string;
  date:string;
  fiscalPeriodId:string;
  bankAccountId:string;
  feeAccountId:string;
  amountRial:number;
  description?:string;
}):Promise<void>{
  const a=await loadAccountingData();
  validatePeriod(input.date,input.fiscalPeriodId,a);
  if(!input.number.trim())throw new Error('شماره سند الزامی است.');
  if(!moneyOk(input.amountRial))throw new Error('مبلغ کارمزد معتبر نیست.');
  const bank=bankAccount(a,input.bankAccountId);
  const feeAcc=a.accounts.find(x=>x.id===input.feeAccountId&&x.isActive&&x.level==='detail');
  if(!feeAcc)throw new Error('حساب هزینه کارمزد فعال و تفصیلی انتخاب کنید.');
  const desc=input.description?.trim()||`کارمزد بانکی ${input.number}`;
  const lines=[line(feeAcc.id,desc,input.amountRial,0),line(bank.id,desc,0,input.amountRial)];
  const id=uid('bank-fee');
  const entry:JournalEntry={
    id:uid('je'),number:`BF-${input.number.trim()}`,
    fiscalPeriodId:input.fiscalPeriodId,date:input.date,description:desc,
    status:'draft',source:'manual',sourceDocumentId:id,lines,createdAt:now(),updatedAt:now()
  };
  const posted=postJournalEntry(upsertJournalEntry(a,entry),entry.id);
  await saveAccountingData(posted);
  logAudit('bank_fee_posted',{id,amountRial:input.amountRial,bank:bank.id,fee:feeAcc.id});
}

/** گردش دفتر بانک/صندوق از اسناد قطعی */
export async function getBankAccountLedger(accountId:string,from?:string,to?:string):Promise<Array<{
  date:string;number:string;description:string;debitRial:number;creditRial:number;balanceRial:number;
}>>{
  const a=await loadAccountingData();
  bankAccount(a,accountId);
  let balance=0;
  const rows:Array<{date:string;number:string;description:string;debitRial:number;creditRial:number;balanceRial:number}>=[];
  const entries=a.journalEntries
    .filter(j=>j.status==='posted'&&(!from||j.date>=from)&&(!to||j.date<=to))
    .sort((x,y)=>x.date.localeCompare(y.date)||x.number.localeCompare(y.number,'en'));
  for(const e of entries){
    for(const l of e.lines.filter(x=>x.accountId===accountId)){
      balance+=l.debitRial-l.creditRial;
      rows.push({
        date:e.date,number:e.number,
        description:l.description||e.description,
        debitRial:l.debitRial,creditRial:l.creditRial,balanceRial:balance
      });
    }
  }
  return rows;
}

/** خلاصه مغایرت‌گیری صورت‌حساب بانکی */
export async function getBankReconciliationSummary(accountId?:string):Promise<{
  totalRows:number;matched:number;unmatched:number;
  bankInflowRial:number;bankOutflowRial:number;
  bookBalanceRial:number;unmatchedBankRial:number;
}>{
  const [data,balances]=await Promise.all([loadBankReconciliation(),getBankAccountBalances()]);
  const rows=accountId?data.rows.filter(r=>r.accountId===accountId):data.rows;
  const matched=rows.filter(r=>r.matched).length;
  const unmatched=rows.length-matched;
  const bankInflowRial=rows.filter(r=>r.amountRial>0).reduce((s,r)=>s+r.amountRial,0);
  const bankOutflowRial=rows.filter(r=>r.amountRial<0).reduce((s,r)=>s+Math.abs(r.amountRial),0);
  const bookBalanceRial=accountId
    ?(balances.find(b=>b.id===accountId)?.balanceRial||0)
    :balances.reduce((s,b)=>s+b.balanceRial,0);
  const unmatchedBankRial=rows.filter(r=>!r.matched).reduce((s,r)=>s+r.amountRial,0);
  return {totalRows:rows.length,matched,unmatched,bankInflowRial,bankOutflowRial,bookBalanceRial,unmatchedBankRial};
}
