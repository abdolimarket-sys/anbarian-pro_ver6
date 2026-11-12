/** رابط فاکتورها و دریافت/پرداخت */
import { loadAccountingData, parseMoneyToRial, formatMoneyFromRial, resolveActiveFiscalPeriod } from './accounting';
import {
  loadCommerceData, saveCommerceData, buildInvoice, updateDraftInvoice, postInvoice,
  createCashTransaction, ensureCommerceAccounts, updateChequeStatus, invoiceOutstanding,
  upsertParty, recordOperatingEntry, listOperatingEntries, postInventoryNrvWriteDown,
  assertDefaultPartyAllowed, DEFAULT_CUSTOMER_PARTY_ID, DEFAULT_SUPPLIER_PARTY_ID,
  type CommerceData, type AccountingParty, type InvoiceType, type InvoicePaymentPart, isSaleInvoiceType, isPurchaseInvoiceType,
} from './accounting-commerce';
import { toast } from './ui';
import { printHtmlSafely, shareFileContent, downloadFile } from '@/utils/helpers';
import { openProductModal, offerAddProduct } from './products-ui';
import { enhanceSelectWithSearch, refreshSearchableSelect, normalizeSearchText } from './searchable-select';
import { openSmsComposeDialog } from './sms';
import { choosePaperSize } from './print-paper';
import { enhanceDateFields, attachJalaliCalendar, todayJalali as sharedTodayJalali } from './date-picker';
import { products, logAudit, findProductByCode, settings } from './state';
import { openScanner } from './scanner';
import { loadInventoryCostData, saveInventoryCostData, setOpeningStockCost, getCostBalance, buildNrvAnalysis, buildPurchaseStandardVariance, type InventoryCostData } from './inventory-costing';
import { warehouseName } from './warehouse-stock';
import { buildInventoryReconciliation } from './inventory-reconciliation';
import {
  createInternalTransfer, getBankAccountBalances, importBankStatement, loadBankReconciliation, parseBankStatementCsv,
  createCashBankMove, createBankFee, getBankAccountLedger, getBankReconciliationSummary,
} from './accounting-bank';
import { extendChequeDueDate, getChequeDashboard, loadChequeBook, recordChequeEvent, replaceChequeDetails } from './accounting-cheques';
import { endorseCheque, getChequeEndorsement, getChequeEndorsements, getChequeEndorsementRemaining } from './accounting-cheque-endorsement';
import { loadChequeChain, getChainAvailable, transferEndorsedCheque } from './accounting-cheque-chain';
import { getChequeOutcomeReport, getOutcomeAvailable, loadChequeOutcomes, recordChequeHolderOutcome } from './accounting-cheque-outcomes';
import { getAgingDashboard, type AgingBucket } from './accounting-aging';
import { getCashflowDashboard } from './accounting-cashflow';
import { getProfitabilityDashboard, getExpenseAdjustedProfitability, getProfitabilityPeriodComparison, getMonthlyProfitabilityTrend, buildInventoryMarginAnalytics, type ProfitabilityFilter } from './accounting-profitability';
import { exportProfitabilityXlsx, printProfitabilityPdf } from './accounting-profitability-export';
import { exportManagementDashboardXlsx, printManagementDashboardPdf } from './management-dashboard-export';
import { exportManagementMonthXlsx, printManagementMonthPdf } from './management-month-export';
import { detectManagementMonthAnomalies, type ManagementMonthRow } from './management-anomaly';

let commerce: CommerceData | null = null;
let costingCache: InventoryCostData | null = null;
let editingInvoiceId: string | null = null;
let lastPrintableInvoiceId: string | null = null;
let profitabilityFilter:ProfitabilityFilter={};
let managementFilter:ProfitabilityFilter={};
let currency: 'rial'|'toman' = 'toman';
type CommerceSection = 'home'|'sale'|'purchase'|'receipts'|'cheques'|'aging'|'banking'|'management'|'inventory'|'parties'|'operating';
type CommercePanelSection = Exclude<CommerceSection, 'home'>;
let activeCommerceSection: CommerceSection = 'home';
let activeInvoiceType: InvoiceType = 'sale';
let editingPartyId: string | null = null;
let suppressCommerceSheetReopen = false;
let saveInvoiceDraftHandler: ((quiet?:boolean)=>Promise<string|null>) | null = null;
const invoiceTypeTitle=(t:InvoiceType)=>t==='sale'?'فاکتور فروش':t==='purchase'?'فاکتور خرید':t==='return-sale'?'برگشت از فروش':t==='return-purchase'?'برگشت از خرید':'پیش‌فاکتور';
let fiscalPeriodsCache: Array<{id:string;startDate:string;endDate:string;status:string}> = [];
const fa=(n:number)=>new Intl.NumberFormat('fa-IR').format(n);
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const digits=(s:string)=>s.replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const el=<T extends HTMLElement>(s:string)=>document.querySelector<T>(s);
/** اولویت با برگه باز فاکتور؛ اگر برگه باز است workspace (فرم خالی بعد از render) خوانده نشود */
const invoiceRoots=():ParentNode[]=>{
  const sheet=document.getElementById('commercePanelSheet');
  const items=document.getElementById('invoiceItemsSheet');
  const roots:ParentNode[]=[];
  if(sheet) roots.push(sheet);
  if(items) roots.push(items);
  // فقط وقتی برگه فاکتور باز نیست از workspace استفاده کن
  if(!sheet){
    const ws=document.getElementById('accountingCommerceWorkspace');
    if(ws) roots.push(ws);
  }
  if(!roots.length) roots.push(document);
  return roots;
};
const q=<T extends HTMLElement>(s:string):T|null=>{
  for(const root of invoiceRoots()){
    const hit=root.querySelector<T>(s);
    if(hit)return hit;
  }
  return null;
};
const qAll=<T extends HTMLElement>(s:string):T[]=>{
  const seen=new Set<T>();
  const out:T[]=[];
  for(const root of invoiceRoots()){
    for(const node of root.querySelectorAll<T>(s)){
      if(seen.has(node))continue;
      seen.add(node);
      out.push(node);
    }
  }
  return out;
};

const id=(p:string)=>`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
function money(rial:number):string { try{return `${fa(Number(formatMoneyFromRial(rial,currency)))} ${currency==='toman'?'تومان':'ریال'}`;}catch{return fa(rial)} }

async function applyDefaultPartySelection(): Promise<void> {
  const partySel = el<HTMLSelectElement>('#invoiceParty');
  if (!partySel || partySel.value || editingInvoiceId) return;
  try {
    const acc = await loadAccountingData();
    const sale = isSaleInvoiceType(activeInvoiceType);
    if (sale && acc.settings.allowDefaultCustomerSales !== false) {
      if ([...partySel.options].some(o => o.value === DEFAULT_CUSTOMER_PARTY_ID)) {
        partySel.value = DEFAULT_CUSTOMER_PARTY_ID;
        refreshSearchableSelect(partySel);
      }
    } else if (!sale && acc.settings.allowDefaultSupplierPurchases !== false) {
      if ([...partySel.options].some(o => o.value === DEFAULT_SUPPLIER_PARTY_ID)) {
        partySel.value = DEFAULT_SUPPLIER_PARTY_ID;
        refreshSearchableSelect(partySel);
      }
    }
  } catch { /* ignore */ }
}

function partyOptions(type?:'customer'|'supplier'):string {
  return (commerce?.parties||[]).filter(p=>p.isActive&&(!type||p.type==='both'||p.type===type)).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
}
function partyTypeLabel(t:AccountingParty['type']):string {
  return t==='customer'?'مشتری':t==='supplier'?'تأمین‌کننده':'مشتری و تأمین‌کننده';
}

function bindPartySmsButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-sms-party]').forEach((btn) => {
    if ((btn as any)._smsBound) return;
    (btn as any)._smsBound = true;
    btn.addEventListener('click', () => {
      const id = btn.dataset.smsParty || '';
      const p = (commerce?.parties || []).find((x) => x.id === id);
      if (!p) return;
      openSmsComposeDialog({
        phone: p.phone || '',
        name: p.name,
        title: `پیامک به ${p.name}`,
      });
    });
  });
}

function partiesPanelHtml():string {
  const rows=(commerce?.parties||[]).slice().sort((a,b)=>a.name.localeCompare(b.name,'fa')).map(p=>`<tr class="${p.isActive?'':'party-inactive'}"><td>${esc(p.name)}</td><td>${partyTypeLabel(p.type)}</td><td>${esc(p.phone||'—')}</td><td>${esc(p.nationalId||'—')}</td><td>${esc(p.address||'—')}</td><td>${p.isActive?'فعال':'غیرفعال'}</td><td style="white-space:nowrap"><button type="button" class="btn btn-sm btn-secondary" data-edit-party="${esc(p.id)}">ویرایش</button>${p.phone?` <button type="button" class="btn btn-sm btn-secondary" data-sms-party="${esc(p.id)}">پیامک</button>`:''}</td></tr>`).join('')||'<tr><td colspan="7">هنوز طرف حسابی ثبت نشده است.</td></tr>';
  const editing=editingPartyId?(commerce?.parties||[]).find(p=>p.id===editingPartyId):undefined;
  return `<div class="card" style="margin-top:12px" dir="rtl">
<h3>تعریف شخص / طرف حساب</h3>
<p class="hint">فیلدهای استاندارد: نام، موبایل، آدرس، شناسه ملی، کد اقتصادی، شماره ثبت، کد پستی و نوع طرف حساب. از همین فرم می‌توانید مشتری یا تأمین‌کننده جدید بسازید یا ویرایش کنید.</p>
<div class="form-grid" id="partyFormGrid">
<input type="hidden" id="partyEditId" value="${esc(editing?.id||'')}">
<label class="field">نام <span class="required">*</span><input id="partyName" value="${esc(editing?.name||'')}" placeholder="نام شخص یا شرکت" autocomplete="name"></label>
<label class="field">نوع طرف حساب
<select id="partyType">
<option value="customer"${!editing||editing.type==='customer'?' selected':''}>مشتری</option>
<option value="supplier"${editing?.type==='supplier'?' selected':''}>تأمین‌کننده</option>
<option value="both"${editing?.type==='both'?' selected':''}>مشتری و تأمین‌کننده</option>
</select></label>
<label class="field">موبایل / تلفن<input id="partyPhone" value="${esc(editing?.phone||'')}" placeholder="۰۹۱۲..." inputmode="tel" autocomplete="tel"></label>
<label class="field">شناسه ملی / کد ملی<input id="partyNationalId" value="${esc(editing?.nationalId||'')}" placeholder="۱۰ تا ۱۴ رقم" inputmode="numeric"></label>
<label class="field">کد اقتصادی<input id="partyEconomicCode" value="${esc(editing?.economicCode||'')}" placeholder="اختیاری"></label>
<label class="field">شماره ثبت<input id="partyRegistrationNumber" value="${esc(editing?.registrationNumber||'')}" placeholder="اختیاری"></label>
<label class="field">کد پستی<input id="partyPostalCode" value="${esc(editing?.postalCode||'')}" placeholder="۱۰ رقم" inputmode="numeric"></label>
<label class="field" style="grid-column:1/-1">آدرس<textarea id="partyAddress" rows="2" placeholder="نشانی کامل">${esc(editing?.address||'')}</textarea></label>
<label class="field"><span>وضعیت</span><select id="partyIsActive"><option value="1"${!editing||editing.isActive?' selected':''}>فعال</option><option value="0"${editing&&!editing.isActive?' selected':''}>غیرفعال</option></select></label>
</div>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
<button type="button" class="btn btn-primary" id="partySaveBtn">${editing?'ذخیره تغییرات':'ثبت شخص جدید'}</button>
<button type="button" class="btn btn-secondary" id="partyResetBtn" ${editing?'':'hidden'}>انصراف از ویرایش</button>
</div>
<h4 style="margin-top:22px">فهرست طرف حساب‌ها</h4>
<div class="table-wrap"><table class="data-table"><thead><tr><th>نام</th><th>نوع</th><th>موبایل</th><th>شناسه ملی</th><th>آدرس</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>`;
}
function collectPartyForm():Omit<AccountingParty,'id'|'createdAt'|'updatedAt'> & {id?:string} {
  const idVal=el<HTMLInputElement>('#partyEditId')?.value.trim()||undefined;
  return {
    id:idVal||undefined,
    name:(el<HTMLInputElement>('#partyName')?.value||'').trim(),
    type:(el<HTMLSelectElement>('#partyType')?.value||'customer') as AccountingParty['type'],
    phone:(el<HTMLInputElement>('#partyPhone')?.value||'').trim(),
    nationalId:digits((el<HTMLInputElement>('#partyNationalId')?.value||'').trim()),
    economicCode:(el<HTMLInputElement>('#partyEconomicCode')?.value||'').trim(),
    registrationNumber:(el<HTMLInputElement>('#partyRegistrationNumber')?.value||'').trim(),
    postalCode:digits((el<HTMLInputElement>('#partyPostalCode')?.value||'').trim()),
    address:(el<HTMLTextAreaElement>('#partyAddress')?.value||'').trim(),
    isActive:(el<HTMLSelectElement>('#partyIsActive')?.value||'1')==='1',
  };
}
async function savePartyFromForm(selectInInvoice=false):Promise<AccountingParty|null> {
  if(!commerce)return null;
  try{
    const input=collectPartyForm();
    const beforeIds=new Set(commerce.parties.map(p=>p.id));
    const next=upsertParty(commerce,input);
    const saved=input.id
      ? next.parties.find(p=>p.id===input.id)
      : next.parties.find(p=>!beforeIds.has(p.id))||next.parties.find(p=>p.name===input.name);
    if(!saved)throw new Error('ثبت طرف حساب ناموفق بود.');
    await saveCommerceData(next);
    commerce=next;
    editingPartyId=null;
    logAudit('party_upsert',{partyId:saved.id,name:input.name,type:input.type});
    toast(input.id?'طرف حساب به‌روزرسانی شد.':'شخص جدید ثبت شد.','success');
    if(selectInInvoice){
      const sel=el<HTMLSelectElement>('#invoiceParty');
      if(sel){
        sel.innerHTML='<option value="">انتخاب</option>'+partyOptions(isSaleInvoiceType(activeInvoiceType)?'customer':'supplier');
        sel.value=saved.id;
        refreshSearchableSelect(sel);
      }
      const cashSel=el<HTMLSelectElement>('#cashParty');
      if(cashSel){
        const t=el<HTMLSelectElement>('#cashType')?.value;
        cashSel.innerHTML='<option value="">انتخاب</option>'+partyOptions(t==='payment'?'supplier':'customer');
        cashSel.value=saved.id;
        refreshSearchableSelect(cashSel);
      }
    }
    return saved;
  }catch(e){
    toast(e instanceof Error?e.message:'خطا در ثبت طرف حساب','error');
    return null;
  }
}
function openPartyFormSheet(opts?:{preferType?:'customer'|'supplier'|'both'; selectAfterSave?:boolean; prefillName?:string}):void {
  document.getElementById('partyFormSheet')?.remove();
  const prefer=opts?.preferType||(isSaleInvoiceType(activeInvoiceType)?'customer':'supplier');
  editingPartyId=null;
  const overlay=document.createElement('div');
  overlay.id='partyFormSheet';
  overlay.dir='rtl';
  overlay.style.cssText='position:fixed;inset:0;z-index:10120;background:var(--surface,#fff);color:var(--text,#222);overflow:auto;padding:clamp(12px,3vw,28px)';
  overlay.innerHTML=`<div style="max-width:900px;margin:0 auto"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px"><h2 style="margin:0">تعریف شخص جدید</h2><button type="button" class="btn btn-secondary" id="partySheetClose">بستن</button></div>${partiesPanelHtml()}</div>`;
  document.body.appendChild(overlay);
  const typeSel=overlay.querySelector<HTMLSelectElement>('#partyType');
  if(typeSel&&!editingPartyId)typeSel.value=prefer;
  if(opts?.prefillName){const n=overlay.querySelector<HTMLInputElement>('#partyName');if(n)n.value=opts.prefillName;}
  const close=(clearEdit=true)=>{overlay.remove();if(clearEdit)editingPartyId=null;};
  overlay.querySelector('#partySheetClose')?.addEventListener('click',()=>close(true));
  overlay.querySelector('#partySaveBtn')?.addEventListener('click',async()=>{
    const saved=await savePartyFromForm(!!opts?.selectAfterSave);
    if(saved){close(true);await render();}
  });
  overlay.querySelector('#partyResetBtn')?.addEventListener('click',()=>{editingPartyId=null;close(true);openPartyFormSheet(opts);});
  bindPartySmsButtons(overlay);
