/** دفتر گردش زنجیره‌ای ظهرنویسی چک پس از واگذاری از شرکت */
import { idbGet, idbPut } from './storage';
import { loadCommerceData, type CommerceData } from './accounting-commerce';
import { logAudit } from './state';

const KEY='accounting_phase39_cheque_chain';
export interface ChequeChainTransfer { id:string; endorsementId:string; parentTransferId?:string; fromPartyId:string; toPartyId:string; amountRial:number; date:string; note:string; createdAt:string; }
export interface ChequeChainData { schemaVersion:1; transfers:ChequeChainTransfer[]; }
const now=()=>new Date().toISOString();
const makeId=()=>`chqchain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
const validDate=(v:string)=>/^\d{4}\/\d{2}\/\d{2}$/.test(v);
export async function loadChequeChain():Promise<ChequeChainData>{const v=await idbGet<unknown>(KEY);if(v&&typeof v==='object'&&(v as ChequeChainData).schemaVersion===1&&Array.isArray((v as ChequeChainData).transfers))return v as ChequeChainData;return {schemaVersion:1,transfers:[]};}
export function getChainAvailable(endorsementId:string,commerce:CommerceData,data:ChequeChainData,parentTransferId?:string):number{
 const root=(commerce.chequeEndorsements||[]).find(e=>e.id===endorsementId);if(!root)return 0;
 let holder=root.toPartyId,amount=root.amountRial;
 if(parentTransferId){const parent=data.transfers.find(t=>t.id===parentTransferId&&t.endorsementId===endorsementId);if(!parent)return 0;holder=parent.toPartyId;amount=parent.amountRial;}
 const used=data.transfers.filter(t=>t.endorsementId===endorsementId&&t.parentTransferId===parentTransferId).reduce((s,t)=>s+t.amountRial,0);
 return Math.max(0,amount-used);
}
export async function transferEndorsedCheque(input:{endorsementId:string;parentTransferId?:string;fromPartyId:string;toPartyId:string;amountRial:number;date:string;note:string}):Promise<ChequeChainData>{
 const commerce=await loadCommerceData();const endorsement=(commerce.chequeEndorsements||[]).find(e=>e.id===input.endorsementId);if(!endorsement)throw new Error('سابقه ظهرنویسی اصلی پیدا نشد.');
 const chain=await loadChequeChain();const rootTransfer= input.parentTransferId?chain.transfers.find(t=>t.id===input.parentTransferId&&t.endorsementId===input.endorsementId):undefined;
 if(input.parentTransferId&&!rootTransfer)throw new Error('مرحله قبلی انتقال معتبر نیست.');
 const expectedHolder=rootTransfer?.toPartyId||endorsement.toPartyId;if(input.fromPartyId!==expectedHolder)throw new Error('انتقال‌دهنده با دارنده فعلی چک مطابقت ندارد.');
 const from=commerce.parties.find(p=>p.id===input.fromPartyId&&p.isActive);const to=commerce.parties.find(p=>p.id===input.toPartyId&&p.isActive);if(!from||!to)throw new Error('انتقال‌دهنده و دریافت‌کننده باید طرف حساب فعال باشند.');if(from.id===to.id)throw new Error('دارنده فعلی و دریافت‌کننده نمی‌توانند یک شخص باشند.');
 if(!validDate(input.date))throw new Error('تاریخ انتقال باید شمسی و به شکل YYYY/MM/DD باشد.');
 const amountAvailable=getChainAvailable(input.endorsementId,commerce,chain,input.parentTransferId);const outcomeData=await idbGet<{schemaVersion:number;outcomes:Array<{endorsementId:string;parentTransferId?:string;amountRial:number}>}>('accounting_phase40_cheque_holder_outcomes');const alreadyResolved=(outcomeData?.outcomes||[]).filter(x=>x.endorsementId===input.endorsementId&&x.parentTransferId===input.parentTransferId).reduce((sum,x)=>sum+x.amountRial,0);const transferable=Math.max(0,amountAvailable-alreadyResolved);if(!Number.isSafeInteger(input.amountRial)||input.amountRial<=0||input.amountRial>transferable)throw new Error('مبلغ انتقال معتبر نیست یا از مانده قابل انتقال پس از تعیین‌تکلیف بیشتر است.');
 const transfer:ChequeChainTransfer={id:makeId(),endorsementId:input.endorsementId,...(input.parentTransferId?{parentTransferId:input.parentTransferId}:{}),fromPartyId:from.id,toPartyId:to.id,amountRial:input.amountRial,date:input.date,note:input.note.trim(),createdAt:now()};
 const next={...chain,transfers:[...chain.transfers,transfer]};await idbPut(KEY,next);logAudit('cheque_chain_transferred',{endorsementId:input.endorsementId,parentTransferId:input.parentTransferId,fromPartyId:from.id,toPartyId:to.id,amountRial:input.amountRial,date:input.date});return next;
}
