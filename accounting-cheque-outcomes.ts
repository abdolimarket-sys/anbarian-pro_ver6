/** ثبت نتیجه ارائه چک نزد دارنده نهایی و گزارش وضعیت */
import { idbGet, idbPut } from './storage';
import { loadCommerceData, type CommerceData } from './accounting-commerce';
import { loadChequeChain, getChainAvailable } from './accounting-cheque-chain';
import { logAudit } from './state';

export type ChequeHolderOutcomeType = 'collected'|'returned'|'disputed';
export interface ChequeHolderOutcome {
  id:string; endorsementId:string; parentTransferId?:string; holderPartyId:string;
  type:ChequeHolderOutcomeType; amountRial:number; date:string; reference:string; note:string; createdAt:string;
}
export interface ChequeOutcomeData { schemaVersion:1; outcomes:ChequeHolderOutcome[]; }
const KEY='accounting_phase40_cheque_holder_outcomes';
const now=()=>new Date().toISOString();
const uid=()=>`chqout_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
const validDate=(s:string)=>/^\d{4}\/\d{2}\/\d{2}$/.test(s);
export async function loadChequeOutcomes():Promise<ChequeOutcomeData>{
 const v=await idbGet<unknown>(KEY);
 if(v&&typeof v==='object'&&(v as ChequeOutcomeData).schemaVersion===1&&Array.isArray((v as ChequeOutcomeData).outcomes))return v as ChequeOutcomeData;
 return {schemaVersion:1,outcomes:[]};
}
export function getOutcomeAvailable(endorsementId:string,parentTransferId:string|undefined,commerce:CommerceData,chain:Awaited<ReturnType<typeof loadChequeChain>>,data:ChequeOutcomeData):number{
 const transferredAvailable=getChainAvailable(endorsementId,commerce,chain,parentTransferId);
 const resolved=data.outcomes.filter(x=>x.endorsementId===endorsementId&&x.parentTransferId===parentTransferId).reduce((s,x)=>s+x.amountRial,0);
 return Math.max(0,transferredAvailable-resolved);
}
export async function recordChequeHolderOutcome(input:{endorsementId:string;parentTransferId?:string;holderPartyId:string;type:ChequeHolderOutcomeType;amountRial:number;date:string;reference?:string;note:string}):Promise<ChequeOutcomeData>{
 const commerce=await loadCommerceData();const endorsement=(commerce.chequeEndorsements||[]).find(e=>e.id===input.endorsementId);if(!endorsement)throw new Error('ظهرنویسی اصلی چک پیدا نشد.');
 const chain=await loadChequeChain();let expectedHolder=endorsement.toPartyId;
 if(input.parentTransferId){const parent=chain.transfers.find(t=>t.id===input.parentTransferId&&t.endorsementId===input.endorsementId);if(!parent)throw new Error('مرحله انتقال معتبر نیست.');expectedHolder=parent.toPartyId;}
 if(input.holderPartyId!==expectedHolder)throw new Error('ثبت‌کننده نتیجه با دارنده این مرحله مطابقت ندارد.');
 if(!commerce.parties.some(p=>p.id===expectedHolder))throw new Error('اطلاعات دارنده چک پیدا نشد.');
 if(!['collected','returned','disputed'].includes(input.type))throw new Error('نوع نتیجه معتبر نیست.');
 if(!validDate(input.date))throw new Error('تاریخ باید شمسی و به شکل YYYY/MM/DD باشد.');
 if(!Number.isSafeInteger(input.amountRial)||input.amountRial<=0)throw new Error('مبلغ نتیجه باید عدد صحیح و بیشتر از صفر باشد.');
 const data=await loadChequeOutcomes();const available=getOutcomeAvailable(input.endorsementId,input.parentTransferId,commerce,chain,data);
 if(input.amountRial>available)throw new Error('مبلغ نتیجه از مانده قابل تعیین تکلیف بیشتر است.');
 const outcome:ChequeHolderOutcome={id:uid(),endorsementId:input.endorsementId,...(input.parentTransferId?{parentTransferId:input.parentTransferId}:{}),holderPartyId:expectedHolder,type:input.type,amountRial:input.amountRial,date:input.date,reference:(input.reference||'').trim(),note:input.note.trim(),createdAt:now()};
 const next={...data,outcomes:[...data.outcomes,outcome]};await idbPut(KEY,next);
 logAudit('cheque_holder_outcome_recorded',{endorsementId:input.endorsementId,parentTransferId:input.parentTransferId,holderPartyId:expectedHolder,type:input.type,amountRial:input.amountRial,date:input.date});
 return next;
}
export async function getChequeOutcomeReport():Promise<{collectedRial:number;returnedRial:number;disputedRial:number;records:ChequeHolderOutcome[]}>{
 const data=await loadChequeOutcomes();return {collectedRial:data.outcomes.filter(x=>x.type==='collected').reduce((s,x)=>s+x.amountRial,0),returnedRial:data.outcomes.filter(x=>x.type==='returned').reduce((s,x)=>s+x.amountRial,0),disputedRial:data.outcomes.filter(x=>x.type==='disputed').reduce((s,x)=>s+x.amountRial,0),records:data.outcomes.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
}