overlay.querySelectorAll<HTMLButtonElement>('[data-edit-party]').forEach(btn=>btn.addEventListener('click',()=>{
    editingPartyId=btn.dataset.editParty||null;
    close(false);
    openPartyFormSheet({preferType:prefer,selectAfterSave:opts?.selectAfterSave});
  }));
}
function periodOptions():string {
  return loadPeriodOptions;
}
async function activeFiscalPeriodId():Promise<string> {
  const d=await loadAccountingData();
  return resolveActiveFiscalPeriod(d).id;
}
let loadPeriodOptions='';
function accountOptions():string {
  return accountOptionsCache;
}
let accountOptionsCache='';
async function operatingPanelHtml():Promise<string>{
  const acc=await loadAccountingData();
  const expenseOpts=acc.accounts.filter(a=>a.isActive&&a.level==='detail'&&a.code.startsWith('6'))
    .map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
  const incomeOpts=acc.accounts.filter(a=>a.isActive&&a.level==='detail'&&a.code.startsWith('4'))
    .map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
  const cashOpts=acc.accounts.filter(a=>a.isActive&&a.level==='detail'&&(a.code.startsWith('1101')||a.id==='det-cash'||a.id==='det-bank'||/صندوق|بانک|تنخواه/.test(a.title)))
    .map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('')||accountOptionsCache;
  const periodOpts=periodOptions()||acc.fiscalPeriods.filter(p=>p.status==='open').map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
  const recent=listOperatingEntries(acc,undefined,40);
  const recentRows=recent.map(x=>`<tr><td>${esc(x.date)}</td><td>${x.kind==='expense'?'هزینه':'درآمد'}</td><td>${esc(x.number)}</td><td>${esc(x.accountCode)} ${esc(x.accountTitle)}</td><td>${esc(x.description)}</td><td>${money(x.amountRial)}</td></tr>`).join('')
    ||'<tr><td colspan="6">هنوز هزینه یا درآمدی از این بخش ثبت نشده است.</td></tr>';
  return `<div class="card" dir="rtl">
<h3>ثبت هزینه و درآمد</h3>
<p class="hint">برای هزینه‌های متفرقه (اجاره، حقوق، ملزومات و …) و درآمدهای غیر از فاکتور فروش. با ثبت، سند حسابداری قطعی ساخته می‌شود.</p>
<div class="form-grid">
<label class="field">نوع ثبت<select id="opKind"><option value="expense">هزینه</option><option value="income">درآمد</option></select></label>
<label class="field">تاریخ شمسی<input id="opDate" value="${todayJalali()}" placeholder="1405/01/01" inputmode="numeric"></label>
<label class="field">سال مالی<select id="opPeriod">${periodOpts||'<option value="">سال مالی باز تعریف نشده</option>'}</select></label>
<label class="field">مبلغ (${currency==='toman'?'تومان':'ریال'})<input id="opAmount" inputmode="decimal" placeholder="۰"></label>
<label class="field" id="opAccountExpenseWrap">حساب هزینه<select id="opExpenseAccount"><option value="">انتخاب حساب هزینه</option>${expenseOpts}</select></label>
<label class="field" id="opAccountIncomeWrap" hidden>حساب درآمد<select id="opIncomeAccount"><option value="">انتخاب حساب درآمد</option>${incomeOpts}</select></label>
<label class="field">از / به صندوق یا بانک<select id="opCashAccount"><option value="">انتخاب حساب</option>${cashOpts}</select></label>
<label class="field">طرف حساب (اختیاری)<select id="opParty"><option value="">بدون طرف حساب</option>${partyOptions()}</select></label>
<label class="field" style="grid-column:1/-1">شرح<input id="opDescription" placeholder="مثلاً اجاره فروردین / درآمد اجاره انبار"></label>
</div>
<div class="actions"><button type="button" class="btn btn-primary" id="opSave">ثبت و صدور سند</button></div>
<h4 style="margin-top:20px">آخرین ثبت‌ها</h4>
<div class="table-wrap"><table class="data-table"><thead><tr><th>تاریخ</th><th>نوع</th><th>شماره سند</th><th>حساب</th><th>شرح</th><th>مبلغ</th></tr></thead><tbody>${recentRows}</tbody></table></div>
</div>`;
}
function normalizeJalaliDate(raw:string):string {
  const d=digits((raw||'').trim()).replace(/-/g,'/').replace(/\./g,'/');
  const m=d.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if(!m) return '';
  return `${m[1]}/${m[2].padStart(2,'0')}/${m[3].padStart(2,'0')}`;
}
function invoicePeriodForDate(date:string):string {
  const d=normalizeJalaliDate(date);
  if(!d) throw new Error('تاریخ فاکتور باید به شکل سال/ماه/روز شمسی باشد (مثال: 1405/08/16).');
  const norm=(s:string)=>normalizeJalaliDate(s)||s;
  const exact=fiscalPeriodsCache.find(p=>p.status==='open'&&d>=norm(p.startDate)&&d<=norm(p.endDate));
  if(exact) return exact.id;
  const open=fiscalPeriodsCache.filter(p=>p.status==='open');
  if(open.length) return open[open.length-1].id;
  throw new Error('هیچ سال مالی بازی در حافظه نیست. یک‌بار برنامه را ببندید و باز کنید یا از حسابداری سال مالی باز بسازید.');
}
async function refreshFiscalCache():Promise<void> {
  try{
    const acc=await loadAccountingData();
    fiscalPeriodsCache=acc.fiscalPeriods.map(p=>({id:p.id,startDate:p.startDate,endDate:p.endDate,status:p.status}));
    accountOptionsCache=acc.accounts.filter(a=>a.isActive&&a.level==='detail'&&['det-cash','det-bank'].includes(a.id)).map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
  }catch(e){ console.warn('[anbarin] refreshFiscalCache', e); }
}
function todayJalali():string {
  const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return `${parts.find(x=>x.type==='year')?.value}/${parts.find(x=>x.type==='month')?.value}/${parts.find(x=>x.type==='day')?.value}`;
}
function nextInvoiceNumber(type:InvoiceType):string {
  const prefix=type==='sale'?'S':type==='purchase'?'P':type==='return-sale'?'RS':type==='return-purchase'?'RP':'PF';
  const numbers=(commerce?.invoices||[]).filter(i=>i.type===type).map(i=>{const m=i.number.match(new RegExp(`^${prefix}-(\\d+)$`));return m?Number(m[1]):0;});
  return `${prefix}-${String(Math.max(0,...numbers)+1).padStart(6,'0')}`;
}
const INVOICE_LIST_LIMIT = 8;
function invoiceRows(type:InvoiceType):string {
  const all=(commerce?.invoices||[]).filter(i=>i.type===type).slice().reverse();
  const list=all.slice(0,INVOICE_LIST_LIMIT);
  if(!list.length) return '<tr><td colspan="6" class="invoice-list-empty">برای این بخش هنوز فاکتوری ثبت نشده است.</td></tr>';
  return list.map(i=>{
    const p=commerce?.parties.find(x=>x.id===i.partyId);
    const status=i.status==='posted'?'قطعی':'پیش‌نویس';
    const statusCls=i.status==='posted'?'is-posted':'is-draft';
    const actions=i.status==='draft'
      ?`<button class="btn btn-sm btn-secondary" data-edit-invoice="${i.id}">ویرایش</button>${i.type==='proforma'?'':'<button class="btn btn-sm btn-primary" data-post-invoice="'+i.id+'">تسویه</button>'}`
      :'';
    return `<tr class="invoice-list-row">
      <td><b>${esc(i.number)}</b></td>
      <td class="invoice-list-party">${esc(p?.name||'—')}</td>
      <td>${esc(i.date)}</td>
      <td class="invoice-list-amount">${money(i.grossRial)}</td>
      <td><span class="invoice-status-pill ${statusCls}">${status}</span></td>
      <td class="invoice-list-actions">
        <button class="btn btn-sm btn-secondary" data-print-invoice="${i.id}">چاپ</button>
        <button class="btn btn-sm btn-secondary" data-share-invoice="${i.id}">اشتراک</button>
        ${actions}
      </td>
    </tr>`;
  }).join('');
}
function invoiceListFooter(type:InvoiceType):string {
  const total=(commerce?.invoices||[]).filter(i=>i.type===type).length;
  if(total<=INVOICE_LIST_LIMIT) return total?`<p class="invoice-list-hint">${total} فاکتور</p>`:'';
  return `<p class="invoice-list-hint">نمایش ${INVOICE_LIST_LIMIT} مورد اخیر از ${total} فاکتور</p>`;
}
function cashRows():string {
  return (commerce?.cashTransactions||[]).slice().reverse().map(t=>{const p=commerce?.parties.find(x=>x.id===t.partyId);const method=t.method==='cheque'?'چک':t.method==='bank'?'بانک':t.method==='card'?'کارت‌خوان':t.method==='transfer'?'حواله':'نقد';const status=t.chequeStatus==='pending'?'در انتظار وصول':t.chequeStatus==='cleared'?'وصول/تسویه‌شده':t.chequeStatus==='bounced'?'برگشتی':t.chequeStatus==='void'?'باطل':'قطعی';const endorsed=!!getChequeEndorsement(t.id,commerce!);const actions=t.chequeStatus==='pending'?`${endorsed?'چک ظهرنویسی شده؛ ':''}${!endorsed?`<button class="btn btn-sm btn-secondary" data-cheque-clear="${t.id}">وصول/تسویه</button> `:''}<button class="btn btn-sm btn-secondary" data-cheque-bounce="${t.id}">برگشتی</button>`:'—';return `<tr><td>${esc(t.number)}</td><td>${t.type==='receipt'?'دریافت':'پرداخت'} (${method})</td><td>${esc(p?.name||'—')}</td><td>${esc(t.date)}</td><td>${money(t.amountRial)}</td><td>${status}${t.chequeNumber?`<br>چک ${esc(t.chequeNumber)} · ${esc(t.chequeDueDate||'')}`:''}</td><td>${actions}</td></tr>`}).join('')||'<tr><td colspan="7">هنوز دریافت یا پرداختی ثبت نشده است.</td></tr>';
}
function addInvoicePaymentRow(part?:InvoicePaymentPart):void {
 const host=el<HTMLDivElement>('#invoicePaymentRows');if(!host)return;
 const row=document.createElement('div');row.className='form-grid invoice-payment-row';row.style.cssText='border:1px solid var(--border-color,#ddd);border-radius:8px;padding:10px;margin:8px 0;align-items:end';
 row.innerHTML=`<label class="field">روش پرداخت<select data-pay-method><option value="card">کارت‌خوان</option><option value="cash">نقدی</option><option value="cheque">چک</option><option value="credit">اعتباری (مانده بدهی)</option></select></label><label class="field">مبلغ (${currency==='toman'?'تومان':'ریال'})<input data-pay-amount inputmode="numeric" placeholder="مبلغ این مرحله"></label><label class="field" data-pay-cheque hidden style="display:none">شماره چک *<input data-pay-cheque-number autocomplete="off"></label><label class="field" data-pay-cheque hidden style="display:none">بانک *<input data-pay-cheque-bank autocomplete="off"></label><label class="field" data-pay-cheque hidden style="display:none">شماره صیادی *<input data-pay-cheque-account autocomplete="off" placeholder="شناسه صیادی ۱۶ یا ۲۰ رقمی" inputmode="numeric"></label><label class="field" data-pay-cheque hidden style="display:none">سررسید چک شمسی *<input data-pay-cheque-due placeholder="1405/01/30" inputmode="numeric" autocomplete="off"></label><label class="field" data-pay-cheque hidden style="display:none">توضیحات چک<input data-pay-cheque-note autocomplete="off"></label><button type="button" class="btn btn-sm btn-secondary" data-pay-remove>حذف این مرحله</button>`;
 host.appendChild(row);const method=row.querySelector<HTMLSelectElement>('[data-pay-method]')!;method.value=part?.method||'cash';row.querySelector<HTMLInputElement>('[data-pay-amount]')!.value=part?formatMoneyFromRial(part.amountRial,currency):'';row.querySelector<HTMLInputElement>('[data-pay-cheque-number]')!.value=part?.chequeNumber||'';row.querySelector<HTMLInputElement>('[data-pay-cheque-bank]')!.value=part?.chequeBank||'';row.querySelector<HTMLInputElement>('[data-pay-cheque-account]')!.value=part?.chequeAccount||'';row.querySelector<HTMLInputElement>('[data-pay-cheque-due]')!.value=part?.chequeDueDate||'';row.querySelector<HTMLInputElement>('[data-pay-cheque-note]')!.value=part?.note||'';
 const toggle=()=>{const show=method.value==='cheque';row.querySelectorAll<HTMLElement>('[data-pay-cheque]').forEach(x=>{x.hidden=!show;x.style.display=show?'':'none';});};method.addEventListener('change',toggle);toggle();row.querySelector('[data-pay-remove]')!.addEventListener('click',()=>row.remove());
}
function readInvoicePaymentParts():InvoicePaymentPart[]{return [...document.querySelectorAll<HTMLElement>('.invoice-payment-row')].map(row=>{const method=row.querySelector<HTMLSelectElement>('[data-pay-method]')!.value as InvoicePaymentPart['method'];return {method,amountRial:parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-pay-amount]')!.value||'0'),currency),...(method==='cheque'?{chequeNumber:row.querySelector<HTMLInputElement>('[data-pay-cheque-number]')!.value,chequeBank:row.querySelector<HTMLInputElement>('[data-pay-cheque-bank]')!.value,chequeAccount:row.querySelector<HTMLInputElement>('[data-pay-cheque-account]')!.value,chequeDueDate:digits(row.querySelector<HTMLInputElement>('[data-pay-cheque-due]')!.value),note:row.querySelector<HTMLInputElement>('[data-pay-cheque-note]')!.value}:{})};}).filter(x=>x.amountRial>0);}

function productOptions():string{return products.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.code||p.sku||p.id)} (${esc(p.warehouse||'انبار اصلی')})</option>`).join('')}
/** کالاهای دارای موجودی که هنوز ارزش‌گذاری اولیه نشده‌اند */
async function listPendingOpeningValuation():Promise<Array<{product:typeof products[0];warehouse:string;qty:number;unitHint:number;hasPrice:boolean}>>{
  const costing=await loadInventoryCostData();
  const out:Array<{product:typeof products[0];warehouse:string;qty:number;unitHint:number;hasPrice:boolean}>=[];
  for(const p of products){
    const qty=Number(p.systemQty)||0;
    if(qty<=0) continue;
    const warehouse=p.warehouse||'انبار اصلی';
    if(costing.balances.some(b=>b.productId===p.id&&b.warehouse===warehouse)) continue;
    if(costing.movements.some(m=>m.productId===p.id&&m.warehouse===warehouse)) continue;
    const unitHint=Number(p.purchasePrice)||Number(p.price)||0;
    out.push({product:p,warehouse,qty,unitHint,hasPrice:unitHint>0});
  }
  return out.sort((a,b)=>a.product.name.localeCompare(b.product.name,'fa'));
}
async function openingStockPanel():Promise<string>{
  const pending=await listPendingOpeningValuation();
  const withPrice=pending.filter(x=>x.hasPrice).length;
  const withoutPrice=pending.length-withPrice;
  const unitLabel=currency==='toman'?'تومان':'ریال';
  const rows=pending.slice(0,80).map(x=>`<tr>
    <td>${esc(x.product.name)}</td>
    <td>${esc(x.product.code||x.product.sku||'—')}</td>
    <td>${esc(x.warehouse)}</td>
    <td>${fa(x.qty)}</td>
    <td>${x.hasPrice?money(parseMoneyToRial(String(x.unitHint),currency)):'<span class="hint">بدون قیمت خرید</span>'}</td>
  </tr>`).join('')||'<tr><td colspan="5">کالای در انتظار ارزش‌گذاری نیست — یا موجودی صفر است یا قبلاً ثبت شده.</td></tr>';
  return `<div class="card" style="margin-top:14px" dir="rtl">
<h3>ارزش‌گذاری موجودی اولیه</h3>
<p class="hint">برای کالاهایی که از فایل وارد شده‌اند و موجودی دارند، به‌جای ثبت یکی‌یکی می‌توانید <b>ارزش‌گذاری گروهی</b> بزنید. بهای واحد از <b>قیمت خرید</b> کالا گرفته می‌شود (اگر خالی باشد از قیمت فروش).</p>
<div class="form-grid" style="margin:10px 0">
  <div class="stat-card"><b>${fa(pending.length)}</b><span>در انتظار ارزش‌گذاری</span></div>
  <div class="stat-card"><b>${fa(withPrice)}</b><span>دارای قیمت خرید/فروش</span></div>
  <div class="stat-card"><b>${fa(withoutPrice)}</b><span>بدون قیمت (رد می‌شوند)</span></div>
</div>
<div class="form-grid">
  <label class="field">تاریخ ارزش‌گذاری شمسی<input id="openingCostDate" placeholder="1405/01/01" value="${todayJalali()}"></label>
</div>
<div class="actions" style="margin:10px 0;display:flex;flex-wrap:wrap;gap:8px">
  <button type="button" class="btn btn-primary" id="openingCostBulk">ارزش‌گذاری گروهی با قیمت خرید کالاها</button>
  <button type="button" class="btn btn-secondary" id="openingCostRefresh" title="بروزرسانی فهرست">بروزرسانی فهرست</button>
</div>
<p class="hint">فقط کالاهایی که هنوز گردش خرید/فروش حسابداری ندارند ارزش‌گذاری می‌شوند. کالاهای بدون قیمت خرید در تعریف کالا را بعداً قیمت بدهید و دوباره گروهی بزنید.</p>
<div class="table-wrap" style="max-height:280px;overflow:auto;margin-top:8px">
<table class="data-table"><thead><tr><th>کالا</th><th>کد</th><th>انبار</th><th>موجودی</th><th>بهای واحد پیشنهادی</th></tr></thead><tbody>${rows}</tbody></table>
</div>
${pending.length>80?`<p class="hint">نمایش ۸۰ مورد اول از ${fa(pending.length)} کالا</p>`:''}
<hr style="margin:16px 0;border:0;border-top:1px solid var(--border,#b9ddc2)">
<h4 style="margin:0 0 8px">ثبت تکی (اختیاری)</h4>
<div class="form-grid">
  <label class="field">کالا<select id="openingCostProduct"><option value="">انتخاب کالا</option>${productOptions()}</select></label>
  <label class="field">تعداد موجودی فعلی<input id="openingCostQty" inputmode="decimal" placeholder="از موجودی سیستم"></label>
  <label class="field">بهای واحد (${unitLabel})<input id="openingCostUnit" inputmode="numeric" placeholder="ترجیحاً قیمت خرید"></label>
</div>
<button class="btn btn-secondary" id="openingCostSave" type="button">ثبت بهای موجودی اولیه (تکی)</button>
</div>`;
}

function addInvoiceLine(productId?:string):void {
  const host=el<HTMLDivElement>('#commerceInvoiceLines'); if(!host)return;
  const row=document.createElement('div'); row.className='form-grid commerce-line invoice-line-card'; row.setAttribute('dir','rtl');
  row.innerHTML=`<div class="invoice-line-heading"><span class="invoice-line-number"></span><span>قلم</span></div><input type="hidden" data-line-product value=""><input type="hidden" data-line-unit-factor value="1"><div class="field invoice-line-product-name" data-line-product-label hidden><span class="invoice-product-badge">کالای انبار</span> <strong data-line-product-title></strong></div><label class="field">شرح ردیف فاکتور<input data-line-desc placeholder="مثلاً اجرت نصب، مشاوره یا نام کالا"></label><label class="field">واحد اندازه‌گیری<input data-line-unit value="عدد" list="anbarin-invoice-unit-list" placeholder="عدد، کیلوگرم، کارتن..." autocomplete="off"></label><label class="field invoice-unit-mode-field" data-line-unit-mode-wrap hidden>ورود تعداد بر حسب<select data-line-unit-mode><option value="base">واحد پایه</option><option value="pack">واحد بسته</option></select></label><label class="field invoice-stock-field">موجودی فعلی<output data-line-stock class="invoice-line-stock">—</output></label><label class="field">تعداد<input data-line-qty data-recalc inputmode="decimal" value="1"></label><p class="hint" data-line-unit-hint hidden style="grid-column:1/-1;margin:0"></p><label class="field">قیمت واحد (${currency==='toman'?'تومان':'ریال'})<input data-line-price data-recalc inputmode="numeric" placeholder="۰"></label><label class="field">تخفیف (${currency==='toman'?'تومان':'ریال'})<input data-line-discount data-recalc inputmode="numeric" value="0"></label><label class="field invoice-line-total-field">مبلغ این ردیف<input data-line-total readonly value="۰"></label><div class="invoice-internal-profit" data-line-profit-box hidden><span>بهای: <b data-line-cogs>—</b></span><span>سود: <b data-line-gross-profit>—</b></span><span>حاشیه: <b data-line-margin>—</b></span></div><button type="button" class="btn btn-sm btn-secondary invoice-line-remove" data-remove-line>حذف ردیف</button>`;
  const productInput=row.querySelector<HTMLInputElement>('[data-line-product]')!;
  productInput.value=productId||'';
  const descField=row.querySelector<HTMLInputElement>('[data-line-desc]')!;
  const descLabel=descField.closest('label') as HTMLElement|null;
  const unitField=row.querySelector<HTMLInputElement>('[data-line-unit]')!;
  const stockOut=row.querySelector<HTMLOutputElement>('[data-line-stock]');
  const stockField=row.querySelector<HTMLElement>('.invoice-stock-field');
  const productLabel=row.querySelector<HTMLElement>('[data-line-product-label]');
  const productTitle=row.querySelector<HTMLElement>('[data-line-product-title]');
  const factorInput=row.querySelector<HTMLInputElement>('[data-line-unit-factor]')!;
  const modeWrap=row.querySelector<HTMLElement>('[data-line-unit-mode-wrap]');
  const modeSelect=row.querySelector<HTMLSelectElement>('[data-line-unit-mode]');
  const unitHint=row.querySelector<HTMLElement>('[data-line-unit-hint]');
  const refreshUnitUi=()=>{
    const product=products.find(p=>p.id===productInput.value);
    const factor=Math.max(1,Number(product?.unitFactor)||Number(factorInput.value)||1);
    factorInput.value=String(factor);
    const packName=(product?.packUnit||'').trim()||'بسته';
    const baseName=product?.unit||unitField.value||'عدد';
    const canPack=!!product && factor>1;
    if(modeWrap)modeWrap.hidden=!canPack;
    if(modeSelect && canPack){
      modeSelect.innerHTML=`<option value="base">${esc(baseName)} (پایه)</option><option value="pack">${esc(packName)} (×${fa(factor)})</option>`;
    }
    const mode=modeSelect?.value==='pack'?'pack':'base';
    if(canPack && mode==='pack'){
      unitField.value=packName;
      if(unitHint){unitHint.hidden=false;unitHint.textContent=`هر ${packName} = ${fa(factor)} ${baseName} · موجودی بر حسب ${baseName} کم/زیاد می‌شود · قیمت برای هر ${packName}`;}
    }else{
      unitField.value=baseName;
      if(unitHint){
        if(canPack){unitHint.hidden=false;unitHint.textContent=`واحد پایه: ${baseName} · در صورت نیاز ورود با «${packName}» را انتخاب کنید (ضریب ${fa(factor)})`;}
        else unitHint.hidden=true;
      }
    }
  };
  const applyProduct=(id:string)=>{
    productInput.value=id||'';
    const product=products.find(p=>p.id===id);
    if(product){
      descField.value=product.name;
      if(descLabel)descLabel.hidden=true;
      if(productLabel)productLabel.hidden=false;
      if(productTitle)productTitle.textContent=product.name;
      unitField.value=product.unit||'عدد';
      factorInput.value=String(Math.max(1,Number(product.unitFactor)||1));
      if(modeSelect)modeSelect.value='base';
      if(stockOut)stockOut.textContent=`${fa(Number(product.systemQty)||0)} ${product.unit||'عدد'}`;
      if(stockField)stockField.hidden=false;
      const price=row.querySelector<HTMLInputElement>('[data-line-price]')!;
      {
        const isPurchase=isPurchaseInvoiceType(activeInvoiceType);
        const unitPrice=isPurchase
          ?(Number(product.purchasePrice)||Number(product.price)||0)
          :(Number(product.price)||Number(product.consumerPrice)||0);
        if(unitPrice&&(!price.value.trim()||price.dataset.autoFilled==='true')){
          price.value=formatMoneyFromRial(unitPrice,currency);
          price.dataset.autoFilled='true';
        }
      }
    }else{
      if(descLabel)descLabel.hidden=false;
      if(productLabel)productLabel.hidden=true;
      if(productTitle)productTitle.textContent='';
      descField.readOnly=false;
      descField.placeholder='مثلاً اجرت نصب، مشاوره یا نام کالا';
      if(!descField.value.trim())descField.value='';
      if(stockOut)stockOut.textContent='—';
      if(stockField)stockField.hidden=true;
      factorInput.value='1';
      if(modeSelect)modeSelect.value='base';
    }
    refreshUnitUi();
    updateInvoiceTotals();
  };
  if(productId)applyProduct(productId); else { if(stockField)stockField.hidden=true; if(descLabel)descLabel.hidden=false; if(productLabel)productLabel.hidden=true; }
  row.querySelector('[data-remove-line]')?.addEventListener('click',()=>{if(host.children.length>1)row.remove();else toast('فاکتور باید حداقل یک ردیف داشته باشد.','error');updateInvoiceTotals()});
  row.querySelector<HTMLInputElement>('[data-line-price]')?.addEventListener('input',event=>{(event.target as HTMLInputElement).dataset.autoFilled='false'});
  modeSelect?.addEventListener('change',()=>{
    const product=products.find(p=>p.id===productInput.value);
    const factor=Math.max(1,Number(product?.unitFactor)||Number(factorInput.value)||1);
    const price=row.querySelector<HTMLInputElement>('[data-line-price]')!;
    const prev=modeSelect.dataset.prev||'base';
    const next=modeSelect.value==='pack'?'pack':'base';
    if(prev!==next && price.dataset.autoFilled!=='false'){
      const rial=parseMoneyToRial(digits(price.value||'0'),currency);
      if(rial>0){
        const adjusted=next==='pack'?Math.round(rial*factor):Math.round(rial/factor);
        if(adjusted>0){price.value=formatMoneyFromRial(adjusted,currency);price.dataset.autoFilled='true';}
      }
    }
    modeSelect.dataset.prev=next;
    refreshUnitUi();
    updateInvoiceTotals();
  });
  host.appendChild(row);
  row.querySelectorAll<HTMLInputElement>('[data-recalc]').forEach(input=>input.addEventListener('input',()=>updateInvoiceTotals()));
  refreshUnitUi();
  updateInvoiceTotals();
}
function addProductToInvoice(productId:string, keepScanReady=false):void {
  if(!products.some(p=>p.id===productId)){toast('کالای انتخاب‌شده پیدا نشد.','error');return;}
  const linesHost=el<HTMLDivElement>('#commerceInvoiceLines');
  if(linesHost?.children.length===1){const first=linesHost.firstElementChild as HTMLElement;const hasData=!!(first.querySelector<HTMLInputElement>('[data-line-desc]')?.value.trim()||first.querySelector<HTMLInputElement>('[data-line-price]')?.value.trim()||first.querySelector<HTMLInputElement>('[data-line-product]')?.value);if(!hasData)first.remove();}
  addInvoiceLine(productId);
  const host=el<HTMLInputElement>('#invoiceProductSearch');if(host){host.value='';}
  const barcode=el<HTMLInputElement>('#invoiceBarcodeInput');if(barcode)barcode.value='';
  if(keepScanReady){
    host?.focus({preventScroll:true});
  }else{
    el<HTMLElement>('#commerceInvoiceLines')?.lastElementChild?.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
}
function invoiceProductMatches(value:string){
  const raw=(value||'').trim();if(!raw)return [];
  const q=normalizeSearchText(raw);
  if(!q)return [];
  const tokens=q.split(' ').filter(Boolean);
  return products.filter(p=>{
    const hay=normalizeSearchText([p.name,p.code,p.sku].filter(Boolean).join(' '));
    return tokens.every(t=>hay.includes(t));
  }).slice(0,20);
}
function resolveInvoiceProduct(value:string){
  const raw=(value||'').trim();if(!raw)return null;
  const q=normalizeSearchText(raw);
  const matches=invoiceProductMatches(value);
  return matches.find(p=>{
    const name=normalizeSearchText(p.name);
    const code=normalizeSearchText(p.code||'');
    const sku=normalizeSearchText(p.sku||'');
    return name===q||code===q||sku===q;
  }) || (matches.length===1?matches[0]:null);
}
function renderInvoiceProductSuggestions(value:string,activeIndex=0):void{
 const host=el<HTMLDivElement>('#invoiceProductSuggestions');if(!host)return;const matches=invoiceProductMatches(value);if(!matches.length){host.innerHTML='';host.hidden=true;return;}
 host.innerHTML=matches.map((p,i)=>`<button type="button" class="invoice-product-suggestion ${i===activeIndex?'active':''}" role="option" aria-selected="${i===activeIndex}" data-invoice-product-choice="${esc(p.id)}"><span><b>${esc(p.name)}</b><small>${esc(p.code||p.sku||'بدون کد')} · ${esc(p.unit||'عدد')}</small></span><span class="suggestion-stock">موجودی ${fa(Number(p.systemQty)||0)}</span></button>`).join('');host.hidden=false;
 host.querySelectorAll<HTMLButtonElement>('[data-invoice-product-choice]').forEach(b=>b.addEventListener('click',()=>{addProductToInvoice(b.dataset.invoiceProductChoice!);host.hidden=true;}));
}
function invoicePaymentTermsLabel(parts:InvoicePaymentPart[]):string {const labels:Record<InvoicePaymentPart['method'],string>={cash:'نقدی',card:'کارت',cheque:'چکی',credit:'اعتباری'};const unique=[...new Set(parts.map(x=>labels[x.method]))];return unique.length>1?'ترکیبی: '+unique.join('، '):(unique[0]||'اعتباری');}
function readInvoicePaymentPartsSafe():InvoicePaymentPart[]{try{return readInvoicePaymentParts()}catch{return []}}
function settlementRow(part?:InvoicePaymentPart, opts?:{autoRemaining?:boolean}):string {
 const method=part?.method||'cash';
 const isCheque=method==='cheque';
 const amountVal=part && part.amountRial>0?esc(formatMoneyFromRial(part.amountRial,currency)):'';
 const auto=opts?.autoRemaining?'1':'';
 return `<div class="settlement-payment-row settlement-stage-card">
 <div class="settlement-stage-top">
   <div class="settlement-method-picker" data-settle-method-wrap>
     <span class="settlement-method-label">روش پرداخت</span>
     <div class="settlement-method-chips" role="radiogroup" aria-label="روش پرداخت" dir="rtl">
       <button type="button" class="settlement-method-chip ${method==='card'?'is-active':''}" data-settle-method-btn="card" aria-pressed="${method==='card'}">کارت‌خوان</button>
       <button type="button" class="settlement-method-chip ${method==='cash'?'is-active':''}" data-settle-method-btn="cash" aria-pressed="${method==='cash'}">نقدی</button>
       <button type="button" class="settlement-method-chip ${method==='cheque'?'is-active':''}" data-settle-method-btn="cheque" aria-pressed="${method==='cheque'}">چک</button>
     </div>
     <select data-settle-method hidden aria-hidden="true">
       <option value="card" ${method==='card'?'selected':''}>کارت‌خوان</option>
       <option value="cash" ${method==='cash'?'selected':''}>نقدی</option>
       <option value="cheque" ${isCheque?'selected':''}>چک</option>
     </select>
   </div>
   <label class="field settlement-amount-field settlement-field-box">
     <span class="settlement-field-label">مبلغ (${currency==='toman'?'تومان':'ریال'})</span>
     <input data-settle-amount inputmode="numeric" value="${amountVal}" placeholder="مبلغ این مرحله" data-auto-remaining="${auto}">
   </label>
   <button type="button" class="btn btn-sm btn-secondary settlement-remove-btn" data-settle-remove title="حذف این مرحله">حذف</button>
 </div>
 <div class="settlement-cheque-fields settlement-cheque-stack" data-settle-cheque-block dir="rtl" ${isCheque?'':'hidden'} style="${isCheque?'':'display:none'}">
   <div class="settlement-cheque-title">مشخصات چک</div>
   <label class="field settlement-field-box">شماره چک *<input data-settle-cheque-number value="${esc(part?.chequeNumber||'')}" autocomplete="off" inputmode="numeric" dir="rtl"></label>
   <label class="field settlement-field-box">بانک *<input data-settle-cheque-bank value="${esc(part?.chequeBank||'')}" autocomplete="off" dir="rtl"></label>
   <label class="field settlement-field-box">شماره صیادی *<input data-settle-cheque-account value="${esc(part?.chequeAccount||'')}" autocomplete="off" placeholder="شناسه صیادی ۱۶ یا ۲۰ رقمی" inputmode="numeric" dir="ltr" style="text-align:right"></label>
   <label class="field settlement-field-box">تاریخ سررسید چک *<input data-settle-cheque-due value="${esc(part?.chequeDueDate||'')}" placeholder="1405/01/30" inputmode="numeric" autocomplete="off" dir="ltr" style="text-align:right"></label>
   <label class="field settlement-field-box">توضیحات چک<input data-settle-cheque-note value="${esc(part?.note||'')}" autocomplete="off" dir="rtl"></label>
 </div>
 </div>`;
}
function openInvoiceSettlementSheet(invoiceId:string):void {
 const target=commerce?.invoices.find(i=>i.id===invoiceId);if(!target||!commerce)return;
 document.getElementById('invoiceSettlementSheet')?.remove();
 const party=commerce.parties.find(p=>p.id===target.partyId);
 const overlay=document.createElement('div');overlay.id='invoiceSettlementSheet';overlay.dir='rtl';
 overlay.style.cssText='position:fixed;inset:0;z-index:10220;background:var(--surface,#fff);color:var(--text,#222);overflow:auto;padding:clamp(12px,3vw,28px)';
 const isSale=isSaleInvoiceType(target.type);
 const actionLabel=isSale?'دریافت':'پرداخت';
 overlay.innerHTML=`<div style="max-width:1000px;margin:0 auto"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><h2 style="margin:0 0 6px">تسویه فاکتور — ${actionLabel}</h2><p class="hint" style="margin:0">شماره ${esc(target.number)} · ${esc(party?.name||'—')} · مبلغ نهایی ${money(target.grossRial)}</p></div><button type="button" class="btn btn-secondary" id="settlementBack">بازگشت</button></div>
 <div class="card" style="margin-top:16px"><h3>نوع ${actionLabel}</h3><p class="hint">روش و مبلغ را مشخص کنید. می‌توانید چند روش را ترکیب کنید (مثلاً بخشی نقد و بخشی چک). مانده به‌صورت اعتباری ثبت می‌شود.</p><div id="settlementRows">${((target.paymentParts||[]).filter(x=>x.method!=='credit').length?(target.paymentParts||[]).filter(x=>x.method!=='credit'):[{method:'cash' as const,amountRial:Math.max(0,target.grossRial)}]).map(x=>settlementRow(x)).join('')}</div><button type="button" class="btn btn-secondary" id="settlementAdd">افزودن روش ${actionLabel}</button>
 <div class="settlement-credit-box" style="margin-top:12px"><label class="field settlement-field-box"><span class="settlement-field-label">سررسید مانده اعتباری (شمسی)</span><input id="settlementDueDate" value="${esc(target.dueDate||target.date||'')}" placeholder="1405/01/30" inputmode="numeric" autocomplete="off" dir="ltr" style="text-align:right"></label><p class="hint" style="margin:8px 0 0">اگر مبلغ را کامل نقد/کارت/چک بپردازید، سررسید لازم نیست. برای مانده اعتباری سررسید را مشخص کنید.</p></div><div class="card" style="margin-top:12px"><div id="settlementTotals">در حال محاسبه...</div><div id="settlementCredit" class="hint" style="margin-top:8px"></div></div>
 <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"><button type="button" class="btn btn-primary" id="settlementConfirm">تأیید ${actionLabel} و ثبت قطعی</button><button type="button" class="btn btn-secondary" id="settlementCancel">انصراف</button></div></div></div>`;
 document.body.appendChild(overlay);
 // تقویم شمسی مثل بقیه فرم‌ها
 queueMicrotask(()=>{
   enhanceDateFields(overlay);
   overlay.querySelectorAll<HTMLInputElement>('[data-settle-cheque-due], #settlementDueDate').forEach(inp=>{
     delete inp.dataset.calendarEnhanced;
     attachJalaliCalendar(inp);
   });
 });
 const host=overlay.querySelector<HTMLDivElement>('#settlementRows')!;
 const unitLabel=currency==='toman'?'تومان':'ریال';
 const read=():InvoicePaymentPart[]=>[...host.querySelectorAll<HTMLElement>('.settlement-payment-row')].map(row=>{
   const method=(row.querySelector<HTMLSelectElement>('[data-settle-method]')?.value||'cash') as InvoicePaymentPart['method'];
   return {
     method,
     amountRial:parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-settle-amount]')?.value||'0'),currency),
     ...(method==='cheque'?{
       chequeNumber:row.querySelector<HTMLInputElement>('[data-settle-cheque-number]')?.value||'',
       chequeBank:row.querySelector<HTMLInputElement>('[data-settle-cheque-bank]')?.value||'',
       chequeAccount:row.querySelector<HTMLInputElement>('[data-settle-cheque-account]')?.value||'',
       chequeDueDate:digits(row.querySelector<HTMLInputElement>('[data-settle-cheque-due]')?.value||''),
       note:row.querySelector<HTMLInputElement>('[data-settle-cheque-note]')?.value||'',
     }:{}),
   };
 }).filter(x=>x.amountRial>0);
 const sumAllAmounts=()=>{
   let paid=0;
   host.querySelectorAll<HTMLInputElement>('[data-settle-amount]').forEach(inp=>{
     paid+=parseMoneyToRial(digits(inp.value||'0'),currency);
   });
   return paid;
 };
 const update=()=>{
   const paid=sumAllAmounts();
   const credit=Math.max(0,target.grossRial-paid);
   const totals=overlay.querySelector<HTMLElement>('#settlementTotals');
   if(totals){
     totals.innerHTML=`<div class="settlement-totals-grid">
       <div><span>مبلغ فاکتور</span><b>${money(target.grossRial)}</b></div>
       <div><span>ثبت‌شده در مراحل</span><b>${money(paid)}</b></div>
       <div class="${credit>0?'is-credit':''}"><span>مانده</span><b>${money(credit)}</b></div>
     </div>`;
   }
   const creditNode=overlay.querySelector<HTMLElement>('#settlementCredit');
   if(creditNode){
     creditNode.textContent=credit>0
       ?`مانده ${money(credit)} — می‌توانید مرحله بعد اضافه کنید یا همین مانده را اعتباری بگذارید.`
       :'مانده: ۰ — مبلغ کامل پوشش داده شده است.';
   }
   const addBtn=overlay.querySelector<HTMLButtonElement>('#settlementAdd');
   if(addBtn){
     addBtn.textContent=credit>0
       ?`+ مرحله بعد با مانده ${formatMoneyFromRial(credit,currency)} ${unitLabel}`
       :`افزودن روش ${actionLabel}`;
   }
 };
 const toggleChequeFields=(row:HTMLElement)=>{
   const method=row.querySelector<HTMLSelectElement>('[data-settle-method]')?.value||'cash';
   const isCheque=method==='cheque';
   const block=row.querySelector<HTMLElement>('[data-settle-cheque-block]');
   if(block){
     block.hidden=!isCheque;
     block.style.display=isCheque?'':'none';
   }
   row.querySelectorAll<HTMLButtonElement>('[data-settle-method-btn]').forEach(btn=>{
     const on=btn.dataset.settleMethodBtn===method;
     btn.classList.toggle('is-active',on);
     btn.setAttribute('aria-pressed',on?'true':'false');
   });
   if(isCheque){
     row.querySelectorAll<HTMLInputElement>('[data-settle-cheque-due]').forEach(inp=>{
       delete inp.dataset.calendarEnhanced;
       attachJalaliCalendar(inp);
     });
   }
 };
 const bind=(row:HTMLElement)=>{
   toggleChequeFields(row);
   row.querySelectorAll<HTMLButtonElement>('[data-settle-method-btn]').forEach(btn=>{
     btn.addEventListener('click',()=>{
       const method=btn.dataset.settleMethodBtn||'cash';
       const sel=row.querySelector<HTMLSelectElement>('[data-settle-method]');
       if(sel) sel.value=method;
       toggleChequeFields(row);
       update();
     });
   });
   row.querySelector<HTMLSelectElement>('[data-settle-method]')?.addEventListener('change',()=>{toggleChequeFields(row);update();});
   const amountInp=row.querySelector<HTMLInputElement>('[data-settle-amount]');
   amountInp?.addEventListener('input',()=>{
     amountInp.dataset.autoRemaining='0';
     update();
     const rows=[...host.querySelectorAll<HTMLElement>('.settlement-payment-row')];
     // هم‌تراز کردن آخرین مرحله auto با مانده
     if(rows.length>1){
       const last=rows[rows.length-1];
       const lastInp=last.querySelector<HTMLInputElement>('[data-settle-amount]');
       if(lastInp && lastInp!==amountInp && lastInp.dataset.autoRemaining==='1'){
         let paidOthers=0;
         rows.forEach(r=>{
           const inp=r.querySelector<HTMLInputElement>('[data-settle-amount]');
           if(inp && inp!==lastInp) paidOthers+=parseMoneyToRial(digits(inp.value||'0'),currency);
         });
         const rem=Math.max(0,target.grossRial-paidOthers);
         lastInp.value=rem?formatMoneyFromRial(rem,currency):'';
         update();
       }
     }
   });
   amountInp?.addEventListener('focus',()=>{
     if(!digits(amountInp.value||'').trim()){
       // مانده بدون این فیلد
       let paidOthers=0;
       host.querySelectorAll<HTMLInputElement>('[data-settle-amount]').forEach(inp=>{
         if(inp!==amountInp) paidOthers+=parseMoneyToRial(digits(inp.value||'0'),currency);
       });
       const rem=Math.max(0,target.grossRial-paidOthers);
       if(rem>0){
         amountInp.value=formatMoneyFromRial(rem,currency);
         amountInp.dataset.autoRemaining='1';
         update();
       }
     }
   });
   row.querySelector('[data-settle-remove]')?.addEventListener('click',()=>{
     if(host.querySelectorAll('.settlement-payment-row').length<=1){
       toast('حداقل یک مرحله پرداخت لازم است.','info');
       return;
     }
     row.remove();
     update();
   });
 };
 host.querySelectorAll<HTMLElement>('.settlement-payment-row').forEach(bind);
 const add=()=>{
   const paid=sumAllAmounts();
   const rem=Math.max(0,target.grossRial-paid);
   const wrap=document.createElement('div');
   wrap.innerHTML=settlementRow(
     rem>0?{method:'cash',amountRial:rem}:{method:'cash',amountRial:0},
     {autoRemaining:rem>0}
   );
   const row=wrap.firstElementChild as HTMLElement;
   host.appendChild(row);
   bind(row);
   update();
   row.querySelector<HTMLInputElement>('[data-settle-amount]')?.focus();
 };
 overlay.querySelector('#settlementAdd')!.addEventListener('click',add);
 const closeSettlement=async()=>{
   overlay.remove();
   if(document.getElementById('commercePanelSheet') && (activeCommerceSection==='sale'||activeCommerceSection==='purchase')){
     try{ await openCommercePanelSheet(activeCommerceSection); }catch{}
   }
 };
 overlay.querySelector('#settlementBack')!.addEventListener('click',()=>{void closeSettlement();});
 overlay.querySelector('#settlementCancel')!.addEventListener('click',()=>{void closeSettlement();});
 host.addEventListener('input',update);host.addEventListener('change',update);update();
 const resolveCashAccountId=async():Promise<string>=>{
   try{
     const acc=await ensureCommerceAccounts();
     const cash=acc.accounts.find(a=>a.isActive&&a.id==='det-cash')
       ||acc.accounts.find(a=>a.isActive&&a.id==='det-bank')
       ||acc.accounts.find(a=>a.isActive&&a.level==='detail'&&/صندوق|بانک|cash|bank/i.test(a.title||''));
     if(cash){
       accountOptionsCache=acc.accounts
         .filter(a=>a.isActive&&a.level==='detail'&&(a.id==='det-cash'||a.id==='det-bank'||/صندوق|بانک/i.test(a.title||'')))
         .map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
       return cash.id;
     }
   }catch(e){ console.warn('[anbarin] resolveCashAccountId', e); }
   const fromCache=accountOptionsCache.match(/value="([^"]+)"/)?.[1]||'';
   return fromCache;
 };

overlay.querySelector<HTMLButtonElement>('#settlementConfirm')!.addEventListener('click',async()=>{try{const activeCommerce=commerce;if(!activeCommerce)throw new Error('اطلاعات فاکتور در دسترس نیست.');const realParts=read().filter(x=>x.method!=='credit');const total=realParts.reduce((n,x)=>n+x.amountRial,0);if(total>target.grossRial)throw new Error('جمع دریافت/پرداخت نباید از مبلغ فاکتور بیشتر شود.');const creditAmount=Math.max(0,target.grossRial-total);const parts:InvoicePaymentPart[]=[...realParts,...(creditAmount>0?[{method:'credit' as const,amountRial:creditAmount,note:'مانده اعتباری فاکتور'}]:[])];let dueDate=digits(overlay.querySelector<HTMLInputElement>('#settlementDueDate')!.value||'');
 if(creditAmount>0&&!dueDate) dueDate=digits(target.date||'');
 if(creditAmount>0&&!dueDate)throw new Error('برای مانده اعتباری، تاریخ سررسید را مشخص کنید.');
 if(dueDate&&!/^\d{4}\/\d{2}\/\d{2}$/.test(dueDate))throw new Error('تاریخ سررسید باید به شکل سال/ماه/روز شمسی باشد.');const chequeParts=parts.filter(x=>x.method==='cheque');if(chequeParts.some(x=>!x.chequeNumber?.trim()||!x.chequeBank?.trim()||!x.chequeAccount?.trim()||!x.chequeDueDate))throw new Error('برای هر چک، شماره چک، بانک، شماره صیادی و تاریخ سررسید الزامی است.');const chequeKeys=chequeParts.map(x=>`${(x.chequeNumber||'').trim()}|${(x.chequeBank||'').trim().toLocaleLowerCase()}`);if(new Set(chequeKeys).size!==chequeKeys.length||chequeKeys.some(k=>activeCommerce.cashTransactions.some(t=>t.method==='cheque'&&t.chequeStatus!=='void'&&`${(t.chequeNumber||'').trim()}|${(t.chequeBank||'').trim().toLocaleLowerCase()}`===k)))throw new Error('شماره چک با همین بانک قبلاً ثبت شده است.');
 const cashAccountId=realParts.length?await resolveCashAccountId():'';
 if(realParts.length&&!cashAccountId)throw new Error('برای ثبت دریافت/پرداخت، ابتدا حساب صندوق یا بانک فعال تعریف کنید.');
 // ذخیره شرایط پرداخت روی پیش‌نویس قبل از قطعی‌سازی
 const latest=await loadCommerceData();
 const draft=latest.invoices.find(i=>i.id===target.id);if(!draft)throw new Error('فاکتور پیدا نشد.');
 if(draft.status!=='draft')throw new Error('این فاکتور قبلاً قطعی شده است.');
 draft.paymentParts=parts;draft.paymentTerms=invoicePaymentTermsLabel(parts);draft.dueDate=dueDate;draft.updatedAt=new Date().toISOString();
 await saveCommerceData(latest);commerce=latest;
 const result=await postInvoice(target.id,commerce);commerce=result.commerce;
 try{costingCache=await loadInventoryCostData();}catch{/* ignore */}
 for(let n=0;n<realParts.length;n++){const part=realParts[n];const period=invoicePeriodForDate(target.date);const tx=await createCashTransaction({type:(target.type==='sale'||target.type==='return-purchase')?'receipt':'payment',number:`${(target.type==='sale'||target.type==='return-purchase')?'IR':'IP'}-${target.number}-${n+1}`,date:target.date,fiscalPeriodId:period,partyId:target.partyId,cashAccountId,amountRial:part.amountRial,description:`تسویه فاکتور ${target.number} (${part.method==='cash'?'نقدی':part.method==='card'?'کارت':'چک'})`,method:part.method==='cash'?'cash':part.method==='card'?'card':'cheque',allocations:[{invoiceId:target.id,amountRial:part.amountRial}],chequeNumber:part.chequeNumber,chequeBank:part.chequeBank,chequeAccount:part.chequeAccount,chequeNote:part.note,chequeDueDate:part.chequeDueDate},commerce);commerce=tx.commerce;}
 await saveCommerceData(commerce);overlay.remove();await render();refreshAccounting();toast('دریافت / پرداخت در برگه مستقل ثبت شد و به فاکتور بازگشتید.','success');
 }catch(e){toast(e instanceof Error?e.message:'خطا در ثبت دریافت / پرداخت','error');}});
}

/** تعداد واردشده در ردیف را به واحد پایه تبدیل می‌کند (برای موجودی و COGS) */
function lineEnteredQty(row:HTMLElement):number{
  return Number(digits(row.querySelector<HTMLInputElement>('[data-line-qty]')?.value||'0').replace(',','.'))||0;
}
function lineUnitFactor(row:HTMLElement):number{
  const productId=row.querySelector<HTMLInputElement>('[data-line-product]')?.value||'';
  const product=products.find(p=>p.id===productId);
  const fromProduct=Math.max(1,Number(product?.unitFactor)||0);
  const fromRow=Math.max(1,Number(row.querySelector<HTMLInputElement>('[data-line-unit-factor]')?.value)||1);
  return fromProduct>1?fromProduct:fromRow;
}
function lineBaseQty(row:HTMLElement):number{
  const q=lineEnteredQty(row);
  const mode=row.querySelector<HTMLSelectElement>('[data-line-unit-mode]')?.value;
  if(mode==='pack') return q*lineUnitFactor(row);
  return q;
}

/** برآورد بهای تمام‌شده ردیف از موجودی فعلی (میانگین واحد) — فقط نمایش داخلی */
function estimateLineCogsRial(productId:string|undefined, quantityMilli:number, warehouse?:string):{cogsRial:number; known:boolean}{
  if(!productId || quantityMilli<=0) return {cogsRial:0, known:false};
  const product=products.find(p=>p.id===productId);
  if(!product) return {cogsRial:0, known:false};
  const wh=warehouseName(warehouse||product.warehouse);
  const bal=costingCache ? getCostBalance(costingCache, productId, wh) : null;
  const unit=bal && bal.averageUnitCostRial>0 ? bal.averageUnitCostRial : 0;
  if(unit<=0) return {cogsRial:0, known:false};
  return {cogsRial:Math.round(quantityMilli*unit/1000), known:true};
}

function updateInvoiceTotals():void {
  let net=0;
  let cogsTotal=0;
  let costedRevenue=0;
  let allCostKnown=true;
  const showProfit=activeInvoiceType==='sale';
  document.querySelectorAll<HTMLElement>('.commerce-line').forEach(row=>{
    const q=lineEnteredQty(row); // تعداد بر حسب واحد انتخاب‌شده (پایه یا بسته)
    const baseQty=lineBaseQty(row); // معادل واحد پایه برای موجودی
    const price=parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-line-price]')?.value||'0'),currency);
    const discount=parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-line-discount]')?.value||'0'),currency);
    const raw=Math.round(q*price); const total=Math.max(0,raw-discount); net+=total;
    const out=row.querySelector<HTMLInputElement>('[data-line-total]'); if(out)out.value=fa(currency==='toman'?Math.round(total/10):total);
    const profitBox=row.querySelector<HTMLElement>('[data-line-profit-box]');
    if(profitBox){
      if(!showProfit){ profitBox.hidden=true; }
      else {
        profitBox.hidden=false;
        const productId=row.querySelector<HTMLInputElement>('[data-line-product]')?.value||'';
        const qtyMilli=Math.round(baseQty*1000);
        const est=estimateLineCogsRial(productId||undefined, qtyMilli);
        const cogsEl=row.querySelector<HTMLElement>('[data-line-cogs]');
        const profitEl=row.querySelector<HTMLElement>('[data-line-gross-profit]');
        const marginEl=row.querySelector<HTMLElement>('[data-line-margin]');
        if(!productId){
          if(cogsEl)cogsEl.textContent='—';
          if(profitEl)profitEl.textContent='—';
          if(marginEl)marginEl.textContent='—';
        }else if(!est.known){
          allCostKnown=false;
          if(cogsEl)cogsEl.textContent='بهای نامشخص';
          if(profitEl)profitEl.textContent='—';
          if(marginEl)marginEl.textContent='—';
        }else{
          cogsTotal+=est.cogsRial;
          costedRevenue+=total;
          const gp=total-est.cogsRial;
          const margin=total>0?(gp/total*100):0;
          if(cogsEl)cogsEl.textContent=money(est.cogsRial);
          if(profitEl)profitEl.textContent=money(gp);
          if(marginEl)marginEl.textContent=`${fa(Math.round(margin*10)/10)}٪`;
        }
      }
    }
  });
  const rate=Number(digits(el<HTMLInputElement>('#invoiceTaxRate')?.value||'0').replace(',','.'));
  if(Number.isFinite(rate)&&rate>0&&rate<=100){const taxInput=el<HTMLInputElement>('#invoiceTax');if(taxInput)taxInput.value=formatMoneyFromRial(Math.round(net*rate/100),currency);}
  const tax=parseMoneyToRial(digits(el<HTMLInputElement>('#invoiceTax')?.value||'0'),currency);
  const netOut=el<HTMLElement>('#invoiceNetPreview'); if(netOut)netOut.textContent=money(net);
  const taxOut=el<HTMLElement>('#invoiceTaxPreview'); if(taxOut)taxOut.textContent=money(tax);
  const landed =
    parseMoneyToRial(digits(el<HTMLInputElement>('#invoiceLandedFreight')?.value||'0'),currency) +
    parseMoneyToRial(digits(el<HTMLInputElement>('#invoiceLandedCustoms')?.value||'0'),currency) +
    parseMoneyToRial(digits(el<HTMLInputElement>('#invoiceLandedInsurance')?.value||'0'),currency) +
    parseMoneyToRial(digits(el<HTMLInputElement>('#invoiceLandedOther')?.value||'0'),currency);
  const landedSum=el<HTMLElement>('#invoiceLandedSummary'); if(landedSum)landedSum.textContent=money(landed);
  const landedPrev=el<HTMLElement>('#invoiceLandedTotalPreview'); if(landedPrev)landedPrev.textContent=`جمع هزینه جانبی: ${money(landed)} (به بهای موجودی اضافه می‌شود؛ در مبلغ نهایی فاکتور تأمین‌کننده لحاظ نمی‌شود)`;
  const grossOut=el<HTMLElement>('#invoiceGrossPreview'); if(grossOut)grossOut.textContent=money(net+tax);
  const profitPanel=el<HTMLElement>('#invoiceInternalProfitPanel');
  if(profitPanel){
    if(!showProfit){ profitPanel.hidden=true; }
    else {
      profitPanel.hidden=false;
      const gp=costedRevenue-cogsTotal;
      const margin=costedRevenue>0?(gp/costedRevenue*100):0;
      const cogsOut=el<HTMLElement>('#invoiceCogsPreview'); if(cogsOut)cogsOut.textContent=allCostKnown&&costedRevenue>0?money(cogsTotal):(cogsTotal>0?money(cogsTotal)+' (ناقص)':'بهای نامشخص');
      const gpOut=el<HTMLElement>('#invoiceGrossProfitPreview'); if(gpOut)gpOut.textContent=costedRevenue>0?money(gp):'—';
      const mOut=el<HTMLElement>('#invoiceMarginPreview'); if(mOut)mOut.textContent=costedRevenue>0?`${fa(Math.round(margin*10)/10)}٪`:'—';
    }
  }
  const payParts=readInvoicePaymentPartsSafe();const paid=payParts.reduce((sum,x)=>sum+x.amountRial,0);const summary=el<HTMLElement>('#invoicePaymentSummary');if(summary)summary.textContent=`جمع پرداخت‌ها: ${money(paid)} · مانده اعتباری/بدهی: ${money(Math.max(0,net+tax-paid))}`;
}
function applyInvoiceTaxRate():void {
  let net=0;
  document.querySelectorAll<HTMLElement>('.commerce-line').forEach(row=>{
    const q=Number(digits(row.querySelector<HTMLInputElement>('[data-line-qty]')?.value||'0').replace(',','.'))||0;
    const price=parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-line-price]')?.value||'0'),currency);
    const discount=parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-line-discount]')?.value||'0'),currency);
    net+=Math.max(0,Math.round(q*price)-discount);
  });
  const rate=Number(digits(el<HTMLInputElement>('#invoiceTaxRate')?.value||'0').replace(',','.'));
  if(!Number.isFinite(rate)||rate<0||rate>100){toast('نرخ مالیات باید بین صفر تا ۱۰۰ درصد باشد.','error');return;}
  const tax=Math.round(net*rate/100);
  const taxInput=el<HTMLInputElement>('#invoiceTax'); if(taxInput)taxInput.value=formatMoneyFromRial(tax,currency);
  updateInvoiceTotals();
}
function businessProfile(){
  const name=(settings.businessName||'').trim()||'فروشگاه / شرکت';
  return {
    name,
    slogan:(settings.businessSlogan||'').trim(),
    phone:(settings.businessPhone||'').trim(),
    address:(settings.businessAddress||'').trim(),
    nationalId:(settings.businessNationalId||'').trim(),
    economicCode:(settings.businessEconomicCode||'').trim(),
    postalCode:(settings.businessPostalCode||'').trim(),
    logo:(settings.businessLogoDataUrl||'').trim(),
  };
}

function buildInvoiceHtml(invoiceId:string, opts?:{internal?:boolean}):{title:string;html:string;text:string}|null {
  const invoice=commerce?.invoices.find(i=>i.id===invoiceId); if(!invoice||!commerce)return null;
  const party=commerce.parties.find(p=>p.id===invoice.partyId); if(!party)return null;
  const biz=businessProfile();
  const internal=!!opts?.internal && invoice.type==='sale';
  // برای فاکتور قطعی فروش، بهای واقعی از movement؛ برای پیش‌نویس برآورد از موجودی
  const lineProfit=invoice.lines.map(l=>{
    if(!internal || !l.productId) return {cogsRial:0, known:false as boolean};
    if(invoice.status==='posted' && costingCache){
      const mov=costingCache.movements.find(m=>m.sourceDocumentId===invoice.id&&m.productId===l.productId&&m.type==='sale');
      if(mov) return {cogsRial:Math.max(0,mov.totalCostRial), known:true};
    }
    return estimateLineCogsRial(l.productId, l.quantityMilli, l.warehouse);
  });
  let cogsSum=0, costedRev=0;
  const rows=invoice.lines.map((l,n)=>{
    const base=`<td>${n+1}</td><td>${esc(l.description)}</td><td>${fa(l.quantityMilli/1000)}</td><td>${esc(l.unit||'عدد')}</td><td>${money(l.unitPriceRial)}</td><td>${money(l.discountRial||0)}</td><td>${money(l.totalRial)}</td>`;
    if(!internal) return `<tr>${base}</tr>`;
    const p=lineProfit[n];
    if(p.known){ cogsSum+=p.cogsRial; costedRev+=l.totalRial; }
    const gp=p.known?l.totalRial-p.cogsRial:null;
    const margin=p.known&&l.totalRial>0?`${fa(Math.round((gp!/l.totalRial)*1000)/10)}٪`:'—';
    return `<tr>${base}<td>${p.known?money(p.cogsRial):'نامشخص'}</td><td>${gp!==null?money(gp):'—'}</td><td>${margin}</td></tr>`;
  }).join('');
  const paymentLines=(invoice.paymentParts||[]).map(x=>{
    const label=x.method==='cash'?'نقدی':x.method==='card'?'کارت':x.method==='cheque'?`چک ${x.chequeNumber||''} · ${x.chequeBank||''} · شناسه ${x.chequeAccount||'—'} · سررسید ${x.chequeDueDate||''}`:'اعتباری (مانده حساب)';
    return `${label}: ${money(x.amountRial)}`;
  });
  const title=`فاکتور ${invoiceTypeTitle(invoice.type)} ${invoice.number}${internal?' (داخلی)':''}`;
  const gpTotal=costedRev-cogsSum;
  const marginTotal=costedRev>0?Math.round((gpTotal/costedRev)*1000)/10:0;
  const textLines=[
    biz.name,
    biz.phone?`تلفن: ${biz.phone}`:'',
    biz.address?`آدرس: ${biz.address}`:'',
    title,
    internal?'*** نسخه داخلی / مدیریتی — محرمانه ***':'',
    `تاریخ: ${invoice.date}`,
    `وضعیت: ${invoice.status==='posted'?'قطعی':'پیش‌نویس'}`,
    `${isSaleInvoiceType(invoice.type)?'خریدار':'فروشنده'}: ${party.name}`,
    party.phone?`تلفن: ${party.phone}`:'',
    '',
    'اقلام:',
    ...invoice.lines.map((l,n)=>{
      const p=lineProfit[n];
      const extra=internal?(p.known?` | بهای ${money(p.cogsRial)} | سود ${money(l.totalRial-p.cogsRial)}`:' | بهای نامشخص'):'';
      return `${n+1}) ${l.description} | ${fa(l.quantityMilli/1000)} ${l.unit||'عدد'} | ${money(l.unitPriceRial)} | مبلغ ${money(l.totalRial)}${extra}`;
    }),
    '',
    `جمع: ${money(invoice.netRial)}`,
    `مالیات: ${money(invoice.taxRial)}`,
    `مبلغ نهایی: ${money(invoice.grossRial)}`,
    ...(internal?[
      `بهای تمام‌شده (داخلی): ${costedRev>0?money(cogsSum):'نامشخص'}`,
      `سود ناخالص (داخلی): ${costedRev>0?money(gpTotal):'—'}`,
      `حاشیه سود: ${costedRev>0?fa(marginTotal)+'٪':'—'}`,
    ]:[]),
    invoice.paymentTerms?`شرایط پرداخت: ${invoice.paymentTerms}`:'',
    invoice.dueDate?`سررسید: ${invoice.dueDate}`:'',
    ...paymentLines,
    invoice.notes?`توضیحات: ${invoice.notes}`:'',
    '',
    'ارسال‌شده از انبارین پرو',
  ].filter(x=>x!==undefined) as string[];
  const logoHtml=biz.logo?`<img class="logo" src="${biz.logo.replace(/"/g,'')}" alt="لوگو" />`:'';
  const bizIds=[
    biz.nationalId?`شناسه/ملی: ${esc(biz.nationalId)}`:'',
    biz.economicCode?`اقتصادی: ${esc(biz.economicCode)}`:'',
    biz.postalCode?`کدپستی: ${esc(biz.postalCode)}`:'',
  ].filter(Boolean).join(' · ');
  const html=`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box}
body{font-family:Tahoma,"Segoe UI",Arial,sans-serif;color:#0f172a;margin:16px;font-size:12.5px;line-height:1.55;background:#fff}
.sheet{max-width:900px;margin:0 auto;border:1px solid #dbe3ee;border-radius:12px;overflow:hidden}
.brand{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:linear-gradient(135deg,#0f766e 0%,#115e59 55%,#134e4a 100%);color:#fff}
.brand-main{display:flex;align-items:center;gap:12px;min-width:0}
.logo{max-height:52px;max-width:110px;object-fit:contain;background:#fff;border-radius:8px;padding:4px}
.brand h1{margin:0;font-size:18px;font-weight:800}
.brand .slogan{margin:2px 0 0;font-size:11px;opacity:.92}
.brand .doc-type{text-align:left;font-size:13px;font-weight:700;white-space:nowrap}
.brand-meta{padding:8px 16px;background:#f0fdfa;border-bottom:1px solid #cce7e2;color:#115e59;font-size:11px}
.brand-meta span{margin-left:12px}
.body{padding:14px 16px}
.head{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 8px}.party-panel{min-width:0}.party-panel p{overflow-wrap:anywhere}.invoice-meta{margin-bottom:12px}
.panel{border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;background:#fafbfc}
.panel b{display:block;margin-bottom:6px;color:#0f766e}
.panel p{margin:3px 0}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.meta div{padding:7px 8px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px}
.meta span{display:block;font-size:10px;color:#64748b}
table{width:100%;border-collapse:collapse;margin:4px 0 12px}
th,td{border:1px solid #e2e8f0;padding:7px 8px;text-align:right}
th{background:#ecfdf5;color:#115e59;font-size:11px}
tbody tr:nth-child(even){background:#f8fafc}
.sum{max-width:360px;margin-right:auto;margin-top:4px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
.sum div{display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #eef2f7}
.sum div:last-child{border-bottom:0;background:#ecfdf5;font-weight:800;color:#0f766e}
.note{white-space:pre-wrap;border:1px dashed #cbd5e1;padding:10px;margin-top:12px;border-radius:8px;background:#fcfcfd}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:36px;text-align:center}
.sign div{border-top:1px solid #94a3b8;padding-top:8px;color:#475569}
.footer{margin-top:16px;text-align:center;color:#94a3b8;font-size:10px}
.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin:18px 0}
.actions button{padding:10px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#f8fafc;font:inherit;cursor:pointer}
.actions button.primary{background:#0f766e;color:#fff;border-color:#0f766e}
@media print{body{margin:8mm}.sheet{border:none;border-radius:0}.noprint{display:none!important}}
@media(max-width:640px){.head,.meta,.sign{grid-template-columns:1fr}.brand{flex-direction:column;align-items:flex-start}}
</style></head><body>
<div class="sheet">
  <div class="brand">
    <div class="brand-main">${logoHtml}<div><h1>${esc(biz.name)}</h1>${biz.slogan?`<div class="slogan">${esc(biz.slogan)}</div>`:''}</div></div>
    <div class="doc-type">فاکتور ${esc(invoiceTypeTitle(invoice.type))}</div>
  </div>
  <div class="brand-meta">
    ${biz.phone?`<span>☎ ${esc(biz.phone)}</span>`:''}
    ${biz.address?`<span>📍 ${esc(biz.address)}</span>`:''}
    ${bizIds?`<span>${bizIds}</span>`:''}
  </div>
  <div class="body">
<div class="head">
  <div class="panel party-panel"><b>مشخصات فروشنده</b>
    <p><strong>${esc(isSaleInvoiceType(invoice.type)?biz.name:party.name)}</strong></p>
    <p>شناسه ملی: ${esc(isSaleInvoiceType(invoice.type)?biz.nationalId||'—':party.nationalId||'—')} | کد اقتصادی: ${esc(isSaleInvoiceType(invoice.type)?biz.economicCode||'—':party.economicCode||'—')}</p>
    <p>تلفن: ${esc(isSaleInvoiceType(invoice.type)?biz.phone||'—':party.phone||'—')} | کد پستی: ${esc(isSaleInvoiceType(invoice.type)?biz.postalCode||'—':party.postalCode||'—')}</p>
    <p>نشانی: ${esc(isSaleInvoiceType(invoice.type)?biz.address||'—':party.address||'—')}</p>
  </div>
  <div class="panel party-panel"><b>مشخصات خریدار</b>
    <p><strong>${esc(isSaleInvoiceType(invoice.type)?party.name:biz.name)}</strong></p>
    <p>شناسه ملی: ${esc(isSaleInvoiceType(invoice.type)?party.nationalId||'—':biz.nationalId||'—')} | کد اقتصادی: ${esc(isSaleInvoiceType(invoice.type)?party.economicCode||'—':biz.economicCode||'—')}</p>
    <p>تلفن: ${esc(isSaleInvoiceType(invoice.type)?party.phone||'—':biz.phone||'—')} | کد پستی: ${esc(isSaleInvoiceType(invoice.type)?party.postalCode||'—':biz.postalCode||'—')}</p>
    <p>نشانی: ${esc(isSaleInvoiceType(invoice.type)?party.address||'—':biz.address||'—')}</p>
  </div>
</div>
<div class="meta invoice-meta">
  <div><span>شماره فاکتور</span><b>${esc(invoice.number)}</b></div>
  <div><span>تاریخ</span><b>${esc(invoice.date)}</b></div>
  <div><span>نوع</span><b>${esc(invoiceTypeTitle(invoice.type))}</b></div>
  <div><span>وضعیت</span><b>${invoice.status==='posted'?'قطعی':'پیش‌نویس'}</b></div>
</div>
${internal?`<div style="background:#fff3cd;border:1px solid #f0c36d;padding:8px 12px;margin:0 0 12px;border-radius:8px;font-weight:700">نسخه داخلی / مدیریتی — شامل سود ناخالص — برای مشتری چاپ نشود</div>`:''}
<table><thead><tr><th>ردیف</th><th>شرح کالا / خدمت</th><th>تعداد</th><th>واحد</th><th>قیمت واحد</th><th>تخفیف</th><th>مبلغ</th>${internal?'<th>بهای</th><th>سود ناخالص</th><th>حاشیه</th>':''}</tr></thead><tbody>${rows}</tbody></table>
<div class="sum">
  <div><span>جمع پس از تخفیف</span><b>${money(invoice.netRial)}</b></div>
  <div><span>مالیات (${fa((invoice.taxRateBps||0)/100)}٪)</span><b>${money(invoice.taxRial)}</b></div>
  <div><span>مبلغ نهایی</span><b>${money(invoice.grossRial)}</b></div>
  ${internal?`<div><span>بهای تمام‌شده (داخلی)</span><b>${costedRev>0?money(cogsSum):'نامشخص'}</b></div>
  <div><span>سود ناخالص (داخلی)</span><b>${costedRev>0?money(gpTotal):'—'}</b></div>
  <div><span>حاشیه سود</span><b>${costedRev>0?fa(marginTotal)+'٪':'—'}</b></div>`:''}
</div>
<p>شرح: ${esc(invoice.description||'—')}</p>
<div class="panel" style="margin-top:12px"><b>شرایط پرداخت</b>
  <p>${esc(invoice.paymentTerms||'—')}</p>
  ${invoice.dueDate?`<p>سررسید: ${esc(invoice.dueDate)}</p>`:''}
  ${(invoice.paymentParts||[]).length?`<ul>${invoice.paymentParts!.map(x=>`<li>${x.method==='cash'?'نقدی':x.method==='card'?'کارت':x.method==='cheque'?`چک ${esc(x.chequeNumber||'')} · ${esc(x.chequeBank||'')} · شناسه ${esc(x.chequeAccount||'—')} · سررسید ${esc(x.chequeDueDate||'')}`:'اعتباری'}: ${money(x.amountRial)}</li>`).join('')}</ul>`:''}
</div>
<div class="note">توضیحات: ${esc(invoice.notes||'—')}</div>
<div class="sign"><div>امضا و مهر ${isSaleInvoiceType(invoice.type)?'فروشنده':'خریدار'}</div><div>امضا و مهر ${isSaleInvoiceType(invoice.type)?'خریدار':'فروشنده'}</div></div>
<div class="footer">صادر شده توسط ${esc(biz.name)} · انبارین پرو</div>
</div></div>
<div class="actions noprint">
  <button class="primary" type="button" onclick="window.print()">چاپ</button>
  <button type="button" onclick="window.close()">بستن</button>
</div>
</body></html>`;
  return {title,html,text:textLines.filter(Boolean).join('\n')};
}

/** فاکتور فشرده مخصوص رول ۸۰mm / ۸ سانتی‌متر */
function buildInvoiceHtml80(invoiceId:string):{title:string;html:string;text:string}|null {
  const invoice=commerce?.invoices.find(i=>i.id===invoiceId); if(!invoice||!commerce)return null;
  const party=commerce.parties.find(p=>p.id===invoice.partyId); if(!party)return null;
  const biz=businessProfile();
  const title=`فاکتور ${invoiceTypeTitle(invoice.type)} ${invoice.number}`;
  const lineBlocks=invoice.lines.map((l,n)=>`
    <div class="item">
      <div class="item-top"><b>${n+1}. ${esc(l.description)}</b></div>
      <div class="item-row"><span>${fa(l.quantityMilli/1000)} ${esc(l.unit||'عدد')}</span><span>× ${money(l.unitPriceRial)}</span></div>
      ${(l.discountRial||0)>0?`<div class="item-row muted"><span>تخفیف</span><span>${money(l.discountRial||0)}</span></div>`:''}
      <div class="item-row total-line"><span>مبلغ</span><b>${money(l.totalRial)}</b></div>
    </div>`).join('');
  const payLines=(invoice.paymentParts||[]).map(x=>{
    const label=x.method==='cash'?'نقدی':x.method==='card'?'کارت':x.method==='cheque'?`چک ${x.chequeNumber||''}`:'اعتباری';
    return `<div class="item-row"><span>${esc(label)}</span><span>${money(x.amountRial)}</span></div>`;
  }).join('');
  const logoHtml=biz.logo?`<img src="${biz.logo.replace(/"/g,'')}" alt="" style="max-height:28px;max-width:60px;display:block;margin:0 auto 4px" />`:'';
  const html=`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
@page{size:80mm auto;margin:2mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Tahoma,Arial,sans-serif;direction:rtl}
body{width:76mm;max-width:76mm;padding:2mm;font-size:11px;line-height:1.45}
h1{font-size:13px;text-align:center;margin:0 0 2px;font-weight:800}
.sub{text-align:center;font-size:10px;margin:0 0 4px;color:#333}
.hr{border:0;border-top:1px dashed #000;margin:6px 0}
.meta div{display:flex;justify-content:space-between;gap:4px;margin:2px 0}
.parties{display:grid;grid-template-columns:1fr;gap:4px;margin:5px 0}.parties>div{border:1px solid #999;padding:4px;min-width:0;overflow-wrap:anywhere}.parties b,.parties strong,.parties small{display:block}.parties b{font-size:10px}.parties strong{font-size:10px}.parties small{font-size:8px}
.meta b{font-weight:700}
.item{margin:6px 0;padding-bottom:4px;border-bottom:1px dotted #999}
.item-top{margin-bottom:2px}
.item-row{display:flex;justify-content:space-between;gap:6px;font-size:10px}
.item-row.total-line{margin-top:2px}
.muted{color:#444}
.sum{margin-top:6px}
.sum .item-row{font-size:11px;margin:3px 0}
.sum .grand{font-size:13px;font-weight:800;border-top:1px solid #000;padding-top:4px;margin-top:4px}
.foot{text-align:center;font-size:9px;margin-top:8px;color:#333}
</style></head><body>
${logoHtml}
<h1>${esc(biz.name)}</h1>
<div class="sub">فاکتور ${esc(invoiceTypeTitle(invoice.type))}${biz.phone?` · ${esc(biz.phone)}`:''}</div>
${biz.address?`<div class="sub">${esc(biz.address)}</div>`:''}
<div class="hr"></div>
<div class="meta">
  <div><span>شماره</span><b>${esc(invoice.number)}</b></div>
  <div><span>تاریخ</span><b>${esc(invoice.date)}</b></div>
  <div><span>وضعیت</span><b>${invoice.status==='posted'?'قطعی':'پیش‌نویس'}</b></div>
</div>
<div class="parties">
  <div><b>فروشنده</b><strong>${esc(isSaleInvoiceType(invoice.type)?biz.name:party.name)}</strong>
  <small>${esc(isSaleInvoiceType(invoice.type)?biz.phone:party.phone)}${(isSaleInvoiceType(invoice.type)?biz.nationalId:party.nationalId)?' · شناسه '+esc(isSaleInvoiceType(invoice.type)?biz.nationalId:party.nationalId):''}</small>
  <small>${esc(isSaleInvoiceType(invoice.type)?biz.address:party.address)}</small>
  <small>${(isSaleInvoiceType(invoice.type)?biz.economicCode:party.economicCode)?'کد اقتصادی: '+esc(String((isSaleInvoiceType(invoice.type)?biz.economicCode:party.economicCode) ?? '')):''}${(isSaleInvoiceType(invoice.type)?biz.postalCode:party.postalCode)?' · کدپستی: '+esc(String((isSaleInvoiceType(invoice.type)?biz.postalCode:party.postalCode) ?? '')):''}</small></div>
  <div><b>خریدار</b><strong>${esc(isSaleInvoiceType(invoice.type)?party.name:biz.name)}</strong>
  <small>${esc(isSaleInvoiceType(invoice.type)?party.phone:biz.phone)}${(isSaleInvoiceType(invoice.type)?party.nationalId:biz.nationalId)?' · شناسه '+esc(isSaleInvoiceType(invoice.type)?party.nationalId:biz.nationalId):''}</small>
  <small>${esc(isSaleInvoiceType(invoice.type)?party.address:biz.address)}</small>
  <small>${(isSaleInvoiceType(invoice.type)?party.economicCode:biz.economicCode)?'کد اقتصادی: '+esc(String((isSaleInvoiceType(invoice.type)?party.economicCode:biz.economicCode) ?? '')):''}${(isSaleInvoiceType(invoice.type)?party.postalCode:biz.postalCode)?' · کدپستی: '+esc(String((isSaleInvoiceType(invoice.type)?party.postalCode:biz.postalCode) ?? '')):''}</small></div>
</div>
<div class="hr"></div>
${lineBlocks||'<div class="muted">بدون قلم</div>'}
<div class="hr"></div>
<div class="sum">
  <div class="item-row"><span>جمع پس از تخفیف</span><span>${money(invoice.netRial)}</span></div>
  <div class="item-row"><span>مالیات (${fa((invoice.taxRateBps||0)/100)}٪)</span><span>${money(invoice.taxRial)}</span></div>
  <div class="item-row grand"><span>مبلغ نهایی</span><span>${money(invoice.grossRial)}</span></div>
</div>
${payLines?`<div class="hr"></div><div class="sum"><b>پرداخت</b>${payLines}</div>`:''}
${invoice.paymentTerms||invoice.dueDate?`<div class="hr"></div>${invoice.paymentTerms?`<div class="muted">شرایط: ${esc(invoice.paymentTerms)}</div>`:''}${invoice.dueDate?`<div class="muted">سررسید: ${esc(invoice.dueDate)}</div>`:''}`:''}
${invoice.description?`<div class="muted">شرح: ${esc(invoice.description)}</div>`:''}
${invoice.notes?`<div class="muted">توضیح: ${esc(invoice.notes)}</div>`:''}
<div class="foot">با تشکر از خرید شما</div>
</body></html>`;
  const textLines=[
    title,
    `تاریخ: ${invoice.date}`,
    `${isSaleInvoiceType(invoice.type)?'خریدار':'فروشنده'}: ${party.name}`,
    ...invoice.lines.map((l,n)=>`${n+1}) ${l.description} | ${fa(l.quantityMilli/1000)} | ${money(l.totalRial)}`),
    `مبلغ نهایی: ${money(invoice.grossRial)}`,
  ];
  return {title,html,text:textLines.join('\n')};
}

function resolveInvoiceForPrint():string|null{
  if(editingInvoiceId && commerce?.invoices.some(i=>i.id===editingInvoiceId)) return editingInvoiceId;
  if(lastPrintableInvoiceId && commerce?.invoices.some(i=>i.id===lastPrintableInvoiceId)) return lastPrintableInvoiceId;
  // آخرین فاکتور هم‌نوع
  const list=(commerce?.invoices||[]).filter(i=>i.type===activeInvoiceType).slice().reverse();
  return list[0]?.id||null;
}
async function printInvoice(invoiceId:string, opts?:{internal?:boolean}):Promise<void> {
  const size=await choosePaperSize({mode:'document',title:opts?.internal?'سایز چاپ داخلی':'سایز چاپ فاکتور'});
  if(!size)return;
  // رول ۸۰mm همیشه نسخه مشتری (بدون سود)
  const doc=size==='label80'?buildInvoiceHtml80(invoiceId):buildInvoiceHtml(invoiceId,{internal:!!opts?.internal});
  if(!doc){toast('فاکتور برای چاپ پیدا نشد.','error');return;}
  printHtmlSafely(doc.html, doc.title || `فاکتور-${invoiceId}`, {
    paperSize: size,
    onSuccess: () => toast(opts?.internal?'چاپ داخلی (با سود) آماده شد':(size==='label80'?'چاپ فاکتور فشرده ۸۰mm آماده شد':'پنجره چاپ باز شد؛ پس از اتمام به همین صفحه برمی‌گردید'), 'success'),
    onError: () => toast('باز کردن چاپ ناموفق بود؛ دوباره تلاش کنید', 'error'),
  });
}
async function shareInvoice(invoiceId:string):Promise<void> {
  // برای رول ۸۰mm هم نسخه کامل HTML مناسب‌تر است (خوانایی در پیام‌رسان)
  const doc=buildInvoiceHtml(invoiceId);
  if(!doc){toast('فاکتور برای اشتراک‌گذاری پیدا نشد.','error');return;}
  const safeNum=(commerce?.invoices.find(i=>i.id===invoiceId)?.number||invoiceId).replace(/[^\w\u0600-\u06FF-]+/g,'_');
  const fileName=`invoice-${safeNum}.html`;
  const mime='text/html;charset=utf-8';
  const title=doc.title || 'فاکتور انبارین';
  const textPreview=(doc.text||'').slice(0,800);

  // ۱) شیت بومی اندروید / Web Share با فایل
  const shareResult=await shareFileContent(doc.html,fileName,mime,{
    title,
    text: textPreview,
  });
  if(shareResult==='shared'){
    toast('فاکتور آماده ارسال است؛ پیام‌رسان یا Drive را انتخاب کنید','success');
    return;
  }
  if(shareResult==='cancelled')return;

  // ۲) کپی متن برای Paste دستی در پیام‌رسان
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(doc.text);
      toast('متن فاکتور کپی شد؛ در پیام‌رسان Paste کنید','success');
      return;
    }
  }catch{ /* ادامه */ }

  // ۳) ذخیره فایل روی دستگاه
  const saved=await downloadFile(doc.html,fileName,mime);
  if(saved==='saved'){
    toast('فایل فاکتور در دستگاه ذخیره شد','success');
    return;
  }
  if(saved==='cancelled')return;
  toast('اشتراک‌گذاری در این دستگاه پشتیبانی نشد','error');
}

async function bankPanel():Promise<string>{
  const [balances,recon,accData,reconSum]=await Promise.all([
    getBankAccountBalances(),loadBankReconciliation(),loadAccountingData(),getBankReconciliationSummary()
  ]);
  const opts=balances.map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
  const feeOpts=accData.accounts.filter(a=>a.isActive&&a.level==='detail'&&(a.code.startsWith('6')||/(هزینه|کارمزد)/.test(a.title)))
    .map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
  const txs=(commerce?.cashTransactions||[]).slice().reverse();
  const partyName=(id?:string)=>esc(commerce?.parties.find(p=>p.id===id)?.name||'—');
  const chequeSt=(s?:string)=>s==='pending'?'در جریان':s==='cleared'?'وصول':s==='bounced'?'برگشتی':s==='void'?'باطل':(s||'—');
  const recvCheques=txs.filter(t=>t.method==='cheque'&&t.type==='receipt');
  const payCheques=txs.filter(t=>t.method==='cheque'&&t.type==='payment');
  const defaultLedgerId=balances[0]?.id||'';
  const ledger=defaultLedgerId?await getBankAccountLedger(defaultLedgerId):[];
  const ledgerRows=ledger.slice(-80).reverse().map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.number)}</td><td>${esc(r.description)}</td><td>${money(r.debitRial)}</td><td>${money(r.creditRial)}</td><td>${money(r.balanceRial)}</td></tr>`).join('')
    ||'<tr><td colspan="6">گردشی برای این حساب ثبت نشده است.</td></tr>';
  const reconRows=recon.rows.slice().reverse().slice(0,100).map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.reference||'—')}</td><td>${esc(r.description)}</td><td>${money(Math.abs(r.amountRial))} ${r.amountRial>0?'واریز':'برداشت'}</td><td>${r.matched?'تطبیق‌شده':'تطبیق‌نشده'}</td></tr>`).join('')
    ||'<tr><td colspan="5">صورت‌حساب بانکی وارد نشده است.</td></tr>';
  const chequeRow=(t:typeof txs[0],showActions:boolean)=>{
    const pending=t.chequeStatus==='pending';
    const actions=showActions&&pending
      ?`<button type="button" class="btn btn-sm btn-primary" data-cheque-clear="${t.id}">وصول</button> <button type="button" class="btn btn-sm btn-secondary" data-cheque-bounce="${t.id}">برگشت</button>`
      :chequeSt(t.chequeStatus);
    return `<tr><td>${esc(t.date)}</td><td>${esc(t.number)}</td><td>${partyName(t.partyId)}</td><td>${money(t.amountRial)}</td><td>${esc(t.chequeNumber||'—')}</td><td>${esc(t.chequeDueDate||'—')}</td><td>${actions}</td></tr>`;
  };
  const totalBalance=balances.reduce((s,a)=>s+a.balanceRial,0);
  return `<div class="card bank-panel-card" dir="rtl">
<h3>بانک و صندوق</h3>
<p class="hint">زیرمجموعه‌های استاندارد: مانده حساب‌ها، دفتر بانک، واریز/برداشت، انتقال، کارمزد، چک و مغایرت‌گیری صورت‌حساب.</p>
<div class="form-grid" style="margin:12px 0">
  <div class="stat-card"><b>${money(totalBalance)}</b><span>جمع مانده نقد و بانک</span></div>
  <div class="stat-card"><b>${fa(reconSum.matched)} / ${fa(reconSum.totalRows)}</b><span>ردیف‌های تطبیق‌شده صورت‌حساب</span></div>
  <div class="stat-card"><b>${money(reconSum.unmatchedBankRial)}</b><span>مانده ردیف‌های تطبیق‌نشده</span></div>
</div>
<div class="table-wrap"><table class="data-table"><thead><tr><th>کد</th><th>حساب</th><th>مانده دفتری</th></tr></thead><tbody>${balances.map(a=>`<tr><td>${esc(a.code)}</td><td>${esc(a.title)}</td><td>${money(a.balanceRial)}</td></tr>`).join('')||'<tr><td colspan="3">حساب صندوق/بانک تعریف نشده</td></tr>'}</tbody></table></div>

<details class="card bank-sub" open><summary>۱) دفتر بانک / صندوق</summary>
<p class="hint">گردش از اسناد حسابداری قطعی حساب انتخاب‌شده.</p>
<div class="form-grid bank-entry-grid">
<label class="field">حساب<select id="bankLedgerAccount">${opts}</select></label>
<button type="button" class="btn btn-secondary" id="bankLedgerLoad">نمایش گردش</button>
</div>
<div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr><th>تاریخ</th><th>شماره سند</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead><tbody id="bankLedgerBody">${ledgerRows}</tbody></table></div>
</details>

<details class="card bank-sub"><summary>۲) واریز نقد به بانک / برداشت به صندوق</summary>
<p class="hint">جابه‌جایی وجه بین صندوق و بانک با صدور سند حسابداری.</p>
<div class="form-grid bank-entry-grid">
<label class="field">نوع<select id="bankMoveKind"><option value="deposit">واریز نقد به بانک</option><option value="withdraw">برداشت از بانک به صندوق</option></select></label>
<label class="field">شماره<input id="bankMoveNo" placeholder="خودکار یا دستی"></label>
<label class="field">تاریخ<input id="bankMoveDate" placeholder="1405/01/01" value="${todayJalali()}"></label>
<label class="field">صندوق / تنخواه<select id="bankMoveCash">${opts}</select></label>
<label class="field">بانک<select id="bankMoveBank">${opts}</select></label>
<label class="field">مبلغ<input id="bankMoveAmount" inputmode="numeric" placeholder="۰"></label>
<label class="field" style="grid-column:1/-1">شرح<input id="bankMoveDesc" placeholder="اختیاری"></label>
</div>
<button type="button" class="btn btn-primary" id="bankMoveSave">ثبت واریز / برداشت</button>
</details>

<details class="card bank-sub"><summary>۳) انتقال بین حساب‌ها</summary>
<div class="form-grid bank-entry-grid">
<label class="field">شماره<input id="bankTransferNo"></label>
<label class="field">تاریخ<input id="bankTransferDate" placeholder="1405/01/01" value="${todayJalali()}"></label>
<label class="field">از حساب<select id="bankTransferFrom">${opts}</select></label>
<label class="field">به حساب<select id="bankTransferTo">${opts}</select></label>
<label class="field">مبلغ<input id="bankTransferAmount" inputmode="numeric" placeholder="۰"></label>
<label class="field">کارمزد<input id="bankTransferFee" inputmode="numeric" value="0"></label>
<label class="field">حساب کارمزد<select id="bankTransferFeeAccount"><option value="">اختیاری</option>${feeOpts}</select></label>
<input type="hidden" id="bankTransferDescription" value="">
</div>
<button class="btn btn-primary" id="bankTransferSave" type="button">ثبت انتقال</button>
</details>

<details class="card bank-sub"><summary>۴) کارمزد بانکی</summary>
<p class="hint">ثبت کارمزد مستقل (خدمات بانکی، دسته چک و …).</p>
<div class="form-grid bank-entry-grid">
<label class="field">شماره<input id="bankFeeNo"></label>
<label class="field">تاریخ<input id="bankFeeDate" placeholder="1405/01/01" value="${todayJalali()}"></label>
<label class="field">حساب بانک<select id="bankFeeBank">${opts}</select></label>
<label class="field">حساب هزینه کارمزد<select id="bankFeeExpense"><option value="">انتخاب</option>${feeOpts}</select></label>
<label class="field">مبلغ<input id="bankFeeAmount" inputmode="numeric" placeholder="۰"></label>
<label class="field" style="grid-column:1/-1">شرح<input id="bankFeeDesc" placeholder="کارمزد خدمات بانکی"></label>
</div>
<button type="button" class="btn btn-primary" id="bankFeeSave">ثبت کارمزد</button>
</details>

<details class="card bank-sub"><summary>۵) چک‌های دریافتی (وصول)</summary>
<div class="table-wrap"><table class="data-table"><thead><tr><th>تاریخ</th><th>شماره</th><th>طرف</th><th>مبلغ</th><th>شماره چک</th><th>سررسید</th><th>عملیات</th></tr></thead><tbody>${recvCheques.map(t=>chequeRow(t,true)).join('')||'<tr><td colspan="7">چک دریافتی نیست</td></tr>'}</tbody></table></div>
</details>

<details class="card bank-sub"><summary>۶) چک‌های پرداختی</summary>
<div class="table-wrap"><table class="data-table"><thead><tr><th>تاریخ</th><th>شماره</th><th>طرف</th><th>مبلغ</th><th>شماره چک</th><th>سررسید</th><th>وضعیت</th></tr></thead><tbody>${payCheques.map(t=>chequeRow(t,true)).join('')||'<tr><td colspan="7">چک پرداختی نیست</td></tr>'}</tbody></table></div>
</details>

<details class="card bank-sub"><summary>۷) مغایرت‌گیری صورت‌حساب بانکی</summary>
<p class="hint">ورود فایل CSV بانک (ستون‌ها: date, description, reference, amount, balance) و تطبیق خودکار با دریافت/پرداخت‌ها.</p>
<div class="form-grid" style="margin:8px 0">
  <div class="stat-card"><b>${fa(reconSum.totalRows)}</b><span>کل ردیف‌ها</span></div>
  <div class="stat-card"><b>${fa(reconSum.matched)}</b><span>تطبیق‌شده</span></div>
  <div class="stat-card"><b>${fa(reconSum.unmatched)}</b><span>تطبیق‌نشده</span></div>
  <div class="stat-card"><b>${money(reconSum.bookBalanceRial)}</b><span>مانده دفتری</span></div>
</div>
<div class="form-grid bank-entry-grid">
<label class="field">حساب بانک<select id="bankStatementAccount">${opts}</select></label>
<label class="field">فایل CSV<input id="bankStatementFile" type="file" accept=".csv,text/csv"></label>
</div>
<button class="btn btn-secondary" id="bankStatementImport" type="button">ورود و تطبیق خودکار</button>
<div class="table-wrap" style="margin-top:12px"><table class="data-table"><thead><tr><th>تاریخ</th><th>پیگیری</th><th>شرح</th><th>مبلغ</th><th>وضعیت</th></tr></thead><tbody>${reconRows}</tbody></table></div>
</details>
</div>`;
}
async function chequePanel():Promise<string>{
  const all=(commerce?.cashTransactions||[]).filter(t=>t.method==='cheque').slice().reverse();
  const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const today=`${parts.find(x=>x.type==='year')?.value}/${parts.find(x=>x.type==='month')?.value}/${parts.find(x=>x.type==='day')?.value}`;
  const dash=await getChequeDashboard(today);
  const rows=all.map(t=>{const party=commerce?.parties.find(p=>p.id===t.partyId);const endorsements=getChequeEndorsements(t.id,commerce!);const endorsement=endorsements[0];const holder=endorsement?commerce?.parties.find(p=>p.id===endorsement.toPartyId):undefined;const remaining=getChequeEndorsementRemaining(t.id,commerce!);const holderNames=endorsements.map(e=>commerce?.parties.find(p=>p.id===e.toPartyId)?.name||'ذی‌نفع').join('، ');const status=t.chequeStatus==='pending'?(endorsement?'واگذار شده به '+holderNames:'در جریان'):t.chequeStatus==='cleared'?'وصول/تسویه‌شده':t.chequeStatus==='bounced'?'برگشتی':'باطل';const actions=t.chequeStatus==='pending'?`<button class="btn btn-sm btn-secondary" data-chq-extend="${t.id}">تمدید سررسید</button> <button class="btn btn-sm btn-secondary" data-chq-replace="${t.id}">جایگزینی چک</button> ${t.type==='receipt'&&remaining>0?`<button class="btn btn-sm btn-primary" data-chq-endorse="${t.id}">ظهرنویسی به تأمین‌کننده · واگذاری بخشی از چک (${money(remaining)} مانده)</button>`:''} ${t.type==='receipt'&&!endorsement?`<button class="btn btn-sm btn-secondary" data-chq-deposit="${t.id}">واگذاری به بانک</button>`:''}`:'—';return `<tr><td>${esc(t.chequeNumber||'—')}</td><td>${esc(t.chequeBank||'—')}</td><td>${esc(party?.name||'—')}${endorsement?`<br><small>ذی‌نفعان: ${esc(holderNames)} · واگذارشده: ${money(t.amountRial-remaining)}</small>`:''}</td><td>${esc(t.chequeDueDate||'—')}</td><td>${money(t.amountRial)}</td><td>${status}</td><td>${actions}</td></tr>`}).join('')||'<tr><td colspan="7">چکی ثبت نشده است.</td></tr>';
  const book=await loadChequeBook();const events=book.events.slice().reverse().slice(0,30).map(e=>`<tr><td>${esc(e.date)}</td><td>${esc(e.type==='extended'?'تمدید سررسید':e.type==='replaced'?'جایگزینی':e.type==='deposited'?'واگذاری به بانک':e.type==='bounced_note'?'یادداشت برگشت':e.type==='cleared_note'?'یادداشت وصول':'یادداشت ابطال')}</td><td>${esc(e.note)}</td><td>${esc(e.oldValue||'—')}</td><td>${esc(e.newValue||'—')}</td></tr>`).join('')||'<tr><td colspan="5">رویدادی ثبت نشده است.</td></tr>';
  const chain=await loadChequeChain();const outcomeData=await loadChequeOutcomes();const chainRows=(commerce?.chequeEndorsements||[]).flatMap(e=>{const tx=commerce!.cashTransactions.find(t=>t.id===e.transactionId);const transfers=chain.transfers.filter(t=>t.endorsementId===e.id);const nodes=[{id:undefined as string|undefined,holderId:e.toPartyId,amount:e.amountRial,label:'دارنده اولیه پس از ظهرنویسی',parent:undefined as string|undefined},...transfers.map(t=>({id:t.id,holderId:t.toPartyId,amount:t.amountRial,label:`انتقال از ${commerce!.parties.find(p=>p.id===t.fromPartyId)?.name||'—'}`,parent:t.id}))];return nodes.map(n=>{const available=Math.max(0,getChainAvailable(e.id,commerce!,chain,n.parent)-outcomeData.outcomes.filter(x=>x.endorsementId===e.id&&x.parentTransferId===n.parent).reduce((sum,x)=>sum+x.amountRial,0));const outcomeAvailable=getOutcomeAvailable(e.id,n.parent,commerce!,chain,outcomeData);const holder=commerce!.parties.find(p=>p.id===n.holderId);const transferAction=available>0?`<button class="btn btn-sm btn-secondary" data-chain-endorsement="${e.id}" data-chain-parent="${n.id||''}" data-chain-from="${n.holderId}" data-chain-available="${available}">انتقال به ذی‌نفع بعدی</button>`:'';const outcomeAction=outcomeAvailable>0?`<button class="btn btn-sm btn-primary" data-chain-outcome="${e.id}" data-outcome-parent="${n.id||''}" data-outcome-holder="${n.holderId}" data-outcome-available="${outcomeAvailable}">ثبت وصول / برگشت / اختلاف</button>`:'';return `<tr><td>${esc(tx?.chequeNumber||tx?.number||'—')}</td><td>${esc(holder?.name||'—')}</td><td>${esc(n.label)}</td><td>${money(n.amount)}</td><td>${money(outcomeAvailable)}</td><td>${transferAction} ${outcomeAction||'—'}</td></tr>`})}).join('')||'<tr><td colspan="6">هنوز انتقال زنجیره‌ای ثبت نشده است.</td></tr>';
  const outcomeReport=await getChequeOutcomeReport();const outcomeRows=outcomeReport.records.slice(0,50).map(o=>{const endorsement=(commerce?.chequeEndorsements||[]).find(e=>e.id===o.endorsementId);const tx=commerce?.cashTransactions.find(t=>t.id===endorsement?.transactionId);const holder=commerce?.parties.find(p=>p.id===o.holderPartyId);const label=o.type==='collected'?'وصول‌شده':o.type==='returned'?'برگشتی':'مورد اختلاف';return `<tr><td>${esc(o.date)}</td><td>${esc(tx?.chequeNumber||tx?.number||'—')}</td><td>${esc(holder?.name||'—')}</td><td>${label}</td><td>${money(o.amountRial)}</td><td>${esc(o.reference||'—')}</td><td>${esc(o.note||'—')}</td></tr>`}).join('')||'<tr><td colspan="7">هنوز نتیجه‌ای برای چک‌های واگذارشده ثبت نشده است.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>دفتر چک‌ها و واگذاری چندمرحله‌ای</h3><div class="form-grid"><div class="stat-card"><b>${fa(dash.pending)}</b><span>چک در جریان</span></div><div class="stat-card"><b>${fa(dash.overdue.length)}</b><span>چک سررسیدگذشته</span></div><div class="stat-card"><b>${fa(dash.dueSoon.length)}</b><span>سررسید تا ۷ روز آینده</span></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>شماره چک</th><th>بانک</th><th>طرف حساب</th><th>سررسید</th><th>مبلغ</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows}</tbody></table></div><h4>گردش زنجیره‌ای ظهرنویسی</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>شماره چک</th><th>دارنده فعلی</th><th>مرحله</th><th>مبلغ مرحله</th><th>مانده تعیین‌تکلیف</th><th>عملیات</th></tr></thead><tbody>${chainRows}</tbody></table></div><div class="form-grid"><div class="stat-card"><b>${money(outcomeReport.collectedRial)}</b><span>وصول نهایی نزد دارندگان</span></div><div class="stat-card"><b>${money(outcomeReport.returnedRial)}</b><span>چک‌های برگشتی</span></div><div class="stat-card"><b>${money(outcomeReport.disputedRial)}</b><span>مبالغ مورد اختلاف</span></div></div><h4>گزارش وصول، برگشت و اختلاف نزد دارنده نهایی</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>تاریخ</th><th>شماره چک</th><th>دارنده</th><th>نتیجه</th><th>مبلغ</th><th>مرجع</th><th>شرح</th></tr></thead><tbody>${outcomeRows}</tbody></table></div><p class="hint">انتقال‌های بعدی پس از خروج چک به‌صورت دفتر عملیاتی و زنجیره تحویل ثبت می‌شوند و سند حسابداری جدید در دفاتر شرکت ایجاد نمی‌کنند؛ ثبت ظهرنویسی اولیه شرکت همچنان سند حسابداری دارد.</p><h4>سوابق دفتر چک</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>تاریخ</th><th>رویداد</th><th>شرح</th><th>مقدار قبلی</th><th>مقدار جدید</th></tr></thead><tbody>${events}</tbody></table></div><p class="hint">ظهرنویسی چک دریافتی به تأمین‌کننده، با انتخاب فاکتور خرید قطعی و ثبت سند حسابداری انجام می‌شود. هر چک می‌تواند در چند مرحله و به مبالغ جزئی به تأمین‌کنندگان مختلف واگذار شود؛ مجموع واگذاری‌ها از مبلغ چک بیشتر نمی‌شود. انتقال‌های بعدی میان دارندگان در دفتر زنجیره‌ای ثبت می‌شوند؛ چون پس از واگذاری اولیه خارج از مالکیت شرکت هستند، سند حسابداری جدیدی در دفاتر شرکت ایجاد نمی‌کنند. پس از ظهرنویسی، وصول در حساب بانکی شرکت غیرفعال است؛ برگشت یا ابطال، سندهای مرتبط را معکوس می‌کند. واگذاری ساده به بانک همچنان فقط یادداشت عملیاتی است.</p></div>`;
}

async function agingPanel():Promise<string>{
  const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const today=`${parts.find(x=>x.type==='year')?.value}/${parts.find(x=>x.type==='month')?.value}/${parts.find(x=>x.type==='day')?.value}`;
  const d=await getAgingDashboard(today);
  const bucketLabels:Record<AgingBucket,string>={current:'سررسیدنشده', '1_30':'۱ تا ۳۰ روز', '31_60':'۳۱ تا ۶۰ روز', '61_90':'۶۱ تا ۹۰ روز', over_90:'بیش از ۹۰ روز'};
  const bucketRows=(Object.keys(bucketLabels) as AgingBucket[]).map(k=>`<tr><td>${bucketLabels[k]}</td><td>${money(d.buckets[k])}</td></tr>`).join('');
  const invoiceRows=d.invoices.slice(0,100).map(i=>`<tr><td>${esc(i.number)}</td><td>${i.type==='sale'?'مطالبه از مشتری':'بدهی به تأمین‌کننده'}</td><td>${esc(i.partyName)}</td><td>${esc(i.dueDate)}</td><td>${i.overdueDays?fa(i.overdueDays)+' روز':'—'}</td><td>${money(i.outstandingRial)}</td></tr>`).join('')||'<tr><td colspan="6">فاکتور قطعی دارای مانده وجود ندارد.</td></tr>';
  const chequeRows=[...d.overdueCheques,...d.dueSoonCheques].map(c=>`<tr><td>${esc(c.chequeNumber||c.number)}</td><td>${c.type==='receipt'?'دریافتنی':'پرداختنی'}</td><td>${esc(c.partyName)}</td><td>${esc(c.dueDate)}</td><td>${c.risk==='overdue'?`معوق · ${fa(c.overdueDays)} روز`:'سررسید تا ۷ روز'}</td><td>${money(c.amountRial)}</td></tr>`).join('')||'<tr><td colspan="6">چک معوق یا نزدیک سررسید وجود ندارد.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>داشبورد مطالبات، بدهی‌ها و ریسک سررسید</h3><p class="hint">تاریخ مبنای گزارش: ${esc(today)} · فقط فاکتورهای قطعی و مانده پس از تخصیص دریافت‌ها/پرداخت‌ها محاسبه شده‌اند.</p><div class="form-grid"><div class="stat-card"><b>${money(d.receivableRial)}</b><span>مطالبات باز از مشتریان</span></div><div class="stat-card"><b>${money(d.payableRial)}</b><span>بدهی باز به تأمین‌کنندگان</span></div><div class="stat-card"><b>${money(d.netPositionRial)}</b><span>خالص مطالبات منهای بدهی‌ها</span></div><div class="stat-card"><b>${money(d.overdueReceivableRial)}</b><span>مطالبات سررسیدگذشته</span></div><div class="stat-card"><b>${money(d.overduePayableRial)}</b><span>بدهی سررسیدگذشته</span></div><div class="stat-card"><b>${money(d.chequesReceivableRial+d.chequesPayableRial)}</b><span>چک‌های در جریان</span></div></div><h4>سن مطالبات و بدهی‌ها</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>بازه</th><th>مجموع مانده</th></tr></thead><tbody>${bucketRows}</tbody></table></div><h4>فاکتورهای دارای مانده</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>شماره</th><th>نوع</th><th>طرف حساب</th><th>سررسید</th><th>تأخیر</th><th>مانده</th></tr></thead><tbody>${invoiceRows}</tbody></table></div><h4>چک‌های معوق و نزدیک سررسید</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>شماره چک</th><th>نوع</th><th>طرف حساب</th><th>سررسید</th><th>ریسک</th><th>مبلغ</th></tr></thead><tbody>${chequeRows}</tbody></table></div><p class="hint">این داشبورد گزارش مدیریتی است و هیچ سند حسابداری، فاکتور یا وضعیت چکی را تغییر نمی‌دهد. چک‌های ظهرنویسی‌شده پس از خروج از مالکیت شرکت در گردش زنجیره‌ای مراحل قبلی گزارش می‌شوند.</p></div>`;
}

async function cashflowPanel():Promise<string>{
  const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const today=`${parts.find(x=>x.type==='year')?.value}/${parts.find(x=>x.type==='month')?.value}/${parts.find(x=>x.type==='day')?.value}`;
  const d=await getCashflowDashboard(today);
  const forecastRows=d.forecast.slice(0,100).map(x=>`<tr><td>${esc(x.date)}</td><td>${x.source==='invoice'?'مانده فاکتور':'چک در جریان'}</td><td>${esc(x.reference)}</td><td>${esc(x.partyName)}</td><td>${x.inflowRial?money(x.inflowRial):'—'}</td><td>${x.outflowRial?money(x.outflowRial):'—'}</td></tr>`).join('')||'<tr><td colspan="6">در بازه آینده، مورد سررسیدداری ثبت نشده است.</td></tr>';
  const partyRows=d.parties.slice(0,50).map(x=>`<tr><td>${esc(x.partyName)}</td><td>${x.role==='customer'?'مشتری':'تأمین‌کننده'}</td><td>${money(x.invoicedRial)}</td><td>${money(x.allocatedRial)}</td><td>${money(x.outstandingRial)}</td><td>${fa(Math.round(x.collectionPercent))}٪</td></tr>`).join('')||'<tr><td colspan="6">برای رتبه‌بندی، فاکتور قطعی و تخصیص پرداخت ثبت نشده است.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>پیش‌بینی جریان نقد و رفتار پرداخت</h3><p class="hint">مبنای گزارش: ${esc(today)} · پیش‌بینی بر اساس سررسید فاکتورهای قطعی و چک‌های در جریان است؛ ارقام قطعیِ آینده نیستند.</p><div class="form-grid"><div class="stat-card"><b>${money(d.next7InRial)}</b><span>ورودی پیش‌بینی‌شده تا ۷ روز</span></div><div class="stat-card"><b>${money(d.next7OutRial)}</b><span>خروجی پیش‌بینی‌شده تا ۷ روز</span></div><div class="stat-card"><b>${money(d.next30InRial)}</b><span>ورودی پیش‌بینی‌شده تا ۳۰ روز</span></div><div class="stat-card"><b>${money(d.next30OutRial)}</b><span>خروجی پیش‌بینی‌شده تا ۳۰ روز</span></div><div class="stat-card"><b>${money(d.next60InRial)}</b><span>ورودی پیش‌بینی‌شده تا ۶۰ روز</span></div><div class="stat-card"><b>${money(d.next60OutRial)}</b><span>خروجی پیش‌بینی‌شده تا ۶۰ روز</span></div></div><h4>تقویم سررسیدهای پیش‌رو</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>تاریخ</th><th>منبع</th><th>شماره</th><th>طرف حساب</th><th>ورودی</th><th>خروجی</th></tr></thead><tbody>${forecastRows}</tbody></table></div><h4>رتبه‌بندی رفتار پرداخت طرف‌حساب‌ها</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>طرف حساب</th><th>نقش</th><th>فاکتور قطعی</th><th>پرداخت تخصیص‌یافته</th><th>مانده باز</th><th>نسبت تخصیص</th></tr></thead><tbody>${partyRows}</tbody></table></div><p class="hint">نسبت پرداخت فقط از مبالغ تخصیص‌یافته به فاکتورهای قطعی محاسبه می‌شود؛ پرداخت‌های علی‌الحساب در این نسبت منظور نمی‌شوند. این گزارش سود خالص یا توان اعتباری قطعی اشخاص را ادعا نمی‌کند و هیچ سند یا داده‌ای را تغییر نمی‌دهد.</p></div>`;
}

/** گزارش تحلیلی موجودی راکد و حاشیه پایین — فقط‌خواندنی */
async function inventoryMarginAnalyticsPanel():Promise<string>{
  if(!commerce) return '';
  const costing=await loadInventoryCostData();
  const idleDays=Number(digits((el<HTMLInputElement>('#analyticsIdleDays')?.value||'90')).replace(',','.'))||90;
  const lowMargin=Number(digits((el<HTMLInputElement>('#analyticsLowMargin')?.value||'10')).replace(',','.'))||10;
  const highVol=Number(digits((el<HTMLInputElement>('#analyticsHighVol')?.value||'10')).replace(',','.'))||10;
  const a=buildInventoryMarginAnalytics(commerce,costing,products,{
    idleDays,
    lowMarginPercent:lowMargin,
    highVolumeQty:highVol,
  });
  const slow=a.slowMoving.slice(0,80).map(r=>`<tr>
    <td>${esc(r.productName)}</td><td>${esc(r.warehouse)}</td><td>${fa(r.quantityMilli/1000)}</td>
    <td>${money(r.valueRial)}</td>
    <td>${r.neverSold?'هرگز فروخته نشده':esc(r.lastSaleDate||'—')}</td>
    <td>${r.neverSold?'—':fa(r.daysSinceSale||0)}</td>
  </tr>`).join('')||'<tr><td colspan="6">با آستانه فعلی کالای راکدی یافت نشد.</td></tr>';
  const low=a.lowMarginSales.slice(0,80).map(r=>`<tr>
    <td>${esc(r.date)}</td><td>${esc(r.invoiceNumber)}</td><td>${esc(r.productName)}</td>
    <td>${esc(r.customerName)}</td><td>${money(r.revenueRial)}</td><td>${money(r.grossProfitRial)}</td>
    <td>${fa(Math.round(r.marginPercent*10)/10)}٪</td>
  </tr>`).join('')||'<tr><td colspan="7">فروش کم‌حاشیه در آستانه فعلی یافت نشد.</td></tr>';
  const vol=a.highVolumeLowMargin.slice(0,50).map(r=>`<tr>
    <td>${esc(r.productName)}</td><td>${fa(r.quantityMilli/1000)}</td>
    <td>${money(r.revenueRial)}</td><td>${money(r.grossProfitRial)}</td>
    <td>${fa(Math.round(r.marginPercent*10)/10)}٪</td>
  </tr>`).join('')||'<tr><td colspan="5">کالای پرفروش با حاشیه پایین یافت نشد.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>تحلیل موجودی راکد و حاشیه سود</h3>
<p class="hint">گزارش فقط‌خواندنی است و هیچ سند یا موجودی‌ای را تغییر نمی‌دهد. آستانه‌ها را تنظیم و «بازمحاسبه» را بزنید.</p>
<div class="form-grid" style="margin:10px 0">
  <label class="field">روز راکد (از آخرین فروش)<input id="analyticsIdleDays" inputmode="numeric" value="${fa(idleDays)}"></label>
  <label class="field">حداکثر حاشیه٪ (کم‌حاشیه)<input id="analyticsLowMargin" inputmode="decimal" value="${fa(lowMargin)}"></label>
  <label class="field">حداقل تعداد پرفروش<input id="analyticsHighVol" inputmode="decimal" value="${fa(highVol)}"></label>
  <div style="display:flex;align-items:end"><button type="button" class="btn btn-secondary" id="analyticsRefresh">بازمحاسبه</button></div>
</div>
<div class="form-grid">
  <div class="stat-card"><b>${fa(a.slowMoving.length)}</b><span>کالای راکد / کم‌گردش</span></div>
  <div class="stat-card"><b>${fa(a.lowMarginSales.length)}</b><span>ردیف فروش کم‌حاشیه</span></div>
  <div class="stat-card"><b>${fa(a.highVolumeLowMargin.length)}</b><span>پرفروش با حاشیه پایین</span></div>
  <div class="stat-card"><b>${money(a.slowMoving.reduce((s,x)=>s+x.valueRial,0))}</b><span>ارزش موجودی راکد</span></div>
</div>
<h4 style="margin:14px 0 8px">موجودی راکد / کم‌گردش</h4>
<div class="table-wrap"><table class="data-table"><thead><tr>
  <th>کالا</th><th>انبار</th><th>موجودی</th><th>ارزش</th><th>آخرین فروش</th><th>روز از فروش</th>
</tr></thead><tbody>${slow}</tbody></table></div>
<h4 style="margin:14px 0 8px">فروش با حاشیه پایین یا زیان</h4>
<div class="table-wrap"><table class="data-table"><thead><tr>
  <th>تاریخ</th><th>فاکتور</th><th>کالا</th><th>مشتری</th><th>فروش</th><th>سود ناخالص</th><th>حاشیه</th>
</tr></thead><tbody>${low}</tbody></table></div>
<h4 style="margin:14px 0 8px">پرفروش با حاشیه ضعیف</h4>
<div class="table-wrap"><table class="data-table"><thead><tr>
  <th>کالا</th><th>تعداد فروش</th><th>فروش</th><th>سود ناخالص</th><th>حاشیه</th>
</tr></thead><tbody>${vol}</tbody></table></div>
</div>`;
}

async function profitabilityPanel():Promise<string>{
  const d=await getProfitabilityDashboard(profitabilityFilter);
  const adjusted=await getExpenseAdjustedProfitability(d,profitabilityFilter);
  const periodRows=await getProfitabilityPeriodComparison(profitabilityFilter);
  const trendRows=await getMonthlyProfitabilityTrend(profitabilityFilter);
  const trendMax=Math.max(1,...trendRows.map(x=>Math.max(x.salesRial,x.grossProfitRial,x.expensesRial)));
  const trendBars=trendRows.map(x=>`<div style="padding:9px 0;border-bottom:1px solid var(--border-color,#ddd)"><b>${esc(x.month)}</b><div style="display:grid;grid-template-columns:90px 1fr auto;gap:8px;align-items:center;margin-top:5px"><span>فروش</span><div style="height:9px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${Math.max(0,Math.min(100,x.salesRial/trendMax*100))}%;background:#2878bd"></div></div><small>${money(x.salesRial)}</small><span>سود ناخالص</span><div style="height:9px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${Math.max(0,Math.min(100,x.grossProfitRial/trendMax*100))}%;background:#26945e"></div></div><small>${money(x.grossProfitRial)}</small><span>هزینه گروه ۶</span><div style="height:9px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${Math.max(0,Math.min(100,x.expensesRial/trendMax*100))}%;background:#c58a27"></div></div><small>${money(x.expensesRial)}</small></div><p class="hint" style="margin:4px 0 0">سود پس از هزینه ثبت‌شده: ${money(x.adjustedProfitRial)}</p></div>`).join('')||'<p class="hint">برای نمایش روند، فاکتور فروش قطعی یا سند هزینه تاریخ‌دار در بازه انتخاب‌شده لازم است.</p>';
  const periodComparisonRows=periodRows.map(x=>`<tr><td>${esc(x.periodTitle)}</td><td>${esc(x.startDate)} تا ${esc(x.endDate)}</td><td>${money(x.salesRial)}</td><td>${money(x.costedSalesRial)}</td><td>${money(x.cogsRial)}</td><td>${money(x.grossProfitRial)}</td><td>${money(x.postedExpensesRial)}</td><td>${money(x.adjustedProfitRial)}</td><td>${fa(Math.round(x.marginPercent*10)/10)}٪</td><td>${money(x.uncostedRevenueRial)}</td></tr>`).join('')||'<tr><td colspan="10">سال مالی تعریف‌شده‌ای برای مقایسه وجود ندارد.</td></tr>';

  const productRows=d.products.slice(0,50).map(x=>`<tr><td>${esc(x.name)}</td><td>${fa(x.quantityMilli/1000)}</td><td>${money(x.revenueRial)}</td><td>${money(x.costRial)}</td><td>${money(x.grossProfitRial)}</td><td>${fa(Math.round(x.marginPercent*10)/10)}٪</td></tr>`).join('')||'<tr><td colspan="6">برای محاسبه، فروش قطعی دارای بهای تمام‌شده ثبت‌شده لازم است.</td></tr>';
  const customerRows=d.customers.slice(0,50).map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.revenueRial)}</td><td>${money(x.costRial)}</td><td>${money(x.grossProfitRial)}</td><td>${fa(Math.round(x.marginPercent*10)/10)}٪</td></tr>`).join('')||'<tr><td colspan="5">اطلاعات سودآوری قابل محاسبه وجود ندارد.</td></tr>';
  const expenseRows=adjusted.expenseAccounts.map(x=>`<tr><td>${esc(x.code)}</td><td>${esc(x.title)}</td><td>${money(x.amountRial)}</td></tr>`).join('')||'<tr><td colspan="3">هزینه قطعی در حساب‌های گروه ۶ ثبت نشده است.</td></tr>';
  const adjustedProductRows=adjusted.products.slice(0,50).map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.revenueRial)}</td><td>${money(x.allocatedExpenseRial)}</td><td>${money(x.adjustedProfitRial)}</td><td>${fa(Math.round(x.adjustedMarginPercent*10)/10)}٪</td></tr>`).join('')||'<tr><td colspan="5">داده کافی برای تخصیص هزینه وجود ندارد.</td></tr>';
  const adjustedCustomerRows=adjusted.customers.slice(0,50).map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.revenueRial)}</td><td>${money(x.allocatedExpenseRial)}</td><td>${money(x.adjustedProfitRial)}</td><td>${fa(Math.round(x.adjustedMarginPercent*10)/10)}٪</td></tr>`).join('')||'<tr><td colspan="5">داده کافی برای تخصیص هزینه وجود ندارد.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>تحلیل سود ناخالص کالا و مشتری</h3><div class="form-grid" style="margin:10px 0"><label class="field">سال مالی<select id="profitabilityPeriod"><option value="">همه سال‌های مالی</option>${(await getProfitabilityPeriodComparison()).map(x=>`<option value="${esc(x.periodId)}" ${profitabilityFilter.fiscalPeriodId===x.periodId?'selected':''}>${esc(x.periodTitle)}</option>`).join('')}</select></label><label class="field">از تاریخ شمسی<input id="profitabilityFrom" placeholder="1405/01/01" value="${esc(profitabilityFilter.fromDate||'')}"></label><label class="field">تا تاریخ شمسی<input id="profitabilityTo" placeholder="1405/12/29" value="${esc(profitabilityFilter.toDate||'')}"></label><button class="btn btn-primary" id="profitabilityApplyFilter" type="button">اعمال فیلتر</button><button class="btn btn-secondary" id="profitabilityClearFilter" type="button">پاک‌کردن فیلتر</button><button class="btn btn-secondary" id="profitabilityExportXlsx" type="button">خروجی Excel همین بازه</button><button class="btn btn-secondary" id="profitabilityPrintPdf" type="button">چاپ / PDF همین بازه</button></div><p class="hint">گزارش فقط‌خواندنی بر اساس فاکتورهای فروش قطعی و گردش بهای تمام‌شده انبار؛ هزینه‌های عملیاتی، مالیات و هزینه‌های سربار در سود خالص لحاظ نشده‌اند.</p><div class="form-grid"><div class="stat-card"><b>${money(d.salesRial)}</b><span>کل فروش قطعی</span></div><div class="stat-card"><b>${money(d.costedSalesRial)}</b><span>فروش دارای بهای معتبر</span></div><div class="stat-card"><b>${money(d.cogsRial)}</b><span>بهای تمام‌شده کالای فروش‌رفته</span></div><div class="stat-card"><b>${money(d.grossProfitRial)}</b><span>سود ناخالص قابل محاسبه</span></div><div class="stat-card"><b>${fa(Math.round(d.marginPercent*10)/10)}٪</b><span>حاشیه سود ناخالص</span></div></div><p class="hint">فروش فاقد بهای قابل اتکا: ${money(d.uncostedRevenueRial)} · فروش با بهای موقت ناشی از کسری موجودی: ${money(d.provisionalRevenueRial)}. این مبالغ از محاسبه سود کنار گذاشته شده‌اند.</p><h4>روند ماهانه فروش، سود و هزینه‌ها</h4><p class="hint">طول میله‌ها نسبت به بیشترین مقدار همین نمودار مقیاس شده است؛ سود پس از هزینه، شاخص مدیریتی است و سود خالص رسمی محسوب نمی‌شود.</p><div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-bottom:8px"><span>■ فروش</span><span>■ سود ناخالص</span><span>■ هزینه گروه ۶</span></div><div>${trendBars}</div><h4>سودآوری کالاها</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>کالا</th><th>مقدار</th><th>فروش</th><th>بهای تمام‌شده</th><th>سود ناخالص</th><th>حاشیه</th></tr></thead><tbody>${productRows}</tbody></table></div><h4>سودآوری مشتریان</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>مشتری</th><th>فروش</th><th>بهای تمام‌شده</th><th>سود ناخالص</th><th>حاشیه</th></tr></thead><tbody>${customerRows}</tbody></table></div><p class="hint">فاکتورهای پیش‌نویس، ردیف‌های خدماتی بدون بهای انبار، و فروش‌های دارای بهای موقت در سود محاسبه نمی‌شوند.</p><hr><h3>تخصیص تحلیلی هزینه‌ها و سود تعدیل‌شده</h3><p class="hint">هزینه‌های ثبت‌شده در اسناد قطعی حساب‌های گروه ۶، به نسبت فروش دارای بهای معتبر بین کالاها و مشتریان سرشکن شده‌اند. این تخصیص صرفاً گزارشی است و هیچ سند حسابداری یا گردش مالی را تغییر نمی‌دهد.</p><div class="form-grid"><div class="stat-card"><b>${money(adjusted.totalPostedExpensesRial)}</b><span>خالص هزینه ثبت‌شده در حساب‌های گروه ۶</span></div><div class="stat-card"><b>${money(adjusted.allocatedExpensesRial)}</b><span>هزینه تخصیص‌یافته به فروش‌های بهای‌دار</span></div><div class="stat-card"><b>${money(adjusted.unallocatedExpensesRial)}</b><span>هزینه تخصیص‌نیافته</span></div><div class="stat-card"><b>${money(adjusted.adjustedProfitRial)}</b><span>سود پس از کسر هزینه تخصیص‌یافته</span></div><div class="stat-card"><b>${fa(Math.round(adjusted.adjustedMarginPercent*10)/10)}٪</b><span>حاشیه پس از تخصیص هزینه</span></div></div><h4>ترکیب هزینه‌های ثبت‌شده</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>کد حساب</th><th>عنوان حساب</th><th>خالص هزینه</th></tr></thead><tbody>${expenseRows}</tbody></table></div><h4>سود تعدیل‌شده کالاها</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>کالا</th><th>فروش معتبر</th><th>هزینه تخصیصی</th><th>سود تعدیل‌شده</th><th>حاشیه</th></tr></thead><tbody>${adjustedProductRows}</tbody></table></div><h4>سود تعدیل‌شده مشتریان</h4><div class="table-wrap"><table class="data-table"><thead><tr><th>مشتری</th><th>فروش معتبر</th><th>هزینه تخصیصی</th><th>سود تعدیل‌شده</th><th>حاشیه</th></tr></thead><tbody>${adjustedCustomerRows}</tbody></table></div><p class="hint">مهم: این عدد «سود خالص رسمی» نیست؛ هزینه‌های گروه ۶ ممکن است مربوط به دوره‌های متفاوت یا درآمدهای خارج از فروش انبار باشند. تخصیص بر اساس نسبت فروش انجام شده و برای گزارش مدیریتی است. برای صورت سود و زیان رسمی، گزارش حسابداری با فیلتر سال مالی و تاریخ مبنا قرار گیرد.</p><hr><h3>مقایسه نموداری سال‌های مالی</h3><div>${periodRows.map(x=>{const max=Math.max(1,...periodRows.map(y=>Math.max(y.salesRial,y.grossProfitRial,y.postedExpensesRial)));return `<div style="padding:7px 0"><b>${esc(x.periodTitle)}</b><div style="display:grid;grid-template-columns:80px 1fr auto;gap:7px;align-items:center"><span>فروش</span><div style="height:8px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${x.salesRial/max*100}%;background:#2878bd"></div></div><small>${money(x.salesRial)}</small><span>سود ناخالص</span><div style="height:8px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${Math.max(0,x.grossProfitRial)/max*100}%;background:#26945e"></div></div><small>${money(x.grossProfitRial)}</small><span>هزینه</span><div style="height:8px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${Math.max(0,x.postedExpensesRial)/max*100}%;background:#c58a27"></div></div><small>${money(x.postedExpensesRial)}</small></div></div>`}).join('')||'<p class="hint">دوره مالی برای نمودار وجود ندارد.</p>'}</div><h3>مقایسه عملکرد سال‌های مالی</h3><p class="hint">هر ردیف فقط شامل فاکتورهای فروش و اسناد هزینه قطعی همان سال مالی است. فروش فاقد بهای معتبر جداگانه نمایش داده می‌شود و از سود ناخالص کنار گذاشته شده است.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>سال مالی</th><th>بازه شمسی</th><th>فروش</th><th>فروش بهای‌دار</th><th>بهای تمام‌شده</th><th>سود ناخالص</th><th>هزینه گروه ۶</th><th>سود تعدیل‌شده</th><th>حاشیه ناخالص</th><th>فروش بی‌بها/موقت</th></tr></thead><tbody>${periodComparisonRows}</tbody></table></div><p class="hint">سود تعدیل‌شده این جدول یک شاخص مدیریتی است، نه سود خالص رسمی؛ تخصیص هزینه‌ها همچنان بر مبنای نسبت فروش دارای بهای معتبر انجام می‌شود.</p></div>`;
}

async function managementDashboardPanel():Promise<string>{
  const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const today=`${parts.find(x=>x.type==='year')?.value}/${parts.find(x=>x.type==='month')?.value}/${parts.find(x=>x.type==='day')?.value}`;
  const periods=await getProfitabilityPeriodComparison();
  const selectedPeriod=periods.find(x=>x.periodId===managementFilter.fiscalPeriodId);
  const from=managementFilter.fromDate||selectedPeriod?.startDate||'';
  const to=managementFilter.toDate||selectedPeriod?.endDate||'';
  const anchor=to||today;
  const filter:ProfitabilityFilter={...managementFilter};
  const [aging,cashflow,profitability,banks,monthlyTrend]=await Promise.all([getAgingDashboard(anchor),getCashflowDashboard(anchor),getProfitabilityDashboard(filter),getBankAccountBalances(),getMonthlyProfitabilityTrend(filter)]);
  const normalize=(v:string)=>digits(String(v||'')).replace(/-/g,'/').slice(0,10);
  const inRange=(v:string)=>{const d=normalize(v);return (!from||d>=normalize(from))&&(!to||d<=normalize(to));};
  const postedSales=(commerce!.invoices||[]).filter(i=>i.status==='posted'&&i.type==='sale'&&inRange(i.date));
  const monthSales=postedSales.reduce((sum,i)=>sum+i.grossRial,0);
  const lowStock=products.filter(p=>Number.isFinite(Number(p.minQty))&&p.minQty!==null&&p.minQty!==undefined&&p.systemQty<=Number(p.minQty));
  const stockValueQty=products.reduce((sum,p)=>sum+Math.max(0,Number(p.systemQty)||0),0);
  const bankBalance=banks.reduce((sum,a)=>sum+a.balanceRial,0);
  const net30=cashflow.next30InRial-cashflow.next30OutRial;
  const alerts=[
    aging.overdueReceivableRial>0?`مطالبات سررسیدگذشته: ${money(aging.overdueReceivableRial)}`:'مطالبه سررسیدگذشته‌ای شناسایی نشد',
    lowStock.length?`${fa(lowStock.length)} قلم کالا در حداقل موجودی یا پایین‌تر قرار دارد`:'کالای زیر حداقل موجودی ثبت نشده است',
    aging.overdueCheques.length?`${fa(aging.overdueCheques.length)} چک در جریان سررسیدگذشته دارد`:'چک سررسیدگذشته‌ای شناسایی نشد'
  ];
  const selectedLabel=managementFilter.fiscalPeriodId?(selectedPeriod?.periodTitle||'سال مالی انتخاب‌شده'):'همه سال‌های مالی';
  const monthKey=(value:string)=>digits(String(value||'')).replace(/[^0-9]/g,'').slice(0,6);
  const monthly=new Map(monthlyTrend.map(x=>[x.month,{...x,receiptsRial:0,paymentsRial:0,receivableRial:0}]));
  for(const tx of commerce!.cashTransactions){
    if(!inRange(tx.date)||tx.chequeStatus==='bounced'||tx.chequeStatus==='void'||(tx.method==='cheque'&&tx.chequeStatus!=='cleared'))continue;
    const key=monthKey(tx.date);if(key.length!==6)continue;const month=`${key.slice(0,4)}/${key.slice(4,6)}`;
    const row=monthly.get(month)||{month,salesRial:0,grossProfitRial:0,expensesRial:0,adjustedProfitRial:0,receiptsRial:0,paymentsRial:0,receivableRial:0};
    if(tx.type==='receipt')row.receiptsRial+=tx.amountRial;else row.paymentsRial+=tx.amountRial;monthly.set(month,row);
  }
  for(const invoice of commerce!.invoices){
    if(invoice.status!=='posted'||invoice.type!=='sale'||!inRange(invoice.date))continue;
    const key=monthKey(invoice.date);if(key.length!==6)continue;const month=`${key.slice(0,4)}/${key.slice(4,6)}`;
    const row=monthly.get(month)||{month,salesRial:0,grossProfitRial:0,expensesRial:0,adjustedProfitRial:0,receiptsRial:0,paymentsRial:0,receivableRial:0};
    row.receivableRial+=invoiceOutstanding(invoice.id,commerce!);monthly.set(month,row);
  }
  const trendRows=[...monthly.values()].sort((a,b)=>a.month.localeCompare(b.month)).slice(-18);
  const trendMax=Math.max(1,...trendRows.flatMap(x=>[x.salesRial,x.grossProfitRial,x.expensesRial,x.receiptsRial,x.paymentsRial,x.receivableRial]));
  const accountingData=await loadAccountingData();
  const monthOf=(value:string)=>monthKey(value).slice(0,6);
  const monthDetails=(month:string)=>{
    const invoices=commerce!.invoices.filter(i=>i.status==='posted'&&i.type==='sale'&&monthOf(i.date)===month.replace('/','')&&inRange(i.date));
    const transactions=commerce!.cashTransactions.filter(t=>monthOf(t.date)===month.replace('/','')&&inRange(t.date)&&t.chequeStatus!=='bounced'&&t.chequeStatus!=='void'&&(t.method!=='cheque'||t.chequeStatus==='cleared'));
    const expenses=accountingData.journalEntries.filter(j=>j.status==='posted'&&monthOf(j.date)===month.replace('/','')&&inRange(j.date)).flatMap(j=>j.lines.map(line=>{const account=accountingData.accounts.find(a=>a.id===line.accountId);const code=line.accountCodeSnapshot||account?.code||'';const amount=Number(line.debitRial||0)-Number(line.creditRial||0);return code.startsWith('6')&&amount!==0?{number:j.number,date:j.date,description:line.description||j.description,account:line.accountTitleSnapshot||account?.title||code,amount}:null}).filter((x):x is {number:string;date:string;description:string;account:string;amount:number}=>!!x));
    const invoiceRows=invoices.map(i=>{const party=commerce!.parties.find(p=>p.id===i.partyId);return `<tr><td>${esc(i.number)}</td><td>${esc(i.date)}</td><td>${esc(party?.name||'—')}</td><td>${money(i.grossRial)}</td></tr>`}).join('')||'<tr><td colspan="4">فاکتور فروش قطعی ندارد.</td></tr>';
    const cashRows=transactions.map(t=>{const party=commerce!.parties.find(p=>p.id===t.partyId);return `<tr><td>${t.type==='receipt'?'دریافت':'پرداخت'}</td><td>${esc(t.number)}</td><td>${esc(t.date)}</td><td>${esc(party?.name||'—')}</td><td>${money(t.amountRial)}</td></tr>`}).join('')||'<tr><td colspan="5">دریافت یا پرداخت قطعی ندارد.</td></tr>';
    const expenseRows=expenses.map(x=>`<tr><td>${esc(x.number)}</td><td>${esc(x.date)}</td><td>${esc(x.account)}</td><td>${esc(x.description)}</td><td>${money(x.amount)}</td></tr>`).join('')||'<tr><td colspan="5">هزینه ثبت‌شده در حساب‌های گروه ۶ ندارد.</td></tr>';
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button type="button" class="btn btn-sm btn-secondary" data-management-month-xlsx="${esc(month)}" data-management-month-from="${esc(from)}" data-management-month-to="${esc(to)}">خروجی Excel این ماه</button><button type="button" class="btn btn-sm btn-secondary" data-management-month-pdf="${esc(month)}" data-management-month-from="${esc(from)}" data-management-month-to="${esc(to)}">چاپ / PDF این ماه</button></div><div class="table-wrap"><h5>فاکتورهای فروش قطعی</h5><table class="data-table"><thead><tr><th>شماره</th><th>تاریخ</th><th>مشتری</th><th>مبلغ</th></tr></thead><tbody>${invoiceRows}</tbody></table></div><div class="table-wrap"><h5>دریافت‌ها و پرداخت‌های قطعی</h5><table class="data-table"><thead><tr><th>نوع</th><th>شماره</th><th>تاریخ</th><th>طرف حساب</th><th>مبلغ</th></tr></thead><tbody>${cashRows}</tbody></table></div><div class="table-wrap"><h5>ریز هزینه‌های قطعی گروه ۶</h5><table class="data-table"><thead><tr><th>سند</th><th>تاریخ</th><th>حساب</th><th>شرح</th><th>خالص هزینه</th></tr></thead><tbody>${expenseRows}</tbody></table></div>`;
  };
  const comparisonMetrics=[['فروش قطعی','salesRial'],['سود ناخالص','grossProfitRial'],['هزینه ثبت‌شده گروه ۶','expensesRial'],['دریافت قطعی','receiptsRial'],['پرداخت قطعی','paymentsRial'],['مانده فعلی مطالبات','receivableRial']] as const;
  const initialCurrent=trendRows[trendRows.length-1]?.month||'';
  const initialPrevious=trendRows[trendRows.length-2]?.month||initialCurrent;
  const comparisonMonthOptions=trendRows.map(x=>`<option value="${esc(x.month)}" ${x.month===initialPrevious?'data-first-default="1"':''} ${x.month===initialCurrent?'data-second-default="1"':''}>${esc(x.month)}</option>`).join('');
  const comparisonHtml=(first:string,second:string)=>{const a=trendRows.find(x=>x.month===first),b=trendRows.find(x=>x.month===second);if(!a||!b)return '<p class="hint">برای مقایسه، دست‌کم یک ماه دارای داده لازم است.</p>';const rows=comparisonMetrics.map(([label,key])=>{const av=Number(a[key]||0),bv=Number(b[key]||0),delta=bv-av,pct=av===0?null:delta/Math.abs(av)*100;return `<tr><td>${label}</td><td>${money(av)}</td><td>${money(bv)}</td><td>${delta>0?'+':''}${money(delta)}</td><td>${pct===null?'—':`${pct>0?'+':''}${pct.toFixed(1)}٪`}</td></tr>`}).join('');return `<div class="table-wrap"><table class="data-table"><thead><tr><th>شاخص</th><th>${esc(first)}</th><th>${esc(second)}</th><th>اختلاف (ماه دوم − اول)</th><th>تغییر درصدی</th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint">درصد تغییر نسبت به ماه اول محاسبه می‌شود؛ اگر مقدار ماه اول صفر باشد، درصد تغییر قابل محاسبه نیست.</p>`};
  const anomalyHtml=(threshold:number)=>{const alerts=detectManagementMonthAnomalies(trendRows,threshold);if(!alerts.length)return '<p class="hint">در آستانه انتخابی، تغییر غیرعادی معناداری در ماه‌های دارای داده پیدا نشد. تغییرات با مبنای صفر برای جلوگیری از درصد گمراه‌کننده نادیده گرفته می‌شوند.</p>';return `<div class="table-wrap"><table class="data-table"><thead><tr><th>وضعیت</th><th>شاخص</th><th>بازه مقایسه</th><th>مقدار قبلی</th><th>مقدار جدید</th><th>تغییر</th></tr></thead><tbody>${alerts.map(a=>`<tr><td>${a.severity==='warning'?'نیازمند بررسی':'بهبود'}</td><td>${a.label}</td><td>${esc(a.previousMonth)} ← ${esc(a.month)}</td><td>${money(a.previousValue)}</td><td>${money(a.currentValue)}</td><td>${a.percentChange>0?'+':''}${a.percentChange.toFixed(1)}٪</td></tr>`).join('')}</tbody></table></div><p class="hint">هشدارها تحلیلی‌اند؛ کاهش فروش/سود/دریافت و افزایش هزینه/پرداخت/مطالبات به‌عنوان وضعیت نیازمند بررسی علامت‌گذاری می‌شود.</p>`;};
  const trendHtml=trendRows.length?trendRows.map(x=>{const bar=(label:string,value:number,color:string)=>`<div style="display:grid;grid-template-columns:92px minmax(50px,1fr) auto;gap:7px;align-items:center;margin:4px 0"><small>${label}</small><div style="height:9px;background:var(--border-color,#ddd);border-radius:8px;overflow:hidden"><div style="height:100%;width:${Math.max(0,Math.min(100,value/trendMax*100))}%;background:${color}"></div></div><small>${money(value)}</small></div>`;return `<div style="padding:9px 0;border-bottom:1px solid var(--border-color,#ddd)"><button type="button" class="btn btn-secondary btn-sm" data-management-month="${esc(x.month)}" aria-expanded="false">مشاهده جزئیات ${esc(x.month)}</button>${bar('فروش',x.salesRial,'#2878bd')}${bar('سود ناخالص',x.grossProfitRial,'#26945e')}${bar('هزینه ثبت‌شده',x.expensesRial,'#c58a27')}${bar('دریافت قطعی',x.receiptsRial,'#168a83')}${bar('پرداخت قطعی',x.paymentsRial,'#b85b5b')}${bar('مانده فعلی مطالبات',x.receivableRial,'#8064a2')}<div id="managementMonthDetail_${x.month.replace('/','')}" hidden style="margin-top:10px;padding:10px;background:var(--surface-color,#f7f7f7);border-radius:8px">${monthDetails(x.month)}</div></div>`}).join(''):'<p class="hint">برای بازه انتخابی داده ماهانه‌ای جهت نمودار وجود ندارد.</p>';
  // نمودار ستونی SVG ماهانه (فروش / سود / هزینه)
  const chartMax=Math.max(1,...trendRows.map(x=>Math.max(x.salesRial,x.grossProfitRial,x.expensesRial,0)));
  const chartW=Math.max(320,trendRows.length*56+40);
  const chartH=180;
  const chartPad={t:16,r:12,b:36,l:12};
  const plotH=chartH-chartPad.t-chartPad.b;
  const groupW=trendRows.length? (chartW-chartPad.l-chartPad.r)/trendRows.length : 40;
  const barW=Math.max(4,Math.min(14,(groupW-8)/3));
  const chartBars=trendRows.map((x,i)=>{
    const gx=chartPad.l+i*groupW+groupW/2;
    const hSales=Math.round((Math.max(0,x.salesRial)/chartMax)*plotH);
    const hProfit=Math.round((Math.max(0,x.grossProfitRial)/chartMax)*plotH);
    const hExp=Math.round((Math.max(0,x.expensesRial)/chartMax)*plotH);
    const y0=chartPad.t+plotH;
    const label=esc(x.month.length>=7?x.month.slice(5):x.month);
    return `<g>
      <rect x="${gx-barW*1.5-2}" y="${y0-hSales}" width="${barW}" height="${hSales}" fill="#2878bd" rx="2"><title>فروش ${esc(x.month)}: ${money(x.salesRial)}</title></rect>
      <rect x="${gx-barW/2}" y="${y0-hProfit}" width="${barW}" height="${hProfit}" fill="#26945e" rx="2"><title>سود ${esc(x.month)}: ${money(x.grossProfitRial)}</title></rect>
      <rect x="${gx+barW/2+2}" y="${y0-hExp}" width="${barW}" height="${hExp}" fill="#c58a27" rx="2"><title>هزینه ${esc(x.month)}: ${money(x.expensesRial)}</title></rect>
      <text x="${gx}" y="${chartH-10}" text-anchor="middle" font-size="10" fill="currentColor">${label}</text>
    </g>`;
  }).join('');
  const trendChartSvg=trendRows.length?`<div class="management-trend-chart" style="margin:12px 0;padding:12px;border:1px solid var(--border-color,#ddd);border-radius:12px;overflow-x:auto">
  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;font-size:12px">
    <span><i style="display:inline-block;width:10px;height:10px;background:#2878bd;border-radius:2px;margin-left:4px"></i>فروش</span>
    <span><i style="display:inline-block;width:10px;height:10px;background:#26945e;border-radius:2px;margin-left:4px"></i>سود ناخالص</span>
    <span><i style="display:inline-block;width:10px;height:10px;background:#c58a27;border-radius:2px;margin-left:4px"></i>هزینه</span>
  </div>
  <svg viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}" role="img" aria-label="نمودار ماهانه فروش و سود">
    <line x1="${chartPad.l}" y1="${chartPad.t+plotH}" x2="${chartW-chartPad.r}" y2="${chartPad.t+plotH}" stroke="var(--border-color,#ccc)" stroke-width="1"/>
    ${chartBars}
  </svg>
</div>`:'';
  (window as any).__anbarinManagementCompareRows=trendRows;
  return `<section class="card" style="margin-top:12px;border-inline-start:4px solid var(--primary-color,#2878bd)"><h2 style="margin-top:0">داشبورد مدیریتی یکپارچه</h2><p class="hint">نمای کلی عملیات بر اساس داده‌های ثبت‌شده · تاریخ مبنا: ${esc(anchor)} · مبالغ به ${currency==='toman'?'تومان':'ریال'}</p>
  <div class="form-grid" style="margin:10px 0"><label class="field">سال مالی داشبورد<select id="managementPeriod"><option value="">همه سال‌های مالی</option>${periods.map(x=>`<option value="${esc(x.periodId)}" ${managementFilter.fiscalPeriodId===x.periodId?'selected':''}>${esc(x.periodTitle)}</option>`).join('')}</select></label><label class="field">از تاریخ شمسی<input id="managementFrom" placeholder="1405/01/01" value="${esc(managementFilter.fromDate||'')}"></label><label class="field">تا تاریخ شمسی<input id="managementTo" placeholder="1405/12/29" value="${esc(managementFilter.toDate||'')}"></label><button class="btn btn-primary" id="managementApplyFilter" type="button">اعمال فیلتر داشبورد</button><button class="btn btn-secondary" id="managementClearFilter" type="button">نمایش همه دوره‌ها</button><button class="btn btn-secondary" id="managementExportXlsx" type="button">خروجی Excel داشبورد</button><button class="btn btn-secondary" id="managementPrintPdf" type="button">چاپ / PDF داشبورد</button></div>
  <p class="hint">فیلتر فعال: ${esc(selectedLabel)}${from||to?` · بازه ${esc(from||'ابتدا')} تا ${esc(to||'امروز')}`:''}. شاخص‌های موجودی و مانده بانک/صندوق، وضعیت فعلی هستند و به بازه تاریخی محدود نمی‌شوند.</p>
  <div class="form-grid">
  <div class="stat-card"><b>${money(monthSales)}</b><span>فروش قطعی در بازه انتخابی</span></div>
  <div class="stat-card"><b>${money(profitability.grossProfitRial)}</b><span>سود ناخالص قابل محاسبه در بازه</span></div>
  <div class="stat-card"><b>${money(aging.receivableRial)}</b><span>مطالبات باز تا تاریخ مبنا</span></div>
  <div class="stat-card"><b>${money(aging.payableRial)}</b><span>بدهی‌های باز تا تاریخ مبنا</span></div>
  <div class="stat-card"><b>${money(bankBalance)}</b><span>مانده دفتری فعلی بانک و صندوق</span></div>
  <div class="stat-card"><b>${money(net30)}</b><span>خالص جریان نقد پیش‌بینی‌شده ۳۰ روز از تاریخ مبنا</span></div>
  <div class="stat-card"><b>${fa(products.length)}</b><span>تعداد اقلام کالا</span></div>
  <div class="stat-card"><b>${fa(lowStock.length)}</b><span>کالاهای در حداقل موجودی</span></div>
  <div class="stat-card"><b>${fa(stockValueQty)}</b><span>جمع تعداد موجودی ثبت‌شده</span></div>
  <div class="stat-card"><b>${fa(postedSales.length)}</b><span>فاکتورهای فروش قطعی در بازه</span></div>
  </div><h3>هشدار تغییرات غیرعادی ماهانه</h3><p class="hint">تغییر شاخص‌ها بین ماه‌های متوالیِ دارای داده بررسی می‌شود. این بخش فقط هشدار مدیریتی می‌دهد و هیچ داده‌ای را تغییر نمی‌دهد.</p><div class="form-grid" style="margin:8px 0"><label class="field">حد آستانه تغییر<select id="managementAnomalyThreshold"><option value="10">۱۰٪</option><option value="20" selected>۲۰٪</option><option value="30">۳۰٪</option><option value="50">۵۰٪</option></select></label></div><div id="managementAnomalyAlerts">${anomalyHtml(20)}</div><h3>مقایسه عملکرد دو ماه</h3><p class="hint">دو ماه را از داده‌های همین بازه و سال مالی انتخاب کنید؛ اختلاف مبلغ و درصد تغییر شاخص‌ها نمایش داده می‌شود.</p><div class="form-grid" style="margin:8px 0"><label class="field">ماه اول (مبنای مقایسه)<select id="managementCompareFirst">${comparisonMonthOptions.replace('data-first-default="1"','selected')}</select></label><label class="field">ماه دوم<select id="managementCompareSecond">${comparisonMonthOptions.replace('data-second-default="1"','selected')}</select></label></div><div id="managementMonthComparison">${comparisonHtml(initialPrevious,initialCurrent)}</div><h3>روند ماهانه شاخص‌های مدیریتی</h3><p class="hint">برای بازکردن جزئیات هر ماه، دکمه «مشاهده جزئیات» را انتخاب کنید. اطلاعات شامل فاکتورهای فروش، دریافت‌ها، پرداخت‌ها و ریز هزینه‌های ثبت‌شده است.</p>${trendChartSvg}<div>${trendHtml}</div><p class="hint">توجه: مانده مطالبات در این نمودار، مانده فعلی فاکتورهای فروش است که بر اساس ماه صدور فاکتور دسته‌بندی شده؛ این عدد مانده تاریخی پایان هر ماه نیست. دریافت/پرداخت چکی تا زمان وصول یا تسویه قطعی در جریان نقد واقعی لحاظ نمی‌شود. برای پیش‌بینی، شاخص خالص جریان نقد ۳۰ روزه در بالای داشبورد نمایش داده شده است.</p><h4>هشدارها و موارد نیازمند پیگیری</h4><ul>${alerts.map(x=>`<li style="margin:6px 0">${esc(x)}</li>`).join('')}</ul><p class="hint">تعاریف: فروش و سود بر اساس فیلتر تاریخ/سال مالی؛ مطالبات و بدهی‌ها تا تاریخ مبنا؛ جریان نقد ۳۰ روز از تاریخ مبنا پیش‌بینی می‌شود. مانده بانک و صندوق و موجودی کالا وضعیت فعلی هستند، نه مانده تاریخی. سود ناخالص فقط از فروش دارای بهای معتبر محاسبه می‌شود.</p></section>`;
}

async function inventoryReconciliationPanel():Promise<string>{
  const [costing,accounting]=await Promise.all([loadInventoryCostData(),loadAccountingData()]);
  const report=buildInventoryReconciliation(products,costing,accounting);
  const issueLabel=(issue:string|null)=>issue==='quantity-mismatch'?'اختلاف تعداد':issue==='value-missing'?'بدون ارزش معتبر':issue==='negative-balance'?'موجودی منفی':issue==='orphan-cost-balance'?'کالای حذف‌شده در فهرست':'بدون مغایرت';
  const rows=report.rows.slice(0,300).map(r=>`<tr><td>${esc(r.productName)}</td><td>${esc(r.warehouse)}</td><td>${fa(r.systemQtyMilli/1000)}</td><td>${fa(r.costQtyMilli/1000)}</td><td>${fa(r.quantityDiffMilli/1000)}</td><td>${money(r.valueRial)}</td><td>${issueLabel(r.issue)}</td></tr>`).join('')||'<tr><td colspan="7">کالایی برای تطبیق وجود ندارد.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>تطبیق موجودی انبار و حسابداری</h3><p class="hint">این گزارش فقط‌خواندنی است؛ موجودی عملیاتی، دفتر بهای تمام‌شده و حساب معین موجودی کالا را مقایسه می‌کند. هیچ مقدار، سند یا مانده‌ای به‌صورت خودکار اصلاح نمی‌شود.</p><div class="form-grid"><div class="stat-card"><b>${fa(report.totalProducts)}</b><span>ردیف کالا / انبار</span></div><div class="stat-card"><b>${fa(report.issueCount)}</b><span>ردیف نیازمند بررسی</span></div><div class="stat-card"><b>${fa(report.systemQuantityMilli/1000)}</b><span>جمع تعداد عملیاتی</span></div><div class="stat-card"><b>${fa(report.costQuantityMilli/1000)}</b><span>جمع تعداد بهای تمام‌شده</span></div><div class="stat-card"><b>${money(report.inventoryValueRial)}</b><span>ارزش دفتر بهای تمام‌شده</span></div><div class="stat-card"><b>${money(report.ledgerInventoryRial)}</b><span>مانده حساب موجودی در دفتر کل</span></div></div><p class="hint">اختلاف تعداد: ${fa(report.quantityDiffMilli/1000)} · اختلاف ارزش (بهای تمام‌شده منهای دفتر کل): ${money(report.ledgerDiffRial)} · ${report.ledgerAccountFound?'حساب دفتر کل: '+esc(report.ledgerAccountTitle):'حساب معین موجودی کالا پیدا نشد.'}</p><div class="table-wrap"><table class="data-table"><thead><tr><th>کالا</th><th>انبار</th><th>تعداد عملیاتی</th><th>تعداد بهای تمام‌شده</th><th>اختلاف</th><th>ارزش موجودی</th><th>وضعیت</th></tr></thead><tbody>${rows}</tbody></table></div><p class="hint">توجه: مقایسه دفتر کل با ارزش فعلی بهای تمام‌شده، فقط زمانی قابل اتکاست که ثبت‌های موجودی از ابتدای دوره به‌طور کامل در هر دو زیرسیستم انجام شده باشند. اسناد دستی، موجودی افتتاحیه قدیمی، حذف کالا و گردش‌های خارج از فاکتور می‌توانند اختلاف ایجاد کنند. برای بررسی کامل، ردیف‌های مغایر و اسناد مبدأ را کنترل کنید.</p></div>`;
}

/** پنل بهای استاندارد و انحراف قیمت خرید */
async function inventoryStandardCostPanel():Promise<string>{
  if(!commerce) return '';
  const withStd=products.filter(p=>Math.round(Number(p.standardCostRial)||0)>0);
  const withoutStd=products.filter(p=>(Number(p.systemQty)||0)>0 && Math.round(Number(p.standardCostRial)||0)<=0).slice(0,40);
  const varianceRows=buildPurchaseStandardVariance(commerce.invoices,products);
  const totalVar=varianceRows.reduce((s,r)=>s+r.varianceRial,0);
  const unfav=varianceRows.filter(r=>r.varianceRial>0).reduce((s,r)=>s+r.varianceRial,0);
  const fav=varianceRows.filter(r=>r.varianceRial<0).reduce((s,r)=>s+r.varianceRial,0);
  const vtable=varianceRows.slice(0,150).map(r=>`<tr>
    <td>${esc(r.date)}</td><td>${esc(r.invoiceNumber)}</td><td>${esc(r.productName)}</td>
    <td>${fa(r.quantityMilli/1000)}</td>
    <td>${money(r.standardUnitRial)}</td><td>${money(r.actualUnitRial)}</td>
    <td>${money(r.varianceRial)}</td>
  </tr>`).join('')||'<tr><td colspan="7">هنوز خرید قطعی با کالای دارای بهای استاندارد ثبت نشده است.</td></tr>';
  const missing=withoutStd.map(p=>`<tr><td>${esc(p.name)}</td><td>${fa(Number(p.systemQty)||0)}</td><td>${money(Number(p.purchasePrice)||0)}</td></tr>`).join('')
    ||'<tr><td colspan="3">همه کالاهای دارای موجودی، بهای استاندارد دارند یا موجودی صفر است.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>بهای استاندارد و انحراف قیمت خرید</h3>
<p class="hint">اگر روی کارت کالا «بهای استاندارد» بیشتر از صفر باشد، در فاکتور خرید قطعی موجودی با بهای استاندارد ثبت می‌شود و اختلاف با قیمت واقعی (+ هزینه جانبی) به‌عنوان انحراف قیمت خرید در حساب ۵۱۰۳۰۱ شناسایی می‌گردد. کالاهای بدون بهای استاندارد مثل قبل با بهای واقعی ثبت می‌شوند.</p>
<div class="form-grid">
  <div class="stat-card"><b>${fa(withStd.length)}</b><span>کالا با بهای استاندارد</span></div>
  <div class="stat-card"><b>${money(totalVar)}</b><span>جمع انحراف (واقعی − استاندارد)</span></div>
  <div class="stat-card"><b>${money(unfav)}</b><span>انحراف نامساعد</span></div>
  <div class="stat-card"><b>${money(fav)}</b><span>انحراف مساعد</span></div>
</div>
<h4 style="margin:14px 0 8px">آخرین انحرافات خرید</h4>
<div class="table-wrap"><table class="data-table"><thead><tr>
  <th>تاریخ</th><th>فاکتور</th><th>کالا</th><th>تعداد</th><th>استاندارد واحد</th><th>واقعی واحد</th><th>انحراف</th>
</tr></thead><tbody>${vtable}</tbody></table></div>
<h4 style="margin:14px 0 8px">کالاهای دارای موجودی بدون بهای استاندارد</h4>
<div class="table-wrap"><table class="data-table"><thead><tr><th>کالا</th><th>موجودی</th><th>قیمت خرید کارت</th></tr></thead><tbody>${missing}</tbody></table></div>
</div>`;
}

/** پنل NRV — حداقل بهای تمام‌شده و خالص ارزش فروش (IAS 2) */
async function inventoryNrvPanel():Promise<string>{
  const costing=await loadInventoryCostData();
  const pctEl=typeof document!=='undefined'?document.getElementById('nrvSellingCostPct') as HTMLInputElement|null:null;
  const sellingCostPercent=pctEl?Number(digits(pctEl.value||'0').replace(',','.'))||0:0;
  const rows=buildNrvAnalysis(costing,products,{sellingCostPercent});
  const needWriteDown=rows.filter(r=>r.writeDownRial>0);
  const totalCost=rows.reduce((s,r)=>s+r.costValueRial,0);
  const totalReported=rows.reduce((s,r)=>s+r.reportedValueRial,0);
  const totalWd=rows.reduce((s,r)=>s+r.writeDownRial,0);
  const tableRows=rows.slice(0,200).map(r=>`<tr>
    <td>${esc(r.productName)}</td><td>${esc(r.warehouse)}</td><td>${fa(r.quantityMilli/1000)}</td>
    <td>${money(r.costValueRial)}</td>
    <td>${r.hasSellingPrice?money(r.nrvValueRial):'<span class="hint">قیمت فروش ندارد</span>'}</td>
    <td>${money(r.reportedValueRial)}</td>
    <td>${money(r.writeDownRial)}</td>
    <td>${r.writeDownRial>0?`<button type="button" class="btn btn-sm btn-secondary" data-nrv-write-down="${esc(r.productId)}" data-nrv-wh="${esc(r.warehouse)}" data-nrv-amount="${r.writeDownRial}">ثبت کاهش ارزش</button>`:'—'}</td>
  </tr>`).join('')||'<tr><td colspan="8">موجودی با بهای ثبت‌شده یافت نشد.</td></tr>';
  return `<div class="card" style="margin-top:12px"><h3>NRV — خالص ارزش فروش (IAS 2)</h3>
<p class="hint">ارزش گزارش‌شده موجودی = حداقلِ بهای تمام‌شده و خالص ارزش فروش. قیمت فروش از کارت کالا (قیمت فروش / مصرف‌کننده) خوانده می‌شود. هزینه فروش برآوردی را می‌توانید درصد وارد کنید.</p>
<div class="form-grid" style="margin:10px 0">
  <label class="field">هزینه فروش برآوردی (٪ از قیمت فروش)<input id="nrvSellingCostPct" inputmode="decimal" value="${fa(sellingCostPercent)}" placeholder="۰"></label>
  <div style="display:flex;align-items:end"><button type="button" class="btn btn-secondary" id="nrvRefresh">بازمحاسبه</button></div>
</div>
<div class="form-grid">
  <div class="stat-card"><b>${fa(rows.length)}</b><span>ردیف موجودی</span></div>
  <div class="stat-card"><b>${fa(needWriteDown.length)}</b><span>نیازمند کاهش ارزش</span></div>
  <div class="stat-card"><b>${money(totalCost)}</b><span>جمع بهای تمام‌شده</span></div>
  <div class="stat-card"><b>${money(totalReported)}</b><span>جمع ارزش پس از NRV</span></div>
  <div class="stat-card"><b>${money(totalWd)}</b><span>جمع کاهش ارزش پیشنهادی</span></div>
</div>
<div class="table-wrap" style="margin-top:10px"><table class="data-table"><thead><tr>
  <th>کالا</th><th>انبار</th><th>موجودی</th><th>بهای تمام‌شده</th><th>NRV</th><th>ارزش گزارش‌شده</th><th>کاهش ارزش</th><th>عملیات</th>
</tr></thead><tbody>${tableRows}</tbody></table></div>
<p class="hint">ثبت کاهش ارزش: بدهکار «زیان کاهش ارزش موجودی» و بستانکار «موجودی کالا»؛ تعداد موجودی ثابت می‌ماند و فقط ارزش دفتر بها کاهش می‌یابد.</p>
</div>`;
}


async function openCommercePanelSheet(section:CommercePanelSection):Promise<void> {
  const titles:Record<CommercePanelSection,string>={
    sale:'فاکتور فروش',
    purchase:'فاکتور خرید',
    receipts:'دریافت / پرداخت',
    cheques:'چک‌ها',
    aging:'سررسید',
    banking:'بانک',
    management:'سودآوری',
    inventory:'انبار',
    parties:'طرف حساب‌ها',
    operating:'هزینه و درآمد',
  };
  // بستن برگه‌های تو در تو قبلی تا محتوا گیر نکند
  document.getElementById('invoiceItemsSheet')?.remove();
  document.getElementById('partyFormSheet')?.remove();
  document.getElementById('invoiceTypeSheet')?.remove();
  activeCommerceSection=section;
  if(section==='sale'||section==='purchase'){
    // اگر نوع فعلی با بخش هم‌خوان نیست، نوع پیش‌فرض همان بخش
    if(section==='sale'&&!isSaleInvoiceType(activeInvoiceType)) activeInvoiceType='sale';
    if(section==='purchase'&&!isPurchaseInvoiceType(activeInvoiceType)) activeInvoiceType='purchase';
  }
  if(section!=='sale'&&section!=='purchase') editingInvoiceId=null;
  suppressCommerceSheetReopen=true;
  await render();
  suppressCommerceSheetReopen=false;
  const root=el<HTMLDivElement>('#accountingCommerceWorkspace');
  const sectionKey=(section==='sale'||section==='purchase')?'invoices':section;
  const sectionEl=root?.querySelector<HTMLElement>(`[data-commerce-section="${sectionKey}"]`);
  if(!sectionEl){activeCommerceSection='home';toast('بخش موردنظر پیدا نشد.','error');return;}
  sectionEl.hidden=false;
  document.getElementById('commercePanelSheet')?.remove();
  const overlay=document.createElement('div');
  overlay.id='commercePanelSheet';
  overlay.className='accounting-module-sheet commerce-module-sheet';
  overlay.style.zIndex='10070';
  overlay.dir='rtl';
  overlay.innerHTML=`<div class="accounting-module-sheet-inner"><header class="accounting-module-sheet-head"><div><p class="accounting-module-sheet-kicker">بازرگانی</p><h2>${titles[section]||'بازرگانی'}</h2></div><button type="button" class="btn btn-secondary" id="commercePanelClose">بازگشت</button></header><div class="accounting-module-sheet-body" id="commercePanelMount"></div></div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('accounting-sheet-open');
  const mount=overlay.querySelector<HTMLElement>('#commercePanelMount')!;
  while(sectionEl.firstChild) mount.appendChild(sectionEl.firstChild);
  if(!mount.firstChild){
    mount.innerHTML=`<div class="card"><p class="hint">محتوای این بخش در دسترس نیست. بازگشت را بزنید و دوباره تلاش کنید.</p></div>`;
  }
  // اسکرول به بالای برگه تا فرم دیده شود
  overlay.scrollTop=0;
  mount.scrollIntoView({block:'start'});
  const close=()=>{
    document.getElementById('invoiceItemsSheet')?.remove();
    document.getElementById('partyFormSheet')?.remove();
    // بازگرداندن گره‌ها تا render بعدی تمیز باشد
    while(mount.firstChild) sectionEl.appendChild(mount.firstChild);
    overlay.remove();
    if(!document.getElementById('accountingModuleSheet')){
      document.body.classList.remove('accounting-sheet-open');
    }
    activeCommerceSection='home';
    render();
  };
  overlay.querySelector('#commercePanelClose')?.addEventListener('click',close);
  // تقویم و جستجوی کالا پس از انتقال به برگه
  queueMicrotask(() => {
    const invDate = overlay.querySelector<HTMLInputElement>('#invoiceDate') || el<HTMLInputElement>('#invoiceDate');
    if (invDate) {
      const btn = overlay.querySelector<HTMLButtonElement>('#invoiceJalaliCalendar') || el<HTMLButtonElement>('#invoiceJalaliCalendar');
      const panel = overlay.querySelector<HTMLDivElement>('#invoiceJalaliCalendarPanel') || el<HTMLDivElement>('#invoiceJalaliCalendarPanel');
      if (btn) delete (btn as HTMLButtonElement).dataset.calBound;
      delete invDate.dataset.calendarEnhanced;
      attachJalaliCalendar(invDate, btn, panel);
    }
    enhanceDateFields(overlay);
  });

}

function openInvoiceTypeSheet():void {
 document.getElementById('invoiceTypeSheet')?.remove();
 const overlay=document.createElement('div');overlay.id='invoiceTypeSheet';overlay.dir='rtl';overlay.style.cssText='position:fixed;inset:0;z-index:10100;background:var(--surface,#fff);color:var(--text,#222);overflow:auto;padding:clamp(16px,4vw,32px)';
 overlay.innerHTML=`<div style="max-width:760px;margin:8vh auto"><div style="display:flex;justify-content:space-between;align-items:center"><h2>فاکتور</h2><button class="btn btn-secondary" id="invoiceTypeClose">بستن</button></div><div class="form-grid" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-top:16px"><button class="btn btn-primary" data-new-invoice-type="sale">فروش</button><button class="btn btn-primary" data-new-invoice-type="purchase">خرید</button><button class="btn btn-secondary" data-new-invoice-type="return-sale">برگشت از فروش</button><button class="btn btn-secondary" data-new-invoice-type="return-purchase">برگشت از خرید</button><button class="btn btn-secondary" data-new-invoice-type="proforma">پیش‌فاکتور</button></div></div>`;
 document.body.appendChild(overlay);
 overlay.querySelector('#invoiceTypeClose')!.addEventListener('click',()=>overlay.remove());
 overlay.querySelectorAll<HTMLButtonElement>('[data-new-invoice-type]').forEach(b=>b.addEventListener('click',()=>{
  const type=b.dataset.newInvoiceType as InvoiceType;
  if(!['sale','purchase','return-sale','return-purchase','proforma'].includes(type))return;
  activeInvoiceType=type;
  overlay.remove();
  editingInvoiceId=null;
  openCommercePanelSheet(isSaleInvoiceType(type)?'sale':'purchase');
 }));
}
function bindInvoiceProductSearch(root:ParentNode=document):void {
  const scope = root instanceof Element ? root : document;
  const searchInput = scope.querySelector<HTMLInputElement>('#invoiceProductSearch') || el<HTMLInputElement>('#invoiceProductSearch');
  const addBtn = scope.querySelector<HTMLButtonElement>('#invoiceProductAdd') || el<HTMLButtonElement>('#invoiceProductAdd');
  const addLineBtn = scope.querySelector<HTMLButtonElement>('#invoiceAddLine') || el<HTMLButtonElement>('#invoiceAddLine');
  const scanBtn = scope.querySelector<HTMLButtonElement>('#invoiceScanOpen') || el<HTMLButtonElement>('#invoiceScanOpen');
  const suggestions = scope.querySelector<HTMLDivElement>('#invoiceProductSuggestions') || el<HTMLDivElement>('#invoiceProductSuggestions');
  if (!searchInput) return;

  // جلوگیری از دوباره‌اتصال با پرچم
  if (searchInput.dataset.searchBound === '1') {
    // فقط اگر قبلاً به همین نود وصل شده، رد شو — بعد از انتقال DOM پرچم را پاک می‌کنیم
  }
  searchInput.dataset.searchBound = '1';

  let suggestionIndex = 0;

  const hideSuggestions = () => {
    const box = scope.querySelector<HTMLDivElement>('#invoiceProductSuggestions') || el<HTMLDivElement>('#invoiceProductSuggestions');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  };

  const showSuggestions = (value: string) => {
    const host = scope.querySelector<HTMLDivElement>('#invoiceProductSuggestions') || el<HTMLDivElement>('#invoiceProductSuggestions');
    if (!host) return;
    const matches = invoiceProductMatches(value);
    if (!matches.length) {
      host.innerHTML = value.trim()
        ? `<button type="button" class="invoice-product-suggestion" data-invoice-product-create="1"><span><b>کالا پیدا نشد</b><small>برای تعریف «${esc(value.trim())}» کلیک کنید</small></span></button>`
        : '';
      host.hidden = !value.trim();
      host.querySelectorAll('[data-invoice-product-create]').forEach(b => b.addEventListener('click', () => {
        hideSuggestions();
        addBySearch();
      }));
      return;
    }
    host.innerHTML = matches.map((p, i) =>
      `<button type="button" class="invoice-product-suggestion ${i === suggestionIndex ? 'active' : ''}" role="option" data-invoice-product-choice="${esc(p.id)}">` +
      `<span><b>${esc(p.name)}</b><small>${esc(p.code || p.sku || 'بدون کد')} · ${esc(p.unit || 'عدد')}</small></span>` +
      `<span class="suggestion-stock">موجودی ${fa(Number(p.systemQty) || 0)}</span></button>`
    ).join('');
    host.hidden = false;
    host.querySelectorAll<HTMLButtonElement>('[data-invoice-product-choice]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = b.dataset.invoiceProductChoice;
        if (id) {
          addProductToInvoice(id, true);
          hideSuggestions();
          searchInput.value = '';
          searchInput.focus({ preventScroll: true });
        }
      });
    });
  };

  const addBySearch = () => {
    const value = (searchInput.value || '').trim();
    if (!value) { toast('نام کالا یا بارکد را وارد کنید.', 'error'); return; }
    const byCode = findProductByCode(digits(value));
    const product = byCode || resolveInvoiceProduct(value);
    if (!product) {
      const looksLikeBarcode = /^[0-9۰-۹٠-٩\-\s]{4,}$/.test(value);
      offerAddProduct(value, {
        asName: !looksLikeBarcode,
        onSaved: (productId) => {
          addProductToInvoice(productId, true);
          searchInput.value = '';
          hideSuggestions();
          toast('کالا تعریف شد و به اقلام فاکتور اضافه شد.', 'success');
        },
      });
      return;
    }
    addProductToInvoice(product.id, true);
    searchInput.value = '';
    hideSuggestions();
    const status = scope.querySelector<HTMLElement>('#invoiceScanStatus') || el<HTMLElement>('#invoiceScanStatus');
    if (status) status.textContent = `✓ ${product.name} اضافه شد`;
  };

  // حذف لیسنر قبلی با clone فقط برای خود دکمه‌ها اگر لازم باشد — به‌جای آن onclick مستقیم
  searchInput.oninput = () => {
    suggestionIndex = 0;
    showSuggestions(searchInput.value);
  };
  searchInput.onkeydown = (event: KeyboardEvent) => {
    const matches = invoiceProductMatches(searchInput.value);
    if (event.key === 'ArrowDown' && matches.length) {
      event.preventDefault();
      suggestionIndex = Math.min(matches.length - 1, suggestionIndex + 1);
      showSuggestions(searchInput.value);
    } else if (event.key === 'ArrowUp' && matches.length) {
      event.preventDefault();
      suggestionIndex = Math.max(0, suggestionIndex - 1);
      showSuggestions(searchInput.value);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = matches[suggestionIndex] || resolveInvoiceProduct(searchInput.value);
      if (chosen) {
        addProductToInvoice(chosen.id, true);
        searchInput.value = '';
        hideSuggestions();
      } else {
        addBySearch();
      }
    } else if (event.key === 'Escape') {
      hideSuggestions();
    }
  };
  searchInput.onfocus = () => {
    if (searchInput.value.trim()) showSuggestions(searchInput.value);
  };

  if (addBtn) {
    addBtn.onclick = (ev) => {
      ev.preventDefault();
      addBySearch();
    };
  }
  if (addLineBtn) {
    addLineBtn.onclick = (ev) => {
      ev.preventDefault();
      addInvoiceLine();
    };
  }
  if (scanBtn) {
    scanBtn.onclick = () => {
      const continuous = el<HTMLInputElement>('#scannerContinuous');
      (window as any).__anbarinScannerContinuousBeforeInvoice = continuous?.checked ?? true;
      if (continuous) continuous.checked = true;
      (window as any).__anbarinInvoiceScanActive = true;
      openScanner({ title: 'اسکن پیوسته بارکد کالا برای فاکتور' });
    };
  }

  if (!products.length) {
    const status = scope.querySelector<HTMLElement>('#invoiceScanStatus') || el<HTMLElement>('#invoiceScanStatus');
    if (status) status.textContent = 'کالایی در سیستم نیست؛ ابتدا در بخش کالاها تعریف کنید یا نام جدید بزنید و افزودن کنید.';
  }
}

function openInvoiceItemsSheet():void {
  const scope = document.getElementById('commercePanelSheet') || document.getElementById('accountingCommerceWorkspace') || document;
  const placeholder = (scope.querySelector('#invoiceItemsPlaceholder') || document.querySelector('#invoiceItemsPlaceholder')) as HTMLElement | null;
  if (!placeholder) { toast('فرم فاکتور هنوز آماده نیست.', 'error'); return; }
  document.getElementById('invoiceItemsSheet')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'invoiceItemsSheet';
  overlay.dir = 'rtl';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10120;background:var(--surface,#fff);color:var(--text,#222);overflow:auto;padding:clamp(12px,3vw,28px)';
  overlay.innerHTML = `<div style="max-width:1100px;margin:0 auto"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h2>اقلام فاکتور</h2><button class="btn btn-primary" id="invoiceItemsBack">تأیید و بازگشت</button></div><div id="invoiceItemsMount" style="margin-top:14px"></div></div>`;
  document.body.appendChild(overlay);
  const mount = overlay.querySelector<HTMLElement>('#invoiceItemsMount')!;
  const pick = (sel: string) => (scope.querySelector(sel) || document.querySelector(sel)) as HTMLElement | null;
  ['.commerce-lines-head', '.invoice-product-tools', '#commerceInvoiceLines', '#invoiceAddLine'].forEach(sel => {
    const node = pick(sel);
    if (node) mount.appendChild(node);
  });
  // پرچم جستجو را پاک کن تا دوباره وصل شود
  const search = mount.querySelector<HTMLInputElement>('#invoiceProductSearch');
  if (search) delete search.dataset.searchBound;

  if (!mount.querySelector('#commerceInvoiceLines .commerce-line')) {
    addInvoiceLine();
  }

  bindInvoiceProductSearch(mount);

  if (search) {
    search.placeholder = 'نام کالا یا بارکد — جستجو کنید';
    search.focus({ preventScroll: true });
  }

  overlay.querySelector('#invoiceItemsBack')!.addEventListener('click', () => {
    ['.commerce-lines-head', '.invoice-product-tools', '#commerceInvoiceLines', '#invoiceAddLine'].forEach(sel => {
      const node = mount.querySelector<HTMLElement>(sel);
      if (node) placeholder.appendChild(node);
    });
    // بعد از برگشت پرچم را پاک کن
    const s = placeholder.querySelector<HTMLInputElement>('#invoiceProductSearch');
    if (s) delete s.dataset.searchBound;
    overlay.remove();
    updateInvoiceTotals();
    const count = document.querySelectorAll('#commerceInvoiceLines .commerce-line').length;
    const summary = document.querySelector('#invoiceItemsSummary') as HTMLElement | null;
    if (summary) summary.textContent = count ? `${fa(count)} قلم` : 'بدون قلم';
  });
}

async function render():Promise<void> {
  const root=el<HTMLDivElement>('#accountingCommerceWorkspace'); if(!root||!commerce)return;
  const reopenSheet: CommercePanelSection | null = activeCommerceSection!=='home' ? activeCommerceSection : null;
  // هنگام ذخیره پیش‌نویس/تسویه برگه باز را خراب نکن
  if(!suppressCommerceSheetReopen){
    document.getElementById('commercePanelSheet')?.remove();
    document.getElementById('invoiceItemsSheet')?.remove();
    if(!document.getElementById('accountingModuleSheet')){
      document.body.classList.remove('accounting-sheet-open');
    }
  }
  root.setAttribute('dir','rtl');
  root.innerHTML=`
  <div class="commerce-home" ${activeCommerceSection==='home'?'':'hidden'}>
    <p class="hint">هر عملیات بازرگانی در برگه تمام‌صفحه جدا باز می‌شود.</p>
    <div class="accounting-home-grid" role="navigation" aria-label="بخش‌های بازرگانی">
      <button type="button" class="accounting-home-tile" id="openInvoiceTypeSheet"><span class="accounting-home-icon invoice" aria-hidden="true">🧾</span><strong>فاکتور</strong><span class="hint">فروش، خرید، برگشت و پیش‌فاکتور</span></button>
      <button type="button" class="accounting-home-tile" data-commerce-tab="parties"><span class="accounting-home-icon party" aria-hidden="true">👤</span><strong>طرف حساب‌ها</strong><span class="hint">تعریف مشتری و تأمین‌کننده</span></button>
      <button type="button" class="accounting-home-tile" data-commerce-tab="receipts"><span class="accounting-home-icon receipt" aria-hidden="true">💵</span><strong>دریافت / پرداخت</strong><span class="hint">نقد، کارت، چک و تخصیص</span></button>
      <button type="button" class="accounting-home-tile" data-commerce-tab="banking"><span class="accounting-home-icon banking" aria-hidden="true">🏦</span><strong>بانک</strong><span class="hint">حساب بانکی و صورت‌حساب</span></button>
      <button type="button" class="accounting-home-tile" data-commerce-tab="operating"><span class="accounting-home-icon expense" aria-hidden="true">📒</span><strong>هزینه و درآمد</strong><span class="hint">ثبت هزینه و درآمد متفرقه</span></button>
      <button type="button" class="accounting-home-tile" data-commerce-tab="inventory"><span class="accounting-home-icon inventory" aria-hidden="true">📦</span><strong>انبار</strong><span class="hint">بهای موجودی و تطبیق</span></button>
    </div>
  </div>
  <section data-commerce-section="invoices" ${activeCommerceSection==='sale'||activeCommerceSection==='purchase'?'':'hidden'}>
  <header class="commerce-page-header"><div><h2>${invoiceTypeTitle(activeInvoiceType)}</h2></div><span class="commerce-page-chip">${activeCommerceSection==='sale'?'فروش':'خرید'}</span></header>
  <div class="card commerce-invoice-card" style="margin-top:12px">
<h3 id="invoiceFormTitle">${invoiceTypeTitle(activeInvoiceType)}</h3>
<div class="form-grid invoice-header-grid">
<input type="hidden" id="invoiceType" value="${activeInvoiceType}">
<label class="field">شماره<input id="invoiceNumber" value="${esc(nextInvoiceNumber(activeInvoiceType))}" placeholder="شماره" autocomplete="off"></label>
<label class="field">${isSaleInvoiceType(activeInvoiceType)?'خریدار':'فروشنده'}
<div style="display:flex;gap:6px;align-items:stretch">
<select id="invoiceParty" style="flex:1"><option value="">انتخاب</option>${partyOptions(isSaleInvoiceType(activeInvoiceType)?'customer':'supplier')}</select>
<button type="button" class="btn btn-sm btn-secondary" id="invoiceAddParty" title="اگر شخص در فهرست نیست، اینجا تعریف کنید">+ شخص</button>
</div>
</label>
<label class="field">تاریخ<div class="invoice-jalali-date"><input id="invoiceDate" value="${todayJalali()}" placeholder="1405/01/01" autocomplete="off" inputmode="numeric"><button type="button" class="btn btn-secondary jalali-cal-btn" id="invoiceJalaliCalendar" aria-label="تقویم" title="تقویم شمسی">▦</button><div id="invoiceJalaliCalendarPanel" class="invoice-jalali-calendar" hidden></div></div></label>
<input type="hidden" id="invoicePaymentTerms" value=""><select hidden aria-hidden="true"></select><input type="hidden" id="invoiceDescription">
</div>

<div class="invoice-items-block">
<div class="invoice-items-toolbar">
<b>اقلام</b>
<button type="button" class="btn btn-sm btn-secondary" id="invoiceOpenItems">برگه اقلام</button>
</div>
<div id="invoiceItemsSummary" class="hint" style="margin:4px 0 8px"></div>
<div id="invoiceItemsPlaceholder" hidden>
<div class="commerce-lines-head"><b>اقلام</b></div>
<div class="invoice-product-tools invoice-product-tools-compact">
<div class="invoice-live-search"><label class="field">کالا / بارکد<input id="invoiceProductSearch" autocomplete="off" placeholder="نام یا بارکد"></label><div id="invoiceProductSuggestions" class="invoice-product-suggestions" role="listbox" hidden></div></div>
<button class="btn btn-secondary" id="invoiceProductAdd" type="button">افزودن</button>
<button class="btn btn-primary" id="invoiceScanOpen" type="button">اسکن</button>
<input type="hidden" id="invoiceBarcodeInput">
<small id="invoiceScanStatus" class="hint" role="status" aria-live="polite"></small>
</div>
<div id="commerceInvoiceLines"></div>
<datalist id="anbarin-invoice-unit-list">
  <option value="عدد"></option>
  <option value="کیلوگرم"></option>
  <option value="گرم"></option>
  <option value="لیتر"></option>
  <option value="میلی‌لیتر"></option>
  <option value="متر"></option>
  <option value="سانتی‌متر"></option>
  <option value="مترمربع"></option>
  <option value="جفت"></option>
  <option value="دست"></option>
  <option value="شاخه"></option>
  <option value="رول"></option>
  <option value="قوطی"></option>
  <option value="بسته"></option>
  <option value="کارتن"></option>
  <option value="جعبه"></option>
  <option value="گونی"></option>
  <option value="پالت"></option>
</datalist>
<button class="btn btn-sm btn-secondary" id="invoiceAddLine" type="button">ردیف خالی</button>
</div>
</div>

<details class="card invoice-details-panel" style="margin-top:14px"><summary>مالیات</summary>
<div class="form-grid invoice-details-grid" style="margin-top:12px">
<label class="field">نرخ مالیات (%)<input id="invoiceTaxRate" inputmode="decimal" value="0" placeholder="۰"></label>
<label class="field">مبلغ مالیات<input id="invoiceTax" inputmode="numeric" value="0"></label>
<label class="field">توضیحات چاپی<textarea id="invoiceNotes" rows="2" placeholder="اختیاری"></textarea></label>
</div>
<input type="hidden" id="invoiceDescriptionVisible" value="">
<input type="hidden" id="invoiceDueDate" value=""><div id="invoicePaymentRows" hidden></div><div id="invoicePaymentSummary" class="hint" hidden></div>
</details>
${activeInvoiceType==='purchase'?`<details class="card invoice-details-panel" style="margin-top:10px" open><summary>هزینه‌های جانبی خرید (Landed Cost)</summary>
<div class="form-grid invoice-details-grid" style="margin-top:12px">
<label class="field">حمل و نقل<input id="invoiceLandedFreight" inputmode="numeric" value="0" placeholder="۰"></label>
<label class="field">گمرک و ترخیص<input id="invoiceLandedCustoms" inputmode="numeric" value="0" placeholder="۰"></label>
<label class="field">بیمه<input id="invoiceLandedInsurance" inputmode="numeric" value="0" placeholder="۰"></label>
<label class="field">سایر هزینه‌ها<input id="invoiceLandedOther" inputmode="numeric" value="0" placeholder="۰"></label>
<label class="field" style="grid-column:1/-1">شرح هزینه جانبی<input id="invoiceLandedNote" placeholder="مثلاً باربری مسیر تهران — اختیاری"></label>
</div>
<p class="hint" style="margin:8px 0 0">این مبالغ طبق استاندارد به <b>بهای تمام‌شده موجودی</b> اضافه می‌شوند (نه هزینه دوره). تخصیص به‌نسبت مبلغ ردیف‌های کالا انجام می‌شود. بدهی در حساب «هزینه‌های جانبی خرید پرداختنی» ثبت می‌گردد.</p>
<div class="hint" id="invoiceLandedTotalPreview" style="margin-top:6px">جمع هزینه جانبی: —</div>
</details>`:''}

<div class="commerce-invoice-summary">
<div><span>جمع</span><b id="invoiceNetPreview">—</b></div>
<div><span>مالیات</span><b id="invoiceTaxPreview">—</b></div>
${activeInvoiceType==='purchase'?`<div><span>هزینه جانبی</span><b id="invoiceLandedSummary">—</b></div>`:''}
<div class="grand"><span>مبلغ نهایی</span><b id="invoiceGrossPreview">—</b></div>
</div>
${activeInvoiceType==='sale'?`<div id="invoiceInternalProfitPanel" class="commerce-invoice-summary invoice-internal-profit-panel" style="margin-top:8px;border:1px dashed var(--border,#b9ddc2);background:var(--primary-soft,#e5f3e8)">
<div><span>بهای تمام‌شده (داخلی)</span><b id="invoiceCogsPreview">—</b></div>
<div><span>سود ناخالص (داخلی)</span><b id="invoiceGrossProfitPreview">—</b></div>
<div class="grand"><span>حاشیه سود</span><b id="invoiceMarginPreview">—</b></div>
<p class="hint" style="grid-column:1/-1;margin:4px 0 0">فقط برای کاربر داخلی — در چاپ مشتری و اشتراک نمایش داده نمی‌شود. برآورد بر اساس بهای موجودی فعلی است.</p>
</div>`:''}
<div class="invoice-action-bar">
<button class="btn btn-secondary" id="invoiceSave" type="button">پیش‌نویس</button>
<button class="btn btn-primary" id="invoiceSettle" type="button" ${activeInvoiceType==='proforma'?'hidden':''}>تسویه</button>
<button class="btn btn-secondary" id="invoicePrint" type="button" title="چاپ مشتری (بدون سود)">چاپ مشتری</button>
${activeInvoiceType==='sale'?`<button class="btn btn-secondary" id="invoicePrintInternal" type="button" title="چاپ داخلی با سود ناخالص">چاپ داخلی</button>`:''}
<button class="btn btn-secondary" id="invoiceShare" type="button" title="اشتراک در پیام‌رسان (بدون سود)">اشتراک</button>
<button class="btn btn-secondary" id="invoiceCancelEdit" type="button" hidden>لغو</button>
</div>
<div class="invoice-registered-block">
<h4 class="invoice-registered-title">فاکتورهای ثبت‌شده</h4>
<div class="table-wrap invoice-list-wrap"><table class="data-table invoice-list-table"><thead><tr><th>شماره</th><th>${activeCommerceSection==='sale'?'مشتری':'تأمین‌کننده'}</th><th>تاریخ</th><th>مبلغ</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${invoiceRows(activeInvoiceType)}</tbody></table></div>
${invoiceListFooter(activeInvoiceType)}
</div></div>
  </section>
  <section data-commerce-section="management" ${activeCommerceSection==='management'?'':'hidden'}>
    ${activeCommerceSection==='management'?await managementDashboardPanel():''}
    ${activeCommerceSection==='management'?await profitabilityPanel():''}
    ${activeCommerceSection==='management'?await inventoryMarginAnalyticsPanel():''}
    ${activeCommerceSection==='management'?await cashflowPanel():''}
  </section>
  <section data-commerce-section="inventory" ${activeCommerceSection==='inventory'?'':'hidden'}>
    ${activeCommerceSection==='inventory'?await openingStockPanel():''}
    ${activeCommerceSection==='inventory'?await inventoryStandardCostPanel():''}
    ${activeCommerceSection==='inventory'?await inventoryNrvPanel():''}
    ${activeCommerceSection==='inventory'?await inventoryReconciliationPanel():''}
  </section>
  <section data-commerce-section="receipts" ${activeCommerceSection==='receipts'?'':'hidden'}>
  <div class="card cash-entry-card" dir="rtl" style="margin-top:12px;text-align:right">
<h3>دریافت / پرداخت</h3>
<div class="form-grid cash-entry-grid">
<label class="field">نوع<select id="cashType"><option value="receipt">دریافت</option><option value="payment">پرداخت</option></select></label>
<label class="field">شماره<input id="cashNumber" placeholder="خودکار یا دستی"></label>
<label class="field">طرف حساب<select id="cashParty"><option value="">انتخاب</option>${partyOptions('customer')}</select></label>
<label class="field">روش<select id="cashMethod"><option value="cash">نقدی</option><option value="bank">بانک</option><option value="card">کارت</option><option value="transfer">حواله</option><option value="cheque">چک</option></select></label>
<label class="field">حساب<select id="cashAccount"><option value="">صندوق / بانک</option>${accountOptions()}</select></label>
<label class="field">فاکتور<select id="cashInvoice"><option value="">بدون تخصیص</option></select></label>
<label class="field">تاریخ<input id="cashDate" placeholder="1405/01/01"></label>
<label class="field">مبلغ<input id="cashAmount" inputmode="decimal" placeholder="۰"></label>
<input type="hidden" id="cashAllocation" value="">
<input type="hidden" id="cashDescription" value="">
<label class="field cash-cheque-only" data-cheque-field hidden style="display:none">شماره چک *<input id="cashChequeNumber" autocomplete="off"></label>
<label class="field cash-cheque-only" data-cheque-field hidden style="display:none">بانک *<input id="cashChequeBank" autocomplete="off"></label>
<label class="field cash-cheque-only" data-cheque-field hidden style="display:none">شماره صیادی *<input id="cashChequeAccount" autocomplete="off" placeholder="شناسه صیادی ۱۶ یا ۲۰ رقمی" inputmode="numeric"></label>
<label class="field cash-cheque-only" data-cheque-field hidden style="display:none">سررسید چک *<input id="cashChequeDue" placeholder="1405/01/30" inputmode="numeric" autocomplete="off"></label>
<label class="field cash-cheque-only" data-cheque-field hidden style="display:none">توضیحات چک<input id="cashChequeNote" autocomplete="off"></label>
</div>
<button class="btn btn-primary" id="cashSave" type="button">ثبت</button>
<div class="table-wrap" style="margin-top:14px"><table class="data-table"><thead><tr><th>شماره</th><th>نوع</th><th>طرف</th><th>تاریخ</th><th>مبلغ</th><th>وضعیت</th><th></th></tr></thead><tbody>${cashRows()}</tbody></table></div>
</div>
  </section>
  <section data-commerce-section="parties" ${activeCommerceSection==='parties'?'':'hidden'}>${activeCommerceSection==='parties'?partiesPanelHtml():''}</section>
  <section data-commerce-section="operating" ${activeCommerceSection==='operating'?'':'hidden'}>${activeCommerceSection==='operating'?await operatingPanelHtml():''}</section>
  <section data-commerce-section="cheques" ${activeCommerceSection==='cheques'?'':'hidden'}>${activeCommerceSection==='cheques'?await chequePanel():''}</section>
  <section data-commerce-section="aging" ${activeCommerceSection==='aging'?'':'hidden'}>${activeCommerceSection==='aging'?await agingPanel():''}</section>
  <section data-commerce-section="banking" ${activeCommerceSection==='banking'?'':'hidden'}>${activeCommerceSection==='banking'?await bankPanel():''}</section>`;
  const itemPlaceholder=root.querySelector<HTMLElement>('#invoiceItemsPlaceholder');
  if(itemPlaceholder){['.commerce-lines-head','.invoice-product-tools','#commerceInvoiceLines','#invoiceAddLine'].forEach(sel=>{const node=root.querySelector<HTMLElement>(sel);if(node)itemPlaceholder.appendChild(node);});}
  root.querySelectorAll<HTMLButtonElement>('[data-commerce-tab]').forEach(button=>button.addEventListener('click',()=>{
    const next=button.dataset.commerceTab as CommercePanelSection;
    if(next) openCommercePanelSheet(next);
  }));
  if(activeCommerceSection==='sale'||activeCommerceSection==='purchase'){
    addInvoiceLine(); addInvoicePaymentRow();
  }
  bind();
  enhanceCommerceSelects();
  void applyDefaultPartySelection();
  if(!suppressCommerceSheetReopen && reopenSheet){
    await openCommercePanelSheet(reopenSheet);
  }
}

/** کادرهای انتخاب طولانی (طرف‌حساب، کالا، حساب) را جستجوپذیر می‌کند */
function enhanceCommerceSelects():void {
  const map: { id: string; placeholder: string; min?: number }[] = [
    { id: 'invoiceParty', placeholder: 'جستجوی طرف حساب...' },
    { id: 'cashParty', placeholder: 'جستجوی طرف حساب...' },
    { id: 'cashAccount', placeholder: 'جستجوی حساب صندوق/بانک...', min: 6 },
    { id: 'cashInvoice', placeholder: 'جستجوی فاکتور...', min: 6 },
    { id: 'opParty', placeholder: 'جستجوی طرف حساب...' },
    { id: 'openingCostProduct', placeholder: 'جستجوی کالا...', min: 0 },
  ];
  for (const item of map) {
    const sel = document.getElementById(item.id) as HTMLSelectElement | null;
    if (!sel) continue;
    enhanceSelectWithSearch(sel, { placeholder: item.placeholder, minOptions: item.min ?? 8 });
    refreshSearchableSelect(sel);
  }
  bindPartySmsButtons();
}

async function persist(next:CommerceData):Promise<void>{commerce=next;await saveCommerceData(next);render()}
function refreshAccounting():void{window.dispatchEvent(new Event('accounting:data-updated'))}
function startInvoiceEdit(invoiceId:string):void {
  if(!commerce)return;
  const invoice=commerce.invoices.find(i=>i.id===invoiceId);
  if(!invoice)return;
  if(invoice.status!=='draft'){toast('فاکتور قطعی قابل ویرایش مستقیم نیست؛ برای حفظ سند و گردش انبار باید اصلاحیه ثبت شود.','error');return;}
  editingInvoiceId=invoice.id;
  const set=(selector:string,value:string)=>{const node=el<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(selector);if(node)node.value=value};
  activeInvoiceType=invoice.type; activeCommerceSection=isSaleInvoiceType(invoice.type)?'sale':'purchase'; set('#invoiceType',invoice.type);
  {
    const partySel=el<HTMLSelectElement>('#invoiceParty');
    if(partySel){
      partySel.innerHTML='<option value="">انتخاب طرف حساب</option>'+partyOptions(isSaleInvoiceType(invoice.type)?'customer':'supplier');
      refreshSearchableSelect(partySel);
    }
  }
  set('#invoiceNumber',invoice.number);set('#invoiceParty',invoice.partyId);set('#invoiceDate',invoice.date);set('#invoiceDueDate','');const paymentHost=el<HTMLDivElement>('#invoicePaymentRows');if(paymentHost)paymentHost.innerHTML='';set('#invoicePaymentTerms','تسویه از برگه مستقل انجام می‌شود');set('#invoiceDescription',invoice.description);set('#invoiceDescriptionVisible',invoice.description);set('#invoiceNotes',invoice.notes||'');set('#invoiceTaxRate',String((invoice.taxRateBps||0)/100));set('#invoiceTax',formatMoneyFromRial(invoice.taxRial,currency));
  if(invoice.type==='purchase'){
    const lc=invoice.landedCosts;
    set('#invoiceLandedFreight',formatMoneyFromRial(lc?.freightRial||0,currency));
    set('#invoiceLandedCustoms',formatMoneyFromRial(lc?.customsRial||0,currency));
    set('#invoiceLandedInsurance',formatMoneyFromRial(lc?.insuranceRial||0,currency));
    set('#invoiceLandedOther',formatMoneyFromRial(lc?.otherRial||0,currency));
    set('#invoiceLandedNote',lc?.note||'');
  }
  const host=el<HTMLDivElement>('#commerceInvoiceLines')!;host.innerHTML='';
  for(const line of invoice.lines){
    addInvoiceLine(line.productId||undefined);
    const row=host.lastElementChild as HTMLElement;
    const put=(selector:string,value:string)=>{const node=row.querySelector<HTMLInputElement|HTMLSelectElement>(selector);if(node)node.value=value};
    put('[data-line-desc]',line.description);
    put('[data-line-unit]',line.unit||'عدد');
    put('[data-line-qty]',String(line.quantityMilli/1000));
    put('[data-line-price]',formatMoneyFromRial(line.unitPriceRial,currency));
    put('[data-line-discount]',formatMoneyFromRial(line.discountRial||0,currency));
    const descField=row.querySelector<HTMLInputElement>('[data-line-desc]');
    const descLabel=descField?.closest('label') as HTMLElement|null;
    if(descLabel)descLabel.hidden=!!line.productId;
    const stockField=row.querySelector<HTMLElement>('.invoice-stock-field');
    if(stockField)stockField.hidden=!line.productId;
  }
  updateInvoiceTotals();
  const save=el<HTMLButtonElement>('#invoiceSave');if(save)save.textContent='ذخیره پیش‌نویس';const cancel=el<HTMLButtonElement>('#invoiceCancelEdit');if(cancel)cancel.hidden=false;
  el<HTMLElement>('#invoiceFormTitle')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function cancelInvoiceEdit():void {editingInvoiceId=null;render()}

function bind():void {
  queueMicrotask(()=>enhanceDateFields(document));
  const updateMonthComparison=()=>{const first=el<HTMLSelectElement>('#managementCompareFirst')?.value||'';const second=el<HTMLSelectElement>('#managementCompareSecond')?.value||'';const host=el<HTMLDivElement>('#managementMonthComparison');if(!host)return;const metrics=[['فروش قطعی','salesRial'],['سود ناخالص','grossProfitRial'],['هزینه ثبت‌شده گروه ۶','expensesRial'],['دریافت قطعی','receiptsRial'],['پرداخت قطعی','paymentsRial'],['مانده فعلی مطالبات','receivableRial']] as const;const rows=(window as any).__anbarinManagementCompareRows as Array<Record<string,any>>|undefined;const a=rows?.find(x=>x.month===first),b=rows?.find(x=>x.month===second);if(!a||!b){host.innerHTML='<p class="hint">برای مقایسه، داده ماهانه کافی وجود ندارد.</p>';return;}host.innerHTML=`<div class="table-wrap"><table class="data-table"><thead><tr><th>شاخص</th><th>${first}</th><th>${second}</th><th>اختلاف (ماه دوم − اول)</th><th>تغییر درصدی</th></tr></thead><tbody>${metrics.map(([label,key])=>{const av=Number(a[key]||0),bv=Number(b[key]||0),delta=bv-av,pct=av===0?null:delta/Math.abs(av)*100;return `<tr><td>${label}</td><td>${money(av)}</td><td>${money(bv)}</td><td>${delta>0?'+':''}${money(delta)}</td><td>${pct===null?'—':`${pct>0?'+':''}${pct.toFixed(1)}٪`}</td></tr>`}).join('')}</tbody></table></div><p class="hint">درصد تغییر نسبت به ماه اول محاسبه می‌شود؛ اگر مقدار ماه اول صفر باشد، درصد تغییر قابل محاسبه نیست.</p>`;};
  document.querySelectorAll<HTMLSelectElement>('#managementCompareFirst,#managementCompareSecond').forEach(select=>select.addEventListener('change',updateMonthComparison));
  el<HTMLSelectElement>('#managementAnomalyThreshold')?.addEventListener('change',()=>{const threshold=Number(el<HTMLSelectElement>('#managementAnomalyThreshold')?.value||20);const host=el<HTMLDivElement>('#managementAnomalyAlerts');if(!host)return;const rows=(window as any).__anbarinManagementCompareRows as ManagementMonthRow[]|undefined;const alerts=detectManagementMonthAnomalies(rows||[],threshold);host.innerHTML=alerts.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>وضعیت</th><th>شاخص</th><th>بازه مقایسه</th><th>مقدار قبلی</th><th>مقدار جدید</th><th>تغییر</th></tr></thead><tbody>${alerts.map(a=>`<tr><td>${a.severity==='warning'?'نیازمند بررسی':'بهبود'}</td><td>${a.label}</td><td>${esc(a.previousMonth)} ← ${esc(a.month)}</td><td>${money(a.previousValue)}</td><td>${money(a.currentValue)}</td><td>${a.percentChange>0?'+':''}${a.percentChange.toFixed(1)}٪</td></tr>`).join('')}</tbody></table></div><p class="hint">کاهش فروش/سود/دریافت و افزایش هزینه/پرداخت/مطالبات نیازمند بررسی است.</p>`:'<p class="hint">در آستانه انتخابی تغییر غیرعادی معناداری پیدا نشد؛ ماه‌های با مبنای صفر برای جلوگیری از درصد گمراه‌کننده نادیده گرفته می‌شوند.</p>'});
  document.querySelectorAll<HTMLButtonElement>('[data-management-month]').forEach(button=>button.addEventListener('click',()=>{const month=button.dataset.managementMonth||'';const detail=el<HTMLElement>(`#managementMonthDetail_${month.replace('/','')}`);if(!detail)return;const opening=detail.hidden;detail.hidden=!opening;button.setAttribute('aria-expanded',String(opening));button.textContent=`${opening?'بستن جزئیات':'مشاهده جزئیات'} ${month}`;}));
  document.querySelectorAll<HTMLButtonElement>('[data-management-month-xlsx]').forEach(button=>button.addEventListener('click',async()=>{try{await exportManagementMonthXlsx(button.dataset.managementMonthXlsx||'',button.dataset.managementMonthFrom||'',button.dataset.managementMonthTo||'');toast('فایل Excel جزئیات ماه آماده شد','success')}catch(e){toast(e instanceof Error?e.message:'ساخت Excel جزئیات ماه ناموفق بود','error')}}));
  document.querySelectorAll<HTMLButtonElement>('[data-management-month-pdf]').forEach(button=>button.addEventListener('click',async()=>{try{await printManagementMonthPdf(button.dataset.managementMonthPdf||'',button.dataset.managementMonthFrom||'',button.dataset.managementMonthTo||'')}catch(e){toast(e instanceof Error?e.message:'آماده‌سازی PDF جزئیات ماه ناموفق بود','error')}}));
  el<HTMLButtonElement>('#managementApplyFilter')?.addEventListener('click',()=>{const next:ProfitabilityFilter={fiscalPeriodId:el<HTMLSelectElement>('#managementPeriod')?.value||'',fromDate:digits(el<HTMLInputElement>('#managementFrom')?.value||''),toDate:digits(el<HTMLInputElement>('#managementTo')?.value||'')};if(!next.fiscalPeriodId)delete next.fiscalPeriodId;if(!next.fromDate)delete next.fromDate;if(!next.toDate)delete next.toDate;if(next.fromDate&&next.toDate&&next.fromDate>next.toDate){toast('تاریخ شروع داشبورد نباید بعد از تاریخ پایان باشد','error');return}managementFilter=next;render()});
  el<HTMLButtonElement>('#managementClearFilter')?.addEventListener('click',()=>{managementFilter={};render()});
  el<HTMLButtonElement>('#managementExportXlsx')?.addEventListener('click',async()=>{try{await exportManagementDashboardXlsx(managementFilter);toast('فایل Excel داشبورد آماده شد','success')}catch(e){toast(e instanceof Error?e.message:'ساخت Excel داشبورد ناموفق بود','error')}});
  el<HTMLButtonElement>('#managementPrintPdf')?.addEventListener('click',async()=>{try{await printManagementDashboardPdf(managementFilter)}catch(e){toast(e instanceof Error?e.message:'آماده‌سازی PDF داشبورد ناموفق بود','error')}});
  el<HTMLButtonElement>('#profitabilityApplyFilter')?.addEventListener('click',()=>{profitabilityFilter={fiscalPeriodId:el<HTMLSelectElement>('#profitabilityPeriod')?.value||'',fromDate:digits(el<HTMLInputElement>('#profitabilityFrom')?.value||''),toDate:digits(el<HTMLInputElement>('#profitabilityTo')?.value||'')};if(!profitabilityFilter.fiscalPeriodId)delete profitabilityFilter.fiscalPeriodId;if(!profitabilityFilter.fromDate)delete profitabilityFilter.fromDate;if(!profitabilityFilter.toDate)delete profitabilityFilter.toDate;if(profitabilityFilter.fromDate&&profitabilityFilter.toDate&&profitabilityFilter.fromDate>profitabilityFilter.toDate){toast('تاریخ شروع نباید بعد از تاریخ پایان باشد','error');return}render()});
  el<HTMLButtonElement>('#profitabilityClearFilter')?.addEventListener('click',()=>{profitabilityFilter={};render()});
  el<HTMLButtonElement>('#profitabilityExportXlsx')?.addEventListener('click',async()=>{try{await exportProfitabilityXlsx(profitabilityFilter);toast('فایل Excel گزارش سودآوری آماده شد','success')}catch(e){toast(e instanceof Error?e.message:'ساخت فایل Excel ناموفق بود','error')}});
  el<HTMLButtonElement>('#profitabilityPrintPdf')?.addEventListener('click',async()=>{try{await printProfitabilityPdf(profitabilityFilter)}catch(e){toast(e instanceof Error?e.message:'آماده‌سازی PDF ناموفق بود','error')}});
  el<HTMLButtonElement>('#bankTransferSave')?.addEventListener('click',async()=>{try{await createInternalTransfer({number:el<HTMLInputElement>('#bankTransferNo')!.value,date:digits(el<HTMLInputElement>('#bankTransferDate')!.value),fiscalPeriodId:await activeFiscalPeriodId(),fromAccountId:el<HTMLSelectElement>('#bankTransferFrom')!.value,toAccountId:el<HTMLSelectElement>('#bankTransferTo')!.value,amountRial:parseMoneyToRial(digits(el<HTMLInputElement>('#bankTransferAmount')!.value),currency),feeRial:parseMoneyToRial(digits(el<HTMLInputElement>('#bankTransferFee')!.value||'0'),currency),feeAccountId:el<HTMLSelectElement>('#bankTransferFeeAccount')!.value,description:el<HTMLInputElement>('#bankTransferDescription')!.value});await render();refreshAccounting();toast('انتقال بین حساب‌ها و سند حسابداری ثبت شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ثبت انتقال','error')}});
  el<HTMLButtonElement>('#bankStatementImport')?.addEventListener('click',async()=>{try{const file=el<HTMLInputElement>('#bankStatementFile')?.files?.[0];if(!file)throw new Error('ابتدا فایل CSV را انتخاب کنید.');const accountId=el<HTMLSelectElement>('#bankStatementAccount')!.value;const rows=parseBankStatementCsv(await file.text(),accountId);const result=await importBankStatement(rows);await render();toast(`${result.imported} ردیف وارد شد؛ ${result.matched} ردیف به‌صورت خودکار تطبیق یافت.`,'success')}catch(e){toast(e instanceof Error?e.message:'خطا در ورود صورت‌حساب','error')}});
  el<HTMLButtonElement>('#bankMoveSave')?.addEventListener('click',async()=>{
    try{
      const kind=(el<HTMLSelectElement>('#bankMoveKind')?.value||'deposit') as 'deposit'|'withdraw';
      await createCashBankMove({
        kind,
        number:el<HTMLInputElement>('#bankMoveNo')?.value||String(Date.now()).slice(-6),
        date:digits(el<HTMLInputElement>('#bankMoveDate')?.value||''),
        fiscalPeriodId:await activeFiscalPeriodId(),
        cashAccountId:el<HTMLSelectElement>('#bankMoveCash')?.value||'',
        bankAccountId:el<HTMLSelectElement>('#bankMoveBank')?.value||'',
        amountRial:parseMoneyToRial(digits(el<HTMLInputElement>('#bankMoveAmount')?.value||'0'),currency),
        description:el<HTMLInputElement>('#bankMoveDesc')?.value||'',
      });
      await render();refreshAccounting();
      toast(kind==='deposit'?'واریز نقد به بانک ثبت شد.':'برداشت از بانک به صندوق ثبت شد.','success');
    }catch(e){toast(e instanceof Error?e.message:'خطا در ثبت واریز/برداشت','error')}
  });
  el<HTMLButtonElement>('#bankFeeSave')?.addEventListener('click',async()=>{
    try{
      await createBankFee({
        number:el<HTMLInputElement>('#bankFeeNo')?.value||String(Date.now()).slice(-6),
        date:digits(el<HTMLInputElement>('#bankFeeDate')?.value||''),
        fiscalPeriodId:await activeFiscalPeriodId(),
        bankAccountId:el<HTMLSelectElement>('#bankFeeBank')?.value||'',
        feeAccountId:el<HTMLSelectElement>('#bankFeeExpense')?.value||'',
        amountRial:parseMoneyToRial(digits(el<HTMLInputElement>('#bankFeeAmount')?.value||'0'),currency),
        description:el<HTMLInputElement>('#bankFeeDesc')?.value||'',
      });
      await render();refreshAccounting();
      toast('کارمزد بانکی ثبت و سند صادر شد.','success');
    }catch(e){toast(e instanceof Error?e.message:'خطا در ثبت کارمزد','error')}
  });
  el<HTMLButtonElement>('#bankLedgerLoad')?.addEventListener('click',async()=>{
    try{
      const accountId=el<HTMLSelectElement>('#bankLedgerAccount')?.value||'';
      if(!accountId)throw new Error('حساب را انتخاب کنید.');
      const rows=await getBankAccountLedger(accountId);
      const body=el<HTMLElement>('#bankLedgerBody');
      if(!body)return;
      body.innerHTML=rows.slice(-120).reverse().map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.number)}</td><td>${esc(r.description)}</td><td>${money(r.debitRial)}</td><td>${money(r.creditRial)}</td><td>${money(r.balanceRial)}</td></tr>`).join('')
        ||'<tr><td colspan="6">گردشی برای این حساب ثبت نشده است.</td></tr>';
    }catch(e){toast(e instanceof Error?e.message:'خطا در بارگذاری دفتر','error')}
  });

  // پر کردن خودکار تعداد و بهای خرید هنگام انتخاب کالا
  el<HTMLSelectElement>('#openingCostProduct')?.addEventListener('change',()=>{
    const p=products.find(x=>x.id===el<HTMLSelectElement>('#openingCostProduct')!.value);
    if(!p)return;
    const qtyEl=el<HTMLInputElement>('#openingCostQty');
    const unitEl=el<HTMLInputElement>('#openingCostUnit');
    if(qtyEl) qtyEl.value=String(Number(p.systemQty)||0);
    const unit=Number(p.purchasePrice)||Number(p.price)||0;
    if(unitEl && unit>0) unitEl.value=String(unit);
  });
  el<HTMLButtonElement>('#openingCostSave')?.addEventListener('click',async()=>{try{
    const p=products.find(x=>x.id===el<HTMLSelectElement>('#openingCostProduct')!.value);
    if(!p)throw new Error('کالا را انتخاب کنید.');
    const qty=Number(digits(el<HTMLInputElement>('#openingCostQty')!.value).replace(',','.'));
    if(!Number.isFinite(qty)||qty<=0)throw new Error('تعداد موجودی معتبر نیست.');
    if(Math.abs(qty-(Number(p.systemQty)||0))>0.000001)throw new Error('تعداد باید با موجودی فعلی کالا در انبار برابر باشد.');
    const warehouse=p.warehouse||'انبار اصلی';
    const unitRaw=digits(el<HTMLInputElement>('#openingCostUnit')!.value);
    if(!unitRaw)throw new Error('بهای واحد را وارد کنید (ترجیحاً قیمت خرید).');
    const unitCostRial=parseMoneyToRial(unitRaw,currency);
    const date=digits(el<HTMLInputElement>('#openingCostDate')!.value)||todayJalali();
    const costing=await loadInventoryCostData();
    setOpeningStockCost(costing,{productId:p.id,warehouse,qtyMilli:Math.round(qty*1000),unitCostRial,date});
    await saveInventoryCostData(costing);
    logAudit('accounting_opening_stock_valued',{productId:p.id,warehouse,qty,unitCostRial});
    toast('بهای موجودی اولیه ثبت شد','success');
    await render();
  }catch(e){toast(e instanceof Error?e.message:'خطا در ارزش‌گذاری موجودی','error')}});
  el<HTMLButtonElement>('#openingCostBulk')?.addEventListener('click',async()=>{try{
    const date=digits(el<HTMLInputElement>('#openingCostDate')?.value||'')||todayJalali();
    if(!/^\d{4}\/\d{2}\/\d{2}$/.test(date))throw new Error('تاریخ ارزش‌گذاری را به شکل سال/ماه/روز وارد کنید.');
    const pending=await listPendingOpeningValuation();
    if(!pending.length){toast('کالای در انتظار ارزش‌گذاری نیست.','info');return;}
    const withPrice=pending.filter(x=>x.hasPrice);
    if(!withPrice.length)throw new Error('هیچ کالایی قیمت خرید/فروش ندارد. ابتدا در تعریف کالا قیمت خرید را وارد یا از فایل با ستون قیمت وارد کنید.');
    const costing=await loadInventoryCostData();
    let ok=0, fail=0;
    const errors:string[]=[];
    for(const row of withPrice){
      try{
        const unitCostRial=parseMoneyToRial(String(row.unitHint),currency);
        if(!unitCostRial||unitCostRial<=0){fail++;continue;}
        setOpeningStockCost(costing,{
          productId:row.product.id,
          warehouse:row.warehouse,
          qtyMilli:Math.round(row.qty*1000),
          unitCostRial,
          date,
        });
        ok++;
      }catch(e){
        fail++;
        if(errors.length<5) errors.push(e instanceof Error?e.message:String(e));
      }
    }
    await saveInventoryCostData(costing);
    logAudit('accounting_opening_stock_bulk_valued',{ok,fail,total:pending.length,date});
    const extra=errors.length?` · نمونه خطا: ${errors[0]}`:'';
    toast(`ارزش‌گذاری گروهی: ${fa(ok)} کالا ثبت شد`+(fail?`، ${fa(fail)} ناموفق`:'')+(pending.length-withPrice.length?`، ${fa(pending.length-withPrice.length)} بدون قیمت`:'')+extra, ok? 'success':'error');
    refreshAccounting();
    await render();
  }catch(e){toast(e instanceof Error?e.message:'خطا در ارزش‌گذاری گروهی','error')}});
  el<HTMLButtonElement>('#openingCostRefresh')?.addEventListener('click',()=>{void render();});
  el<HTMLButtonElement>('#nrvRefresh')?.addEventListener('click',()=>{void render();});
  el<HTMLButtonElement>('#analyticsRefresh')?.addEventListener('click',()=>{void render();});
  document.querySelectorAll<HTMLElement>('[data-nrv-write-down]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      try{
        const productId=btn.getAttribute('data-nrv-write-down')||'';
        const warehouse=btn.getAttribute('data-nrv-wh')||'انبار اصلی';
        const suggested=Number(btn.getAttribute('data-nrv-amount')||'0');
        const p=products.find(x=>x.id===productId);
        if(!p)throw new Error('کالا پیدا نشد.');
        if(!Number.isSafeInteger(suggested)||suggested<=0)throw new Error('مبلغ کاهش ارزش معتبر نیست.');
        const ok=confirm(`ثبت کاهش ارزش «${p.name}» به مبلغ ${money(suggested)}؟\nتعداد موجودی تغییر نمی‌کند؛ فقط ارزش دفتری کاهش می‌یابد و سند حسابداری صادر می‌شود.`);
        if(!ok)return;
        const date=todayJalali();
        const period=invoicePeriodForDate(date);
        await postInventoryNrvWriteDown({
          productId,
          warehouse,
          writeDownRial:suggested,
          date,
          fiscalPeriodId:period,
          note:`کاهش ارزش NRV — ${p.name}`,
        });
        try{costingCache=await loadInventoryCostData();}catch{/* ignore */}
        refreshAccounting();
        await render();
        toast('کاهش ارزش موجودی ثبت شد.','success');
      }catch(e){toast(e instanceof Error?e.message:'خطا در ثبت کاهش ارزش','error');}
    });
  });

  el<HTMLButtonElement>('#openInvoiceTypeSheet')?.addEventListener('click',openInvoiceTypeSheet);
  el<HTMLSelectElement>('#opKind')?.addEventListener('change',()=>{
    const kind=el<HTMLSelectElement>('#opKind')!.value;
    const exp=el<HTMLElement>('#opAccountExpenseWrap');
    const inc=el<HTMLElement>('#opAccountIncomeWrap');
    if(exp)exp.hidden=kind!=='expense';
    if(inc)inc.hidden=kind!=='income';
  });
  el<HTMLButtonElement>('#opSave')?.addEventListener('click',async()=>{
    try{
      const kind=(el<HTMLSelectElement>('#opKind')?.value||'expense') as 'expense'|'income';
      const operatingAccountId=kind==='expense'
        ?(el<HTMLSelectElement>('#opExpenseAccount')?.value||'')
        :(el<HTMLSelectElement>('#opIncomeAccount')?.value||'');
      const cashAccountId=el<HTMLSelectElement>('#opCashAccount')?.value||'';
      const amountRial=parseMoneyToRial(digits(el<HTMLInputElement>('#opAmount')?.value||'0'),currency);
      const date=digits(el<HTMLInputElement>('#opDate')?.value||'');
      const fiscalPeriodId=el<HTMLSelectElement>('#opPeriod')?.value||await activeFiscalPeriodId();
      const description=el<HTMLInputElement>('#opDescription')?.value||'';
      const partyId=el<HTMLSelectElement>('#opParty')?.value||undefined;
      if(!operatingAccountId)throw new Error(kind==='expense'?'حساب هزینه را انتخاب کنید.':'حساب درآمد را انتخاب کنید.');
      if(!cashAccountId)throw new Error('حساب صندوق یا بانک را انتخاب کنید.');
      await recordOperatingEntry({kind,date,fiscalPeriodId,amountRial,operatingAccountId,cashAccountId,description,partyId});
      logAudit('operating_entry',{kind,amountRial,operatingAccountId,cashAccountId});
      refreshAccounting();
      await render();
      toast(kind==='expense'?'هزینه ثبت و سند حسابداری صادر شد.':'درآمد ثبت و سند حسابداری صادر شد.','success');
    }catch(e){toast(e instanceof Error?e.message:'خطا در ثبت هزینه/درآمد','error')}
  });
  el<HTMLButtonElement>('#invoiceOpenItems')?.addEventListener('click',openInvoiceItemsSheet);
  el<HTMLButtonElement>('#invoiceAddParty')?.addEventListener('click',()=>{
    openPartyFormSheet({
      preferType:isSaleInvoiceType(activeInvoiceType)?'customer':'supplier',
      selectAfterSave:true,
    });
  });
  el<HTMLButtonElement>('#partySaveBtn')?.addEventListener('click',async()=>{
    const saved=await savePartyFromForm(false);
    if(saved)await render();
  });
  el<HTMLButtonElement>('#partyResetBtn')?.addEventListener('click',()=>{editingPartyId=null;render();});
  bindPartySmsButtons(document);
document.querySelectorAll<HTMLButtonElement>('[data-edit-party]').forEach(btn=>btn.addEventListener('click',()=>{
    editingPartyId=btn.dataset.editParty||null;
    render().then(()=>el<HTMLElement>('#partyFormGrid')?.scrollIntoView({behavior:'smooth',block:'start'}));
  }));
  el<HTMLInputElement>('#invoiceDescriptionVisible')?.addEventListener('input',event=>{const hidden=el<HTMLInputElement>('#invoiceDescription');if(hidden)hidden.value=(event.target as HTMLInputElement).value;});
  const previousInvoiceScanHandler=(window as any).__anbarinInvoiceBarcodeHandler as EventListener|undefined;
  if(previousInvoiceScanHandler)window.removeEventListener('anbarin:invoice-barcode-scan',previousInvoiceScanHandler);
  const invoiceScanHandler:EventListener=(event:Event)=>{
    const detail=(event as CustomEvent<{code:string}>).detail;
    const code=digits(detail?.code||'').trim();
    if(!code)return;
    const product=findProductByCode(code);
    const status=el<HTMLElement>('#invoiceScanStatus')||document.querySelector<HTMLElement>('#invoiceScanStatus');
    if(product){
      addProductToInvoice(product.id,true);
      if(status)status.textContent=`✓ ${product.name} اضافه شد`;
      toast(`${product.name} به اقلام اضافه شد`,'success');
    }else{
      if(status)status.textContent=`بارکد ${code} پیدا نشد`;
      offerAddProduct(code,{
        asName:false,
        onSaved:(productId)=>{
          addProductToInvoice(productId,true);
          const p=products.find(x=>x.id===productId);
          if(status)status.textContent=p?`✓ ${p.name} اضافه شد`:'کالا اضافه شد';
          toast(p?`${p.name} تعریف و به فاکتور اضافه شد`:'کالا به فاکتور اضافه شد','success');
        },
      });
    }
  };
  (window as any).__anbarinInvoiceBarcodeHandler=invoiceScanHandler;window.addEventListener('anbarin:invoice-barcode-scan',invoiceScanHandler);
  bindInvoiceProductSearch(document);
  document.addEventListener('click',event=>{if(!(event.target as HTMLElement).closest('.invoice-live-search')){const box=el<HTMLDivElement>('#invoiceProductSuggestions');if(box)box.hidden=true;}});
  // تقویم فاکتور از طریق attachJalaliCalendar / enhanceDateFields وصل می‌شود
  const invDate = el<HTMLInputElement>('#invoiceDate');
  if (invDate) {
    const btn = el<HTMLButtonElement>('#invoiceJalaliCalendar');
    const panel = el<HTMLDivElement>('#invoiceJalaliCalendarPanel');
    if (btn) delete btn.dataset.calBound;
    delete invDate.dataset.calendarEnhanced;
    attachJalaliCalendar(invDate, btn, panel);
  }
  el<HTMLInputElement>('#invoiceTax')?.addEventListener('input',updateInvoiceTotals);
  el<HTMLButtonElement>('#invoiceAddPayment')?.addEventListener('click',()=>addInvoicePaymentRow());el<HTMLDivElement>('#invoicePaymentRows')?.addEventListener('input',updateInvoiceTotals);el<HTMLDivElement>('#invoicePaymentRows')?.addEventListener('change',updateInvoiceTotals);
  el<HTMLInputElement>('#invoiceTaxRate')?.addEventListener('change',applyInvoiceTaxRate);
  ['#invoiceLandedFreight','#invoiceLandedCustoms','#invoiceLandedInsurance','#invoiceLandedOther'].forEach(sel=>{
    el<HTMLInputElement>(sel)?.addEventListener('input',updateInvoiceTotals);
  });
  const saveInvoiceDraft=async(quiet=false):Promise<string|null>=>{
    if(!commerce){toast('اطلاعات بازرگانی بارگذاری نشده است.','error');return null;}
    try{
      await refreshFiscalCache();
      if(!fiscalPeriodsCache.some(p=>p.status==='open')){
        throw new Error('سال مالی باز پیدا نشد. از حسابداری → سال مالی یک دوره با وضعیت باز بسازید، یا برنامه را یک‌بار ببندید و باز کنید.');
      }
      const typeEl=q<HTMLInputElement>('#invoiceType');
      const numberEl=q<HTMLInputElement>('#invoiceNumber');
      const partyEl=q<HTMLSelectElement>('#invoiceParty');
      const dateEl=q<HTMLInputElement>('#invoiceDate');
      if(!typeEl||!numberEl||!partyEl||!dateEl)throw new Error('فرم فاکتور در دسترس نیست. برگه فاکتور را دوباره باز کنید.');
      const type=(typeEl.value||activeInvoiceType) as InvoiceType;
      const invoiceNo=numberEl.value.trim();
      if(!invoiceNo)throw new Error('شماره فاکتور را وارد کنید.');
      if(!partyEl.value)throw new Error('طرف حساب را انتخاب کنید.');
      await assertDefaultPartyAllowed(type, partyEl.value);
      if(commerce.invoices.some(i=>i.id!==editingInvoiceId&&i.type===type&&i.number===invoiceNo))throw new Error('شماره فاکتور در این نوع فاکتور تکراری است.');
      const rows=qAll<HTMLElement>('#commerceInvoiceLines .commerce-line');
      const lines:Array<{description:string;unit:string;quantityMilli:number;unitPriceRial:number;discountRial:number;productId?:string;warehouse?:string}>=[];
      for(const row of rows){
        const productId=row.querySelector<HTMLInputElement>('[data-line-product]')?.value||'';
        const product=products.find(p=>p.id===productId);
        const description=(row.querySelector<HTMLInputElement>('[data-line-desc]')?.value||product?.name||'').trim();
        const qRaw=lineEnteredQty(row);
        const enteredUnitPriceRial=parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-line-price]')?.value||'0'),currency);
        const discountRial=parseMoneyToRial(digits(row.querySelector<HTMLInputElement>('[data-line-discount]')?.value||'0'),currency);
        // ردیف خالی را نادیده بگیر
        if(!description && !productId && !enteredUnitPriceRial) continue;
        if(!description)throw new Error('شرح هر ردیف کالا را وارد کنید.');
        if(!Number.isFinite(qRaw)||qRaw<=0||qRaw>999999999)throw new Error(`تعداد «${description}» نامعتبر است.`);
        if(!enteredUnitPriceRial||enteredUnitPriceRial<=0)throw new Error(`قیمت واحد «${description}» باید بیشتر از صفر باشد.`);
        // تبدیل بسته → واحد پایه تا موجودی و بهای تمام‌شده همیشه بر حسب واحد پایه باشد
        const packMode=row.querySelector<HTMLSelectElement>('[data-line-unit-mode]')?.value==='pack';
        const factor=lineUnitFactor(row);
        const baseQty=packMode?qRaw*factor:qRaw;
        if(baseQty<=0||baseQty>999999999)throw new Error(`تعداد تبدیل‌شده «${description}» نامعتبر است.`);
        const enteredGross=Math.round(qRaw*enteredUnitPriceRial);
        const quantityMilli=Math.round(baseQty*1000);
        const unitPriceRial=quantityMilli>0?Math.round(enteredGross*1000/quantityMilli):enteredUnitPriceRial;
        const unitLabel=packMode?(product?.unit||'عدد'):(row.querySelector<HTMLInputElement>('[data-line-unit]')?.value||product?.unit||'عدد');
        lines.push({
          description,
          unit:unitLabel,
          quantityMilli,
          unitPriceRial,
          discountRial,
          ...(product?{productId:product.id,warehouse:product.warehouse||'انبار اصلی'}:{}),
        });
      }
      if(!lines.length)throw new Error('حداقل یک قلم با شرح و قیمت به فاکتور اضافه کنید (برگه اقلام).');
      const invoiceDate=normalizeJalaliDate(dateEl.value||todayJalali())||digits(dateEl.value||todayJalali());
      const fiscalPeriodId=invoicePeriodForDate(invoiceDate);
      const payload={
        type,
        number:invoiceNo,
        date:invoiceDate,
        dueDate:'',
        paymentTerms:'',
        paymentParts:[] as InvoicePaymentPart[],
        fiscalPeriodId,
        partyId:partyEl.value,
        description:q<HTMLInputElement>('#invoiceDescription')?.value||'',
        notes:q<HTMLTextAreaElement>('#invoiceNotes')?.value||'',
        taxRateBps:Math.round(Number(digits(q<HTMLInputElement>('#invoiceTaxRate')?.value||'0').replace(',','.'))*100),
        lines,
        taxRial:parseMoneyToRial(digits(q<HTMLInputElement>('#invoiceTax')?.value||'0'),currency),
        ...(type==='purchase'?{
          landedCosts:{
            freightRial:parseMoneyToRial(digits(q<HTMLInputElement>('#invoiceLandedFreight')?.value||'0'),currency),
            customsRial:parseMoneyToRial(digits(q<HTMLInputElement>('#invoiceLandedCustoms')?.value||'0'),currency),
            insuranceRial:parseMoneyToRial(digits(q<HTMLInputElement>('#invoiceLandedInsurance')?.value||'0'),currency),
            otherRial:parseMoneyToRial(digits(q<HTMLInputElement>('#invoiceLandedOther')?.value||'0'),currency),
            note:q<HTMLInputElement>('#invoiceLandedNote')?.value||'',
          },
        }:{}),
      };
      let savedId='';
      const prevSuppress=suppressCommerceSheetReopen;
      suppressCommerceSheetReopen=true;
      try{
        if(editingInvoiceId){
          const next=updateDraftInvoice(editingInvoiceId,payload,commerce);
          savedId=editingInvoiceId;
          editingInvoiceId=null;
          await persist(next);
          if(!quiet)toast('پیش‌نویس ذخیره شد','success');
        }else{
          const invoice=buildInvoice(payload,commerce.parties);
          savedId=invoice.id;
          const next={...commerce,invoices:[...commerce.invoices,invoice]};
          await persist(next);
          if(!quiet)toast('پیش‌نویس ذخیره شد','success');
        }
      }finally{
        suppressCommerceSheetReopen=prevSuppress;
      }
      lastPrintableInvoiceId=savedId||lastPrintableInvoiceId; return savedId;
    }catch(e){
      toast(e instanceof Error?e.message:'خطا در ذخیره فاکتور','error');
      return null;
    }
  };
  saveInvoiceDraftHandler = saveInvoiceDraft;
  // delegation پایدار در سطح document — فقط یک‌بار؛ همیشه آخرین handler
  if(!(window as any).__anbarinInvoiceActionBound){
    (window as any).__anbarinInvoiceActionBound=true;
    const onInvoiceAction=async(ev:Event)=>{
      const t=ev.target as HTMLElement|null;
      if(!t)return;
      const saveBtn=t.closest('#invoiceSave') as HTMLElement|null;
      const settleBtn=t.closest('#invoiceSettle') as HTMLElement|null;
      if(!saveBtn&&!settleBtn)return;
      ev.preventDefault();
      ev.stopPropagation();
      const run=saveInvoiceDraftHandler;
      if(!run){
        toast('فرم فاکتور آماده نیست. یک‌بار برگه را ببندید و دوباره باز کنید.','error');
        return;
      }
      try{
        if(saveBtn){
          await run(false); // toast داخل saveInvoiceDraft
          return;
        }
        if(settleBtn){
          if(!commerce){toast('اطلاعات بازرگانی بارگذاری نشده است.','error');return;}
          if(activeInvoiceType==='proforma'){toast('پیش‌فاکتور قابل تسویه نیست.','error');return;}
          const savedId=await run(true);
          if(!savedId){return;} // toast already shown by save
          if(!commerce){toast('ذخیره انجام شد اما داده در دسترس نیست.','error');return;}
          const target=commerce.invoices.find(i=>i.id===savedId);
          if(!target){toast('فاکتور برای تسویه آماده نشد.','error');return;}
          if(target.status!=='draft'){toast('این فاکتور قبلاً قطعی شده است.','error');return;}
          openInvoiceSettlementSheet(target.id);
        }
      }catch(e){
        toast(e instanceof Error?e.message:'خطا در عملیات فاکتور','error');
      }
    };
    document.addEventListener('click',onInvoiceAction,true);
  }

  document.querySelectorAll<HTMLElement>('[data-edit-invoice]').forEach(b=>b.addEventListener('click',()=>startInvoiceEdit(b.dataset.editInvoice!)));
  el<HTMLButtonElement>('#invoiceCancelEdit')?.addEventListener('click',cancelInvoiceEdit);
  document.querySelectorAll<HTMLElement>('[data-print-invoice]').forEach(b=>b.addEventListener('click',()=>printInvoice(b.dataset.printInvoice!)));
  document.querySelectorAll<HTMLElement>('[data-share-invoice]').forEach(b=>b.addEventListener('click',()=>{void shareInvoice(b.dataset.shareInvoice!);}));
  const runPrintOrShare=async(kind:'print'|'share')=>{
    let id=resolveInvoiceForPrint();
    if(!id){
      // اگر هنوز ذخیره نشده، اول پیش‌نویس کن
      const run=saveInvoiceDraftHandler;
      if(!run){toast('ابتدا فاکتور را به‌صورت پیش‌نویس ذخیره کنید.','error');return;}
      try{
        id=await run(true);
      }catch(e){toast(e instanceof Error?e.message:'ذخیره فاکتور انجام نشد','error');return;}
    }
    if(!id){toast('فاکتوری برای چاپ/اشتراک پیدا نشد. ابتدا پیش‌نویس را بزنید.','error');return;}
    lastPrintableInvoiceId=id;
    if(kind==='print') printInvoice(id);
    else await shareInvoice(id);
  };
  // handler پایدار برای چاپ/اشتراک (حتی بعد از انتقال DOM به برگه)
  (window as any).__anbarinInvoicePrintShare = runPrintOrShare;
  el<HTMLButtonElement>('#invoicePrint')?.addEventListener('click',(ev)=>{ev.preventDefault(); void runPrintOrShare('print');});
  el<HTMLButtonElement>('#invoiceShare')?.addEventListener('click',(ev)=>{ev.preventDefault(); void runPrintOrShare('share');});
  el<HTMLButtonElement>('#invoicePrintInternal')?.addEventListener('click',async(ev)=>{
    ev.preventDefault();
    const id=resolveInvoiceForPrint();
    if(!id){toast('ابتدا فاکتور را ذخیره کنید.','error');return;}
    lastPrintableInvoiceId=id;
    if(!costingCache){try{costingCache=await loadInventoryCostData();}catch{/* ignore */}}
    await printInvoice(id,{internal:true});
  });
  if(!(window as any).__anbarinInvoicePrintBound){
    (window as any).__anbarinInvoicePrintBound=true;
    document.addEventListener('click',(ev)=>{
      const t=ev.target as HTMLElement|null; if(!t)return;
      const printInternalBtn=t.closest('#invoicePrintInternal');
      if(printInternalBtn){
        if(!t.closest('#commercePanelSheet, #accountingCommerceWorkspace, .invoice-action-bar'))return;
        ev.preventDefault();
        const id=resolveInvoiceForPrint();
        if(!id){toast('ابتدا فاکتور را ذخیره کنید.','error');return;}
        lastPrintableInvoiceId=id;
        void (async()=>{
          if(!costingCache){try{costingCache=await loadInventoryCostData();}catch{/* ignore */}}
          await printInvoice(id,{internal:true});
        })();
        return;
      }
      const printBtn=t.closest('#invoicePrint');
      const shareBtn=t.closest('#invoiceShare');
      if(!printBtn&&!shareBtn)return;
      if(!t.closest('#commercePanelSheet, #accountingCommerceWorkspace, .invoice-action-bar'))return;
      ev.preventDefault();
      const run=(window as any).__anbarinInvoicePrintShare as ((k:'print'|'share')=>Promise<void>)|undefined;
      if(!run){return;}
      void run(printBtn?'print':'share');
    },true);
  }

  document.querySelectorAll<HTMLElement>('[data-post-invoice]').forEach(b=>b.addEventListener('click',()=>openInvoiceSettlementSheet(b.dataset.postInvoice!)));
  const refreshCashInvoices=()=>{if(!commerce)return;const type=el<HTMLSelectElement>('#cashType')!.value;const partyId=el<HTMLSelectElement>('#cashParty')!.value;const eligible=commerce.invoices.filter(i=>i.status==='posted'&&i.partyId===partyId&&((type==='receipt'&&i.type==='sale')||(type==='payment'&&i.type==='purchase'))&&invoiceOutstanding(i.id,commerce!)>0);const invSel=el<HTMLSelectElement>('#cashInvoice');if(invSel){invSel.innerHTML='<option value="">بدون تخصیص (علی‌الحساب)</option>'+eligible.map(i=>`<option value="${esc(i.id)}">${esc(i.number)} — مانده ${money(invoiceOutstanding(i.id,commerce!))}</option>`).join('');refreshSearchableSelect(invSel);}};
  el<HTMLSelectElement>('#cashType')?.addEventListener('change',()=>{const type=el<HTMLSelectElement>('#cashType')!.value;const partySel=el<HTMLSelectElement>('#cashParty');if(partySel){partySel.innerHTML='<option value="">انتخاب طرف حساب</option>'+partyOptions(type==='receipt'?'customer':'supplier');refreshSearchableSelect(partySel);}refreshCashInvoices()});
  el<HTMLSelectElement>('#cashParty')?.addEventListener('change',refreshCashInvoices);
  el<HTMLSelectElement>('#cashMethod')?.addEventListener('change',()=>{
    const show=el<HTMLSelectElement>('#cashMethod')!.value==='cheque';
    document.querySelectorAll<HTMLElement>('[data-cheque-field]').forEach(x=>{
      x.hidden=!show;
      x.style.display=show?'':'none';
    });
  });
  // وضعیت اولیه
  (()=>{const m=el<HTMLSelectElement>('#cashMethod');if(!m)return;const show=m.value==='cheque';document.querySelectorAll<HTMLElement>('[data-cheque-field]').forEach(x=>{x.hidden=!show;x.style.display=show?'':'none';});})();
  el<HTMLButtonElement>('#cashSave')?.addEventListener('click',async()=>{if(!commerce)return;try{const type=el<HTMLSelectElement>('#cashType')!.value as 'receipt'|'payment';const method=el<HTMLSelectElement>('#cashMethod')!.value as any;if(method==='cheque'){const cn=(el<HTMLInputElement>('#cashChequeNumber')?.value||'').trim();const bank=(el<HTMLInputElement>('#cashChequeBank')?.value||'').trim();const sayadi=(el<HTMLInputElement>('#cashChequeAccount')?.value||'').trim();const due=digits(el<HTMLInputElement>('#cashChequeDue')?.value||'');if(!cn||!bank||!sayadi||!due||!/^\d{4}\/\d{2}\/\d{2}$/.test(due))throw new Error('برای چک، شماره چک، بانک، شماره صیادی و سررسید الزامی است.');}const result=await createCashTransaction({type,number:el<HTMLInputElement>('#cashNumber')!.value,date:digits(el<HTMLInputElement>('#cashDate')!.value),fiscalPeriodId:await activeFiscalPeriodId(),partyId:el<HTMLSelectElement>('#cashParty')!.value,cashAccountId:el<HTMLSelectElement>('#cashAccount')!.value,amountRial:parseMoneyToRial(digits(el<HTMLInputElement>('#cashAmount')!.value),currency),description:el<HTMLInputElement>('#cashDescription')!.value,method:el<HTMLSelectElement>('#cashMethod')!.value as any,allocations:el<HTMLSelectElement>('#cashInvoice')!.value?[{invoiceId:el<HTMLSelectElement>('#cashInvoice')!.value,amountRial:parseMoneyToRial(digits(el<HTMLInputElement>('#cashAllocation')!.value||el<HTMLInputElement>('#cashAmount')!.value),currency)}]:[],chequeNumber:el<HTMLInputElement>('#cashChequeNumber')!.value,chequeBank:el<HTMLInputElement>('#cashChequeBank')!.value,chequeAccount:el<HTMLInputElement>('#cashChequeAccount')?.value||'',chequeNote:el<HTMLInputElement>('#cashChequeNote')?.value||'',chequeDueDate:digits(el<HTMLInputElement>('#cashChequeDue')!.value)},commerce);commerce=result.commerce;await saveCommerceData(commerce);render();refreshAccounting();toast('دریافت/پرداخت و سند حسابداری ثبت شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ثبت دریافت/پرداخت','error')}});
  document.querySelectorAll<HTMLElement>('[data-cheque-clear]').forEach(b=>b.addEventListener('click',async()=>{if(!commerce)return;try{const date=prompt('تاریخ وصول/تسویه شمسی را وارد کنید (مثلاً ۱۴۰۵/۰۱/۳۰):');if(!date)return;const result=await updateChequeStatus(b.dataset.chequeClear!,'cleared',digits(date),commerce);commerce=result.commerce;await recordChequeEvent(b.dataset.chequeClear!,'cleared_note',digits(date),'وصول/تسویه با سند حسابداری');render();refreshAccounting();toast('وصول/تسویه چک ثبت شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در تسویه چک','error')}}));
  document.querySelectorAll<HTMLElement>('[data-cheque-bounce]').forEach(b=>b.addEventListener('click',async()=>{if(!commerce)return;try{const date=prompt('تاریخ برگشت چک شمسی را وارد کنید:');if(!date)return;const result=await updateChequeStatus(b.dataset.chequeBounce!,'bounced',digits(date),commerce);commerce=result.commerce;const reason=prompt('علت برگشت چک:')||'علت اعلام نشده';await recordChequeEvent(b.dataset.chequeBounce!,'bounced_note',digits(date),reason);render();refreshAccounting();toast('برگشت چک و اثر حسابداری ثبت شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ثبت برگشت چک','error')}}));

  document.querySelectorAll<HTMLElement>('[data-chq-endorse]').forEach(b=>b.addEventListener('click',async()=>{if(!commerce)return;try{const tx=commerce.cashTransactions.find(t=>t.id===b.dataset.chqEndorse);if(!tx)throw new Error('چک پیدا نشد.');const remaining=getChequeEndorsementRemaining(tx.id,commerce);const amountText=prompt(`مبلغ این مرحله را به ریال وارد کنید (حداکثر ${fa(remaining)}):`,String(remaining));if(!amountText)return;const amount=parseMoneyToRial(digits(amountText),'rial');if(!Number.isSafeInteger(amount)||amount<=0||amount>remaining)throw new Error('مبلغ واگذاری معتبر نیست یا از مانده چک بیشتر است.');const suppliers=commerce.parties.filter(p=>p.isActive&&(p.type==='supplier'||p.type==='both'));if(!suppliers.length)throw new Error('ابتدا تأمین‌کننده فعال ثبت کنید.');const supplierText=suppliers.map((p,i)=>`${i+1}) ${p.name}`).join('\n');const choice=prompt(`شماره تأمین‌کننده دریافت‌کننده را وارد کنید:\n${supplierText}`);if(!choice)return;const supplier=suppliers[Number(digits(choice))-1];if(!supplier)throw new Error('انتخاب تأمین‌کننده معتبر نیست.');const invoices=commerce.invoices.filter(i=>i.status==='posted'&&i.type==='purchase'&&i.partyId===supplier.id&&invoiceOutstanding(i.id,commerce!)>=amount);if(!invoices.length)throw new Error('برای این تأمین‌کننده فاکتور خرید قطعی با مانده کافی وجود ندارد.');const invoiceText=invoices.map((i,n)=>`${n+1}) ${i.number} — مانده ${money(invoiceOutstanding(i.id,commerce!))}`).join('\n');const invChoice=prompt(`فاکتور خریدی را انتخاب کنید که با این بخش از چک تسویه می‌شود:\n${invoiceText}`);if(!invChoice)return;const invoice=invoices[Number(digits(invChoice))-1];if(!invoice)throw new Error('انتخاب فاکتور معتبر نیست.');const date=prompt('تاریخ واگذاری شمسی (YYYY/MM/DD):');if(!date)return;const note=prompt('شرح / شماره رسید تحویل چک:')||'';commerce=await endorseCheque(tx.id,supplier.id,invoice.id,digits(date),note,amount);await render();refreshAccounting();toast('بخش چک و سند حسابداری ثبت شد.','success')}catch(e){toast(e instanceof Error?e.message:'خطا در واگذاری چک','error')}}));
  document.querySelectorAll<HTMLElement>('[data-chain-endorsement]').forEach(b=>b.addEventListener('click',async()=>{if(!commerce)return;try{const endorsementId=b.dataset.chainEndorsement!;const parentTransferId=b.dataset.chainParent||undefined;const fromPartyId=b.dataset.chainFrom!;const available=Number(b.dataset.chainAvailable);const amountText=prompt(`مبلغ انتقال به ذی‌نفع بعدی (حداکثر ${fa(available)} ریال):`,String(available));if(!amountText)return;const amount=parseMoneyToRial(digits(amountText),'rial');if(!Number.isSafeInteger(amount)||amount<=0||amount>available)throw new Error('مبلغ انتقال معتبر نیست.');const candidates=commerce.parties.filter(p=>p.isActive&&p.id!==fromPartyId);if(!candidates.length)throw new Error('طرف حساب فعال دیگری برای انتقال وجود ندارد.');const options=candidates.map((p,i)=>`${i+1}) ${p.name}`).join('\n');const choice=prompt(`شماره دریافت‌کننده را وارد کنید:\n${options}`);if(!choice)return;const to=candidates[Number(digits(choice))-1];if(!to)throw new Error('انتخاب دریافت‌کننده معتبر نیست.');const date=prompt('تاریخ انتقال شمسی (YYYY/MM/DD):');if(!date)return;const note=prompt('شماره رسید تحویل / توضیحات:')||'';await transferEndorsedCheque({endorsementId,parentTransferId,fromPartyId,toPartyId:to.id,amountRial:amount,date:digits(date),note});await render();toast('انتقال زنجیره‌ای چک ثبت شد.','success')}catch(e){toast(e instanceof Error?e.message:'خطا در انتقال زنجیره‌ای چک','error')}}));
  document.querySelectorAll<HTMLElement>('[data-chain-outcome]').forEach(b=>b.addEventListener('click',async()=>{if(!commerce)return;try{const endorsementId=b.dataset.chainOutcome!;const parentTransferId=b.dataset.outcomeParent||undefined;const holderPartyId=b.dataset.outcomeHolder!;const available=Number(b.dataset.outcomeAvailable);const amountText=prompt(`مبلغ تعیین‌تکلیف (حداکثر ${fa(available)} ریال):`,String(available));if(!amountText)return;const amountRial=parseMoneyToRial(digits(amountText),'rial');if(!Number.isSafeInteger(amountRial)||amountRial<=0||amountRial>available)throw new Error('مبلغ واردشده معتبر نیست.');const choice=prompt('نتیجه را انتخاب کنید:\n1) وصول‌شده\n2) برگشتی\n3) مورد اختلاف');if(!choice)return;const typeMap:Record<string,'collected'|'returned'|'disputed'>={'1':'collected','2':'returned','3':'disputed'};const type=typeMap[digits(choice)];if(!type)throw new Error('نوع نتیجه معتبر نیست.');const date=prompt('تاریخ ثبت نتیجه شمسی (YYYY/MM/DD):');if(!date)return;const reference=prompt('شماره گواهی بانک / کد رهگیری (اختیاری):')||'';const note=prompt('شرح یا علت برگشت / اختلاف:')||'';await recordChequeHolderOutcome({endorsementId,parentTransferId,holderPartyId,type,amountRial,date:digits(date),reference,note});await render();toast('نتیجه چک نزد دارنده ثبت شد.','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ثبت نتیجه چک','error')}}));
  document.querySelectorAll<HTMLElement>('[data-chq-extend]').forEach(b=>b.addEventListener('click',async()=>{try{const date=prompt('سررسید جدید شمسی (YYYY/MM/DD):');if(!date)return;const note=prompt('علت تمدید:')||'';await extendChequeDueDate(b.dataset.chqExtend!,digits(date),note);commerce=await loadCommerceData();await render();toast('سررسید جدید ثبت و سابقه قبلی حفظ شد.','success')}catch(e){toast(e instanceof Error?e.message:'خطا در تمدید چک','error')}}));
  document.querySelectorAll<HTMLElement>('[data-chq-replace]').forEach(b=>b.addEventListener('click',async()=>{try{const number=prompt('شماره چک جایگزین:');if(!number)return;const bank=prompt('بانک چک جایگزین:');if(!bank)return;const dueDate=prompt('سررسید جدید شمسی:');if(!dueDate)return;const date=prompt('تاریخ تحویل چک جایگزین شمسی:');if(!date)return;const note=prompt('شرح/علت جایگزینی:')||'';await replaceChequeDetails(b.dataset.chqReplace!,{number,bank,dueDate:digits(dueDate),date:digits(date),note});commerce=await loadCommerceData();await render();toast('مشخصات چک جایگزین ثبت شد؛ سوابق قبلی محفوظ است.','success')}catch(e){toast(e instanceof Error?e.message:'خطا در جایگزینی چک','error')}}));
  document.querySelectorAll<HTMLElement>('[data-chq-deposit]').forEach(b=>b.addEventListener('click',async()=>{try{const date=prompt('تاریخ واگذاری به بانک شمسی:');if(!date)return;const note=prompt('نام شعبه/شماره رسید واگذاری:')||'';await recordChequeEvent(b.dataset.chqDeposit!,'deposited',digits(date),note);await render();toast('واگذاری چک به بانک در دفتر ثبت شد.','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ثبت واگذاری','error')}}));

}
export async function initAccountingCommerceUI():Promise<void>{
  try{
    await ensureCommerceAccounts();
    const [acc,stored,costing]=await Promise.all([loadAccountingData(),loadCommerceData(),loadInventoryCostData()]);
    commerce=stored;
    costingCache=costing;
    currency=acc.settings.currencyDisplay;
    fiscalPeriodsCache=acc.fiscalPeriods.map(p=>({id:p.id,startDate:p.startDate,endDate:p.endDate,status:p.status}));
    loadPeriodOptions=acc.fiscalPeriods.filter(p=>p.status==='open').map(p=>`<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
    accountOptionsCache=acc.accounts.filter(a=>a.isActive&&a.level==='detail'&&['det-cash','det-bank'].includes(a.id)).map(a=>`<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
    render();
  }
  catch(e){console.error('[Anbarin] commerce UI init failed',e);toast('بارگذاری فاکتورها و دریافت‌وپرداخت انجام نشد','error')}
}

