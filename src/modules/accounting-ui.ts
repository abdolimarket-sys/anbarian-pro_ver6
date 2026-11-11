/** رابط کاربری حسابداری */
import {
  initializeSuggestedChart, loadAccountingData, saveAccountingData,
  upsertAccount, removeAccount, createFiscalPeriod, upsertJournalEntry,
  postJournalEntry, createReversingJournalEntry, parseMoneyToRial, formatMoneyFromRial,
  resolveActiveFiscalPeriod, withActiveFiscalPeriod,
  type AccountingData, type AccountLevel, type JournalEntry,
} from './accounting';
import { loadCommerceData, saveCommerceData } from './accounting-commerce';
import { loadInventoryCostData, saveInventoryCostData } from './inventory-costing';
import { downloadFile, shareFileContent, dateStr } from '@/utils/helpers';
import { toast } from './ui';
import { enhanceDateFields } from './date-picker';
import { enhanceSelectWithSearch, refreshSearchableSelect } from './searchable-select';

let data: AccountingData | null = null;
let activeAccountingTab: string | null = null;
const accountingTabs = [
  {id:'commerce', icon:'⇄', label:'بازرگانی', desc:'فاکتور، طرف حساب، دریافت و پرداخت', tone:'invoice'},
  {id:'journals', icon:'▤', label:'اسناد حسابداری', desc:'سند دستی، پیش‌نویس و قطعی‌سازی', tone:'journals'},
  {id:'accounts', icon:'▦', label:'کدینگ', desc:'گروه، کل، معین و تفصیلی', tone:'accounts'},
  {id:'fiscal', icon:'▣', label:'سال مالی', desc:'تعریف و انتخاب سال فعال', tone:'fiscal'},
  {id:'reports', icon:'▥', label:'گزارش‌ها', desc:'همه گزارش‌های حسابداری و بازرگانی', tone:'reports'},
  {id:'backup', icon:'💾', label:'ذخیره', desc:'پشتیبان‌گیری و بازیابی', tone:'other'},
  {id:'settings', icon:'⚙', label:'تنظیمات', desc:'واحد پول و تنظیمات نمایش', tone:'other'},
] as const;

const fa = (v: number) => new Intl.NumberFormat('fa-IR').format(v);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const normalizeDigits = (value: string) => value.replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
const id = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);

function restoreAccountingHosts(): void {
  const page = el<HTMLElement>('#page-accounting');
  const host = el<HTMLElement>('#accountingModuleHost');
  const mount = el<HTMLElement>('#accountingModuleMount');
  if (host && mount) {
    while (mount.firstChild) host.appendChild(mount.firstChild);
  }
  const commerce = el<HTMLElement>('#accountingCommerceWorkspace');
  const reports = el<HTMLElement>('#accountingReportsWorkspace');
  if (page && commerce && commerce.parentElement !== page) page.appendChild(commerce);
  if (page && reports && reports.parentElement !== page) page.appendChild(reports);
  if (commerce) commerce.hidden = true;
  if (reports) reports.hidden = true;
  document.querySelectorAll<HTMLElement>('[data-acc-section]').forEach(node => { node.hidden = true; });
}

function closeAccountingModuleSheet(): void {
  restoreAccountingHosts();
  document.getElementById('accountingModuleSheet')?.remove();
  activeAccountingTab = null;
  document.body.classList.remove('accounting-sheet-open');
}

function openAccountingModuleSheet(tabId: string): void {
  if (!data) return;
  closeAccountingModuleSheet();
  activeAccountingTab = tabId;
  const tab = accountingTabs.find(t => t.id === tabId);
  const title = tab?.label || 'حسابداری';

  const overlay = document.createElement('div');
  overlay.id = 'accountingModuleSheet';
  overlay.className = 'accounting-module-sheet';
  overlay.dir = 'rtl';
  overlay.innerHTML = `
    <div class="accounting-module-sheet-inner">
      <header class="accounting-module-sheet-head">
        <div>
          <p class="accounting-module-sheet-kicker">حسابداری</p>
          <h2>${esc(title)}</h2>
        </div>
        <button type="button" class="btn btn-secondary" id="accountingModuleClose">بازگشت</button>
      </header>
      <div class="accounting-module-sheet-body" id="accountingModuleMount"></div>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('accounting-sheet-open');
  overlay.querySelector('#accountingModuleClose')?.addEventListener('click', closeAccountingModuleSheet);

  const mount = overlay.querySelector<HTMLElement>('#accountingModuleMount')!;
  const commerce = el<HTMLElement>('#accountingCommerceWorkspace');
  const reports = el<HTMLElement>('#accountingReportsWorkspace');

  if (tabId === 'commerce' && commerce) {
    commerce.hidden = false;
    mount.appendChild(commerce);
  } else if (tabId === 'reports' && reports) {
    reports.hidden = false;
    mount.appendChild(reports);
  } else {
    const section = el<HTMLElement>(`#accountingModuleHost [data-acc-section="${tabId}"]`)
      || document.querySelector<HTMLElement>(`[data-acc-section="${tabId}"]`);
    if (section) {
      section.hidden = false;
      mount.appendChild(section);
    }
  }
}

function accountOptions(level?: AccountLevel): string {
  if (!data) return '';
  return data.accounts.filter(a => a.isActive && (!level || a.level === level))
    .map(a => `<option value="${esc(a.id)}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');
}
function renderAccounts(): string {
  if (!data) return '';
  const ordered = [...data.accounts].sort((a,b) => a.code.localeCompare(b.code, 'en'));
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>کد</th><th>عنوان حساب</th><th>سطح</th><th>ماهیت</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${ordered.map(a => `<tr><td>${esc(a.code)}</td><td>${'　'.repeat(({group:0,general:1,subsidiary:2,detail:3} as Record<string,number>)[a.level])}${esc(a.title)}</td><td>${({group:'گروه',general:'کل',subsidiary:'معین',detail:'تفصیلی'})[a.level]}</td><td>${a.nature==='debit'?'بدهکار':'بستانکار'}</td><td>${a.isActive?'فعال':'غیرفعال'}</td><td><button class="btn btn-sm btn-secondary" data-edit-account="${a.id}">ویرایش</button> <button class="btn btn-sm btn-secondary" data-toggle-account="${a.id}">${a.isActive?'غیرفعال':'فعال'}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderPeriods(): string {
  if (!data) return '';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>سال مالی</th><th>شروع</th><th>پایان</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${data.fiscalPeriods.map(p=>`<tr><td>${esc(p.title)}</td><td>${esc(p.startDate)}</td><td>${esc(p.endDate)}</td><td>${p.status==='open'?'باز':'بسته'}</td><td>${p.status==='open'?`<button class="btn btn-sm btn-secondary" data-close-period="${p.id}">بستن سال</button>`:'—'}</td></tr>`).join('') || '<tr><td colspan="5">هنوز سال مالی تعریف نشده است.</td></tr>'}</tbody></table></div>`;
}
function renderJournals(): string {
  if (!data) return '';
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>شماره</th><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${data.journalEntries.slice().reverse().map(j=>{
    const d=j.lines.reduce((s,l)=>s+l.debitRial,0),c=j.lines.reduce((s,l)=>s+l.creditRial,0);
    const status=j.status==='draft'?'پیش‌نویس'
      :j.reversedByEntryId?'قطعی · معکوس‌شده'
      :j.reversesEntryId?'قطعی · سند معکوس'
      :'قطعی';
    let actions='—';
    if(j.status==='draft')actions=`<button class="btn btn-sm btn-primary" data-post-journal="${j.id}">قطعی‌سازی</button>`;
    else if(j.status==='posted'&&!j.reversedByEntryId&&!j.reversesEntryId)
      actions=`<button class="btn btn-sm btn-secondary" data-reverse-journal="${j.id}" title="صدور سند معکوس قطعی">سند معکوس</button>`;
    else if(j.reversedByEntryId){
      const rev=data!.journalEntries.find(x=>x.id===j.reversedByEntryId);
      actions=rev?`معکوس: ${esc(rev.number)}`:'معکوس‌شده';
    }else if(j.reversesEntryId){
      const orig=data!.journalEntries.find(x=>x.id===j.reversesEntryId);
      actions=orig?`بابت: ${esc(orig.number)}`:'سند معکوس';
    }
    return `<tr><td>${esc(j.number)}</td><td>${esc(j.date)}</td><td>${esc(j.description)}</td><td>${fa(d)}</td><td>${fa(c)}</td><td>${status}</td><td>${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="7">هنوز سندی ثبت نشده است.</td></tr>'}</tbody></table></div>`;
}
function renderJournalLineEditor(count: number): string {
  if (!data) return '';
  const currencyLabel = data.settings.currencyDisplay==='toman'?'تومان':'ریال';
  const opts = accountOptions('detail');
  return Array.from({length: count}, (_, i) => `<div class="accounting-voucher-line" data-je-line="${i}"><label class="field">حساب<select data-je-account><option value="">انتخاب حساب</option>${opts}</select></label><label class="field">شرح ردیف<input data-je-description placeholder="شرح آرتیکل"></label><label class="field">بدهکار (<span>${currencyLabel}</span>)<input data-je-debit inputmode="decimal" placeholder="۰"></label><label class="field">بستانکار (<span>${currencyLabel}</span>)<input data-je-credit inputmode="decimal" placeholder="۰"></label><button type="button" class="btn btn-sm btn-secondary" data-je-remove aria-label="حذف ردیف" ${i<2?'disabled':''}>حذف</button></div>`).join('');
}
function updateJournalTotals(): void {
  if (!data) return;
  let debit=0, credit=0;
  document.querySelectorAll<HTMLElement>('[data-je-line]').forEach(row=>{
    try { debit += parseMoneyToRial(normalizeDigits(row.querySelector<HTMLInputElement>('[data-je-debit]')?.value||'0')||'0',data!.settings.currencyDisplay); } catch {}
    try { credit += parseMoneyToRial(normalizeDigits(row.querySelector<HTMLInputElement>('[data-je-credit]')?.value||'0')||'0',data!.settings.currencyDisplay); } catch {}
  });
  const node=el<HTMLElement>('#jeTotals'); if(node) node.textContent=`جمع بدهکار: ${fa(debit)} | جمع بستانکار: ${fa(credit)} | ${debit===credit&&debit>0?'سند متوازن':'اختلاف: '+fa(Math.abs(debit-credit))}`;
}
function render(): void {
  const root = el<HTMLDivElement>('#accountingWorkspace'); if (!root || !data) return;
  const acc = data;
  const reopenTab = activeAccountingTab;
  closeAccountingModuleSheet();
  root.setAttribute('dir','rtl');
  root.innerHTML = `
    <div class="accounting-home">
      <p class="hint accounting-overview-hint">هر بخش در برگه تمام‌صفحه جدا باز می‌شود تا فرم‌ها و فهرست‌ها جای استاندارد خود را داشته باشند.</p>
      <div class="accounting-home-grid" role="navigation" aria-label="بخش‌های حسابداری">
        ${accountingTabs.map(t=>`
          <button type="button" class="accounting-home-tile" data-acc-tab="${t.id}">
            <span class="accounting-home-icon ${t.tone}" aria-hidden="true">${t.icon}</span>
            <strong>${t.label}</strong>
            <span class="hint">${t.desc}</span>
          </button>`).join('')}
      </div>
    </div>
    <div id="accountingModuleHost" hidden>
      <section class="acc-section" data-acc-section="backup" hidden><div class="card accounting-inner-card" dir="rtl" style="text-align:right">
        <h3>ذخیره و بازیابی</h3>
        <p class="hint">پشتیبان شامل حسابداری، بازرگانی و بهای تمام‌شده است.</p>
        <ul class="hint" style="margin:8px 0 12px;padding-right:18px;line-height:1.7">
          <li><b>ذخیره در دستگاه:</b> انتخاب پوشه روی گوشی/رایانه (Downloads، کارت حافظه و …)</li>
          <li><b>اشتراک‌گذاری:</b> ارسال به Google Drive، تلگرام، واتساپ، ایمیل و سایر برنامه‌ها</li>
          <li><b>بازیابی:</b> انتخاب همان فایل JSON برای جایگزینی داده‌های حسابداری</li>
        </ul>
        <div class="form-grid" style="margin-top:12px;gap:8px">
          <button type="button" class="btn btn-primary" id="accBackupDownload">ذخیره در دستگاه</button>
          <button type="button" class="btn btn-secondary" id="accBackupShare">اشتراک‌گذاری (Drive و …)</button>
          <button type="button" class="btn btn-secondary" id="accBackupRestore">بازیابی از فایل</button>
          <input type="file" id="accBackupFile" accept="application/json,.json" hidden>
        </div>
        <p class="hint" id="accBackupStatus" style="margin-top:12px"></p>
      </div></section>
      <section class="acc-section" data-acc-section="settings" hidden><div class="card accounting-inner-card acc-settings-panel">
        <h3>تنظیمات حسابداری</h3>
        <p class="hint">سیاست‌های جاری شرکت. ذخیره فقط روی عملیات بعدی اثر دارد و اسناد قبلی را بازنویسی نمی‌کند.</p>

        <div class="acc-settings-group">
          <div class="acc-settings-group-title">عمومی و بهای تمام‌شده</div>
          <div class="acc-settings-grid">
            <label class="field">واحد نمایش مبالغ
              <select id="accCurrency">
                <option value="toman" ${acc.settings.currencyDisplay==='toman'?'selected':''}>تومان</option>
                <option value="rial" ${acc.settings.currencyDisplay==='rial'?'selected':''}>ریال</option>
              </select>
              <span class="hint">مبنای داخلی همیشه ریال است؛ این فقط نحوهٔ نمایش است.</span>
            </label>
            <label class="field">روش بهای تمام‌شده
              <select id="accCostingMethod">
                <option value="moving-average" ${acc.settings.defaultCostingMethod!=='fifo'?'selected':''}>میانگین موزون متحرک</option>
                <option value="fifo" ${acc.settings.defaultCostingMethod==='fifo'?'selected':''}>FIFO — اولین صادره از اولین وارده</option>
              </select>
              <span class="hint">برای اکثر کسب‌وکارها میانگین موزون مناسب‌تر است.</span>
            </label>
          </div>
        </div>

        <div class="acc-settings-group">
          <div class="acc-settings-group-title">قیمت خرید و فروش کالا (کاتالوگ)</div>
          <p class="hint" style="margin:0 0 8px">فقط بعد از <b>قطعی‌سازی فاکتور خرید</b> روی کارت کالا اعمال می‌شود. بهای تمام‌شده انبار جداگانه از همان فاکتور ثبت می‌گردد.</p>
          <div class="acc-settings-presets" role="group" aria-label="پیشنهاد سریع">
            <button type="button" class="btn btn-secondary btn-sm" data-acc-preset="safe">پیشنهاد امن</button>
            <button type="button" class="btn btn-secondary btn-sm" data-acc-preset="retail">خرده‌فروشی</button>
            <button type="button" class="btn btn-secondary btn-sm" data-acc-preset="wholesale">عمده با حاشیه ثابت</button>
          </div>
          <div class="acc-settings-grid">
            <label class="field">قیمت خرید جدید
              <select id="accPurchasePriceMode">
                <option value="none" ${acc.settings.purchasePriceUpdateMode==='none'?'selected':''}>بدون تغییر — دستی</option>
                <option value="last" ${acc.settings.purchasePriceUpdateMode!=='none'&&acc.settings.purchasePriceUpdateMode!=='average'?'selected':''}>آخرین خرید (خالص ردیف)</option>
                <option value="average" ${acc.settings.purchasePriceUpdateMode==='average'?'selected':''}>میانگین موزون موجودی</option>
              </select>
            </label>
            <label class="field">قیمت فروش جدید
              <select id="accSalePriceMode">
                <option value="none" ${acc.settings.salePriceUpdateMode!=='markup'&&acc.settings.salePriceUpdateMode!=='keep-ratio'?'selected':''}>بدون تغییر — دستی</option>
                <option value="markup" ${acc.settings.salePriceUpdateMode==='markup'?'selected':''}>درصد سود روی خرید</option>
                <option value="keep-ratio" ${acc.settings.salePriceUpdateMode==='keep-ratio'?'selected':''}>حفظ نسبت فروش به خرید</option>
              </select>
            </label>
            <label class="field" id="accSaleMarkupWrap">
              درصد سود فروش
              <input id="accSaleMarkupPercent" type="number" min="0" max="1000" step="0.1" value="${Number(acc.settings.salePriceMarkupPercent)||0}" inputmode="decimal">
              <span class="hint">مثال: خرید ۱۰۰٬۰۰۰ + سود ۲۵٪ ← فروش ۱۲۵٬۰۰۰</span>
            </label>
          </div>
        </div>

        <div class="acc-settings-group">
          <div class="acc-settings-group-title">کنترل ریسک موجودی و نقدینگی</div>
          <label class="acc-settings-check">
            <input type="checkbox" id="accAllowNegativeStock" ${acc.settings.allowNegativeStock?'checked':''}>
            <span>
              <strong>اجازه موجودی منفی</strong>
              <span class="hint">فروش/خروج با موجودی ناکافی. در حالت خاموش، قطعی‌سازی فروش متوقف می‌شود.</span>
            </span>
          </label>
          <label class="acc-settings-check">
            <input type="checkbox" id="accAllowChequeNegCash" ${acc.settings.allowChequeClearWithNegativeCash?'checked':''}>
            <span>
              <strong>اجازه پاس چک با موجودی ناکافی</strong>
              <span class="hint">پاس چک پرداختنی حتی اگر مانده بانک/صندوق کافی نباشد.</span>
            </span>
          </label>
          <label class="acc-settings-check">
            <input type="checkbox" id="accAllowDefaultCustomer" ${acc.settings.allowDefaultCustomerSales!==false?'checked':''}>
            <span>
              <strong>فروش به خریدار پیش‌فرض</strong>
              <span class="hint">اگر خاموش باشد، فاکتور فروش با «خریدار پیش‌فرض» ثبت یا قطعی نمی‌شود.</span>
            </span>
          </label>
          <label class="acc-settings-check">
            <input type="checkbox" id="accAllowDefaultSupplier" ${acc.settings.allowDefaultSupplierPurchases!==false?'checked':''}>
            <span>
              <strong>خرید از فروشنده پیش‌فرض</strong>
              <span class="hint">اگر خاموش باشد، فاکتور خرید با «فروشنده پیش‌فرض» ثبت یا قطعی نمی‌شود.</span>
            </span>
          </label>
        </div>

        <div class="acc-settings-actions">
          <button class="btn btn-primary" id="accSaveCurrency" type="button">ذخیره تنظیمات</button>
          <span class="hint" id="accSettingsSaveHint">تغییرات تا قبل از ذخیره اعمال نمی‌شوند.</span>
        </div>
      </div></section>
      <section class="acc-section" data-acc-section="accounts" hidden><div class="card accounting-inner-card"><h3>کدینگ</h3><div class="form-grid"><label class="field">کد حساب<input id="accCode" placeholder="مثلاً 110103"></label><label class="field">عنوان حساب<input id="accTitle" placeholder="عنوان حساب"></label><label class="field">سطح حساب<select id="accLevel"><option value="group">گروه</option><option value="general">کل</option><option value="subsidiary">معین</option><option value="detail">تفصیلی</option></select></label><label class="field">حساب والد<select id="accParent"><option value="">بدون والد</option>${accountOptions()}</select></label><label class="field">ماهیت<select id="accNature"><option value="debit">بدهکار</option><option value="credit">بستانکار</option></select></label></div><div class="actions"><button class="btn btn-primary" id="accAddAccount">افزودن حساب</button><button class="btn btn-secondary" id="accCancelEdit" hidden>لغو ویرایش</button></div><input type="hidden" id="accEditId">${renderAccounts()}</div></section>
      <section class="acc-section" data-acc-section="fiscal" hidden><div class="card accounting-inner-card"><h3>سال مالی</h3>
        <label class="field">سال مالی فعال (برای تمام ثبت‌ها)<select id="fyActive">${acc.fiscalPeriods.filter(p=>p.status==='open').map(p=>`<option value="${p.id}" ${acc.settings.activeFiscalPeriodId===p.id?'selected':''}>${esc(p.title)}</option>`).join('')||'<option value="">سال باز تعریف نشده</option>'}</select></label>
        <button class="btn btn-primary" id="fySetActive" type="button" style="margin-top:8px">اعمال سال فعال</button>
        <hr style="margin:16px 0;border:0;border-top:1px solid var(--border-color,#e2e8f0)">
        <div class="form-grid"><label class="field">عنوان<input id="fyTitle" placeholder="مثلاً سال مالی ۱۴۰۵"></label><label class="field">تاریخ شروع<input id="fyStart" placeholder="1405/01/01" inputmode="numeric" autocomplete="off"></label><label class="field">تاریخ پایان<input id="fyEnd" placeholder="1405/12/29" inputmode="numeric" autocomplete="off"></label></div><button class="btn btn-primary" id="fyCreate">ایجاد سال مالی</button>${renderPeriods()}</div>
      </section>
      <section class="acc-section" data-acc-section="journals" hidden><div class="card accounting-inner-card"><h3>سند حسابداری</h3><div class="form-grid"><label class="field">شماره سند<input id="jeNumber" placeholder="مثلاً ۱۰۰۱"></label><label class="field">تاریخ شمسی<input id="jeDate" placeholder="1405/01/01" inputmode="numeric" autocomplete="off"></label><label class="field">شرح سند<input id="jeDescription" placeholder="شرح مختصر"></label></div><div class="accounting-voucher-head"><strong>آرتیکل‌های سند</strong><span class="hint">هر سند می‌تواند چندین ردیف بدهکار و بستانکار داشته باشد.</span></div><div id="jeLines" class="accounting-voucher-lines">${renderJournalLineEditor(2)}</div><div class="actions"><button type="button" class="btn btn-secondary" id="jeAddLine">افزودن ردیف</button><span id="jeTotals" class="hint">جمع بدهکار و بستانکار: ۰</span></div><button class="btn btn-primary" id="jeSave">ثبت پیش‌نویس سند</button>${renderJournals()}</div></section>
    </div>`;
  // keep external workspaces hidden on home
  const commerce = el<HTMLElement>('#accountingCommerceWorkspace');
  const reports = el<HTMLElement>('#accountingReportsWorkspace');
  if (commerce) commerce.hidden = true;
  if (reports) reports.hidden = true;
  bind();
  // جستجوپذیر کردن کادر حساب‌ها
  document.querySelectorAll<HTMLSelectElement>('[data-je-account], #accParent').forEach((sel) => {
    enhanceSelectWithSearch(sel, { placeholder: 'جستجوی حساب...', minOptions: 8 });
    refreshSearchableSelect(sel);
  });
  if (reopenTab) openAccountingModuleSheet(reopenTab);
}
async function persist(next: AccountingData): Promise<void> { data = next; await saveAccountingData(next); render(); window.dispatchEvent(new Event('accounting:data-updated')); }
function bindJournalLineEvents(): void {
  document.querySelectorAll<HTMLElement>('[data-je-line] [data-je-remove]').forEach(button=>button.addEventListener('click',()=>{const rows=document.querySelectorAll('[data-je-line]');if(rows.length<=2){toast('سند باید حداقل دو ردیف داشته باشد','error');return;}button.closest('[data-je-line]')?.remove();updateJournalTotals();}));
  document.querySelectorAll<HTMLInputElement>('[data-je-debit], [data-je-credit]').forEach(input=>input.addEventListener('input',updateJournalTotals));
}
function bind(): void {
  // بعد از ساخت DOM، تقویم شمسی یکدست به فیلدهای تاریخ وصل می‌شود
  queueMicrotask(() => enhanceDateFields(document));
  document.querySelectorAll<HTMLButtonElement>('[data-acc-tab]').forEach(button => button.addEventListener('click',()=>{
    const tabId=button.dataset.accTab||'commerce';
    openAccountingModuleSheet(tabId);
  }));
  const syncSaleMarkupVisibility=()=>{
    const mode=el<HTMLSelectElement>('#accSalePriceMode')?.value;
    const wrap=el<HTMLElement>('#accSaleMarkupWrap');
    if(wrap) wrap.style.display = mode==='markup' ? '' : 'none';
  };
  syncSaleMarkupVisibility();
  el<HTMLSelectElement>('#accSalePriceMode')?.addEventListener('change', syncSaleMarkupVisibility);

  document.querySelectorAll<HTMLButtonElement>('[data-acc-preset]').forEach((btn)=>{
    btn.addEventListener('click', ()=>{
      const preset=btn.dataset.accPreset;
      const pm=el<HTMLSelectElement>('#accPurchasePriceMode');
      const sm=el<HTMLSelectElement>('#accSalePriceMode');
      const mk=el<HTMLInputElement>('#accSaleMarkupPercent');
      const neg=el<HTMLInputElement>('#accAllowNegativeStock');
      const chq=el<HTMLInputElement>('#accAllowChequeNegCash');
      const cost=el<HTMLSelectElement>('#accCostingMethod');
      if(preset==='safe'){
        if(pm) pm.value='last';
        if(sm) sm.value='none';
        if(mk) mk.value='0';
        if(neg) neg.checked=false;
        if(chq) chq.checked=false;
        if(cost) cost.value='moving-average';
      } else if(preset==='retail'){
        if(pm) pm.value='last';
        if(sm) sm.value='keep-ratio';
        if(neg) neg.checked=false;
        if(chq) chq.checked=false;
        if(cost) cost.value='moving-average';
      } else if(preset==='wholesale'){
        if(pm) pm.value='last';
        if(sm) sm.value='markup';
        if(mk && !(Number(mk.value)>0)) mk.value='20';
        if(neg) neg.checked=false;
        if(chq) chq.checked=false;
        if(cost) cost.value='moving-average';
      }
      syncSaleMarkupVisibility();
      toast('پیشنهاد اعمال شد؛ برای نهایی شدن «ذخیره تنظیمات» را بزنید','info');
    });
  });

  el<HTMLButtonElement>('#accSaveCurrency')?.addEventListener('click', async()=>{
    if(!data)return;
    data.settings.currencyDisplay=el<HTMLSelectElement>('#accCurrency')!.value as 'rial'|'toman';
    data.settings.defaultCostingMethod=(el<HTMLSelectElement>('#accCostingMethod')?.value==='fifo'?'fifo':'moving-average');
    data.settings.allowNegativeStock=!!el<HTMLInputElement>('#accAllowNegativeStock')?.checked;
    data.settings.allowChequeClearWithNegativeCash=!!el<HTMLInputElement>('#accAllowChequeNegCash')?.checked;
    data.settings.allowDefaultCustomerSales=!!el<HTMLInputElement>('#accAllowDefaultCustomer')?.checked;
    data.settings.allowDefaultSupplierPurchases=!!el<HTMLInputElement>('#accAllowDefaultSupplier')?.checked;
    const pm=el<HTMLSelectElement>('#accPurchasePriceMode')?.value;
    data.settings.purchasePriceUpdateMode = pm === 'none' ? 'none' : pm === 'average' ? 'average' : 'last';
    const sm=el<HTMLSelectElement>('#accSalePriceMode')?.value;
    data.settings.salePriceUpdateMode = sm === 'markup' || sm === 'keep-ratio' ? sm : 'none';
    const markup=Number(el<HTMLInputElement>('#accSaleMarkupPercent')?.value);
    data.settings.salePriceMarkupPercent=Number.isFinite(markup)?Math.max(0,Math.min(1000,markup)):0;
    await persist(data);
    const hint=el<HTMLElement>('#accSettingsSaveHint');
    if(hint) hint.textContent='آخرین ذخیره: '+new Date().toLocaleString('fa-IR');
    toast('تنظیمات حسابداری ذخیره شد','success');
  });
  const buildAccountingBackup=async()=>{
    const [accounting,commerce,costing]=await Promise.all([loadAccountingData(),loadCommerceData(),loadInventoryCostData()]);
    return {
      schema:'anbarin-accounting-backup',
      version:1,
      exportedAt:new Date().toISOString(),
      accounting,
      commerce,
      costing,
    };
  };
  const setBackupStatus=(msg:string)=>{const n=el<HTMLElement>('#accBackupStatus');if(n)n.textContent=msg;};
  el<HTMLButtonElement>('#accBackupDownload')?.addEventListener('click',async()=>{
    try{
      setBackupStatus('در حال آماده‌سازی پشتیبان…');
      const payload=await buildAccountingBackup();
      const name=`anbarin-backup-${dateStr()}.json`;
      const result=await downloadFile(JSON.stringify(payload,null,2),name,'application/json;charset=utf-8');
      if(result==='cancelled'){
        setBackupStatus('ذخیره لغو شد.');
        toast('ذخیره لغو شد','info');
        return;
      }
      if(result==='error'){
        setBackupStatus('ذخیره ناموفق بود. دوباره تلاش کنید.');
        toast('ذخیره پشتیبان ناموفق بود','error');
        return;
      }
      setBackupStatus('فایل در دستگاه ذخیره شد: '+name);
      toast('پشتیبان در دستگاه ذخیره شد','success');
    }catch(e){toast(e instanceof Error?e.message:'خطا در ذخیره پشتیبان','error')}
  });
  el<HTMLButtonElement>('#accBackupShare')?.addEventListener('click',async()=>{
    try{
      setBackupStatus('در حال آماده‌سازی برای اشتراک‌گذاری…');
      const payload=await buildAccountingBackup();
      const text=JSON.stringify(payload,null,2);
      const name=`anbarin-backup-${dateStr()}.json`;
      const result=await shareFileContent(text,name,'application/json',{
        title:'پشتیبان حسابداری انبارین',
        text:'فایل پشتیبان حسابداری، بازرگانی و بهای تمام‌شده',
      });
      if(result==='shared'){
        setBackupStatus('پنجره اشتراک باز شد — Drive، تلگرام، ایمیل و … را انتخاب کنید.');
        toast('برنامه مقصد را برای اشتراک انتخاب کنید','success');
        return;
      }
      if(result==='cancelled'){
        setBackupStatus('اشتراک‌گذاری لغو شد.');
        return;
      }
      // اگر شیت اشتراک در دسترس نبود، عمداً ذخیره در دستگاه پیشنهاد می‌شود (نه جایگزین بی‌صدا)
      setBackupStatus('اشتراک‌گذاری سیستم در دسترس نیست. می‌توانید «ذخیره در دستگاه» را بزنید.');
      toast('اشتراک‌گذاری در این دستگاه پشتیبانی نشد','info');
    }catch(e){
      if(e instanceof Error&&e.name==='AbortError')return;
      toast(e instanceof Error?e.message:'خطا در اشتراک‌گذاری','error');
    }
  });
  el<HTMLButtonElement>('#accBackupRestore')?.addEventListener('click',()=>el<HTMLInputElement>('#accBackupFile')?.click());
  el<HTMLInputElement>('#accBackupFile')?.addEventListener('change',async()=>{
    const input=el<HTMLInputElement>('#accBackupFile');
    const file=input?.files?.[0];
    if(!file)return;
    try{
      const raw=await file.text();
      const parsed=JSON.parse(raw) as {schema?:string;version?:number;accounting?:AccountingData;commerce?:unknown;costing?:unknown};
      if(parsed.schema!=='anbarin-accounting-backup'||!parsed.accounting||!parsed.commerce||!parsed.costing)throw new Error('فایل پشتیبان معتبر نیست.');
      if(!confirm('بازیابی، داده‌های فعلی حسابداری را جایگزین می‌کند. ادامه می‌دهید؟')){input.value='';return;}
      await saveAccountingData(parsed.accounting);
      await saveCommerceData(parsed.commerce as Parameters<typeof saveCommerceData>[0]);
      await saveInventoryCostData(parsed.costing as Parameters<typeof saveInventoryCostData>[0]);
      data=await loadAccountingData();
      setBackupStatus('بازیابی از فایل انجام شد: '+file.name);
      toast('بازیابی انجام شد','success');
      window.dispatchEvent(new Event('accounting:data-updated'));
      render();
    }catch(e){toast(e instanceof Error?e.message:'خطا در بازیابی','error')}
    finally{if(input)input.value='';}
  });

  const level=el<HTMLSelectElement>('#accLevel')!; const parent=el<HTMLSelectElement>('#accParent')!;
  level.addEventListener('change',()=>{const lv=level.value as AccountLevel;const parentLevel: Record<string,AccountLevel|undefined>={group:undefined,general:'group',subsidiary:'general',detail:'subsidiary'};const opts=(data?.accounts||[]).filter(a=>a.level===parentLevel[lv]&&a.isActive);parent.innerHTML='<option value="">'+(lv==='group'?'بدون والد':'انتخاب والد')+'</option>'+opts.map(a=>`<option value="${a.id}">${esc(a.code)} — ${esc(a.title)}</option>`).join('');refreshSearchableSelect(parent);});
  el<HTMLButtonElement>('#accAddAccount')?.addEventListener('click',async()=>{if(!data)return;try{const editId=el<HTMLInputElement>('#accEditId')!.value||undefined;const next=upsertAccount(data,{id:editId,code:el<HTMLInputElement>('#accCode')!.value,title:el<HTMLInputElement>('#accTitle')!.value,level:level.value as AccountLevel,parentId:parent.value||null,nature:el<HTMLSelectElement>('#accNature')!.value as 'debit'|'credit',isActive:(data.accounts.find(a=>a.id===editId)?.isActive ?? true),isSystem:(data.accounts.find(a=>a.id===editId)?.isSystem ?? false)});await persist(next);toast('حساب ذخیره شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ذخیره حساب','error')}});
  el<HTMLButtonElement>('#accCancelEdit')?.addEventListener('click',()=>render());
  document.querySelectorAll<HTMLElement>('[data-edit-account]').forEach(b=>b.addEventListener('click',()=>{const a=data?.accounts.find(x=>x.id===b.dataset.editAccount);if(!a)return;el<HTMLInputElement>('#accEditId')!.value=a.id;el<HTMLInputElement>('#accCode')!.value=a.code;el<HTMLInputElement>('#accTitle')!.value=a.title;level.value=a.level;level.dispatchEvent(new Event('change'));parent.value=a.parentId||'';el<HTMLSelectElement>('#accNature')!.value=a.nature;el<HTMLButtonElement>('#accAddAccount')!.textContent='ذخیره تغییرات';el<HTMLButtonElement>('#accCancelEdit')!.hidden=false}));
  document.querySelectorAll<HTMLElement>('[data-toggle-account]').forEach(b=>b.addEventListener('click',async()=>{if(!data)return;const a=data.accounts.find(x=>x.id===b.dataset.toggleAccount);if(!a)return;try{await persist({...data,accounts:data.accounts.map(x=>x.id===a.id?{...x,isActive:!x.isActive,updatedAt:new Date().toISOString()}:x)});toast('وضعیت حساب تغییر کرد','success')}catch{toast('تغییر وضعیت انجام نشد','error')}}));
  el<HTMLButtonElement>('#fySetActive')?.addEventListener('click',async()=>{if(!data)return;try{const id=el<HTMLSelectElement>('#fyActive')!.value;if(!id)throw new Error('سال مالی باز انتخاب کنید.');await persist(withActiveFiscalPeriod(data,id));toast('سال مالی فعال تنظیم شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا','error')}});
  el<HTMLButtonElement>('#fyCreate')?.addEventListener('click',async()=>{if(!data)return;try{const p=createFiscalPeriod({title:el<HTMLInputElement>('#fyTitle')!.value,startDate:normalizeDigits(el<HTMLInputElement>('#fyStart')!.value),endDate:normalizeDigits(el<HTMLInputElement>('#fyEnd')!.value)},data.fiscalPeriods);const next={...data,fiscalPeriods:[...data.fiscalPeriods,p],settings:{...data.settings,activeFiscalPeriodId:data.settings.activeFiscalPeriodId||p.id}};await persist(next);toast('سال مالی ایجاد شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ایجاد سال مالی','error')}});
  document.querySelectorAll<HTMLElement>('[data-close-period]').forEach(b=>b.addEventListener('click',async()=>{if(!data)return;try{const {closeFiscalPeriod}=await import('./accounting');await persist(closeFiscalPeriod(data,b.dataset.closePeriod!));toast('سال مالی بسته شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا','error')}}));
  el<HTMLButtonElement>('#jeAddLine')?.addEventListener('click',()=>{const host=el<HTMLElement>('#jeLines');if(!host)return;host.insertAdjacentHTML('beforeend',renderJournalLineEditor(host.querySelectorAll('[data-je-line]').length+1));bindJournalLineEvents();host.querySelectorAll<HTMLSelectElement>('[data-je-account]').forEach((sel)=>{enhanceSelectWithSearch(sel,{placeholder:'جستجوی حساب...',minOptions:8});refreshSearchableSelect(sel);});});
  bindJournalLineEvents();
  el<HTMLButtonElement>('#jeSave')?.addEventListener('click',async()=>{if(!data)return;try{const number=el<HTMLInputElement>('#jeNumber')!.value.trim();if(!number)throw new Error('شماره سند الزامی است.');const lines:JournalEntry['lines']=[];document.querySelectorAll<HTMLElement>('[data-je-line]').forEach(row=>{const accountId=row.querySelector<HTMLSelectElement>('[data-je-account]')!.value;const debitText=normalizeDigits(row.querySelector<HTMLInputElement>('[data-je-debit]')!.value||'0');const creditText=normalizeDigits(row.querySelector<HTMLInputElement>('[data-je-credit]')!.value||'0');const debitRial=parseMoneyToRial(debitText,data!.settings.currencyDisplay);const creditRial=parseMoneyToRial(creditText,data!.settings.currencyDisplay);if(accountId||debitRial||creditRial)lines.push({id:id('line'),accountId,description:row.querySelector<HTMLInputElement>('[data-je-description]')!.value.trim(),debitRial,creditRial});});const entry:JournalEntry={id:id('je'),number,fiscalPeriodId:resolveActiveFiscalPeriod(data).id,date:normalizeDigits(el<HTMLInputElement>('#jeDate')!.value),description:el<HTMLInputElement>('#jeDescription')!.value.trim(),status:'draft',source:'manual',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lines};await persist(upsertJournalEntry(data,entry));toast('پیش‌نویس سند ذخیره شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا در ثبت سند','error')}});
  document.querySelectorAll<HTMLElement>('[data-post-journal]').forEach(b=>b.addEventListener('click',async()=>{if(!data)return;try{await persist(postJournalEntry(data,b.dataset.postJournal!));toast('سند قطعی شد','success')}catch(e){toast(e instanceof Error?e.message:'خطا','error')}}));
  document.querySelectorAll<HTMLElement>('[data-reverse-journal]').forEach(b=>b.addEventListener('click',async()=>{
    if(!data)return;
    const entryId=b.dataset.reverseJournal!;
    const original=data.journalEntries.find(j=>j.id===entryId);
    if(!original)return;
    if(!confirm(`سند معکوس قطعی برای «${original.number}» صادر شود؟\nسند اصلی تغییر نمی‌کند و اثر آن با سند جدید خنثی می‌شود.`))return;
    try{
      await persist(createReversingJournalEntry(data,entryId,{autoPost:true}));
      toast('سند معکوس صادر و قطعی شد','success');
    }catch(e){toast(e instanceof Error?e.message:'خطا در صدور سند معکوس','error')}
  }));
}
export async function initAccountingUI(): Promise<void> {
  try { data=await initializeSuggestedChart(); render();
    window.addEventListener('accounting:data-updated', async () => { data = await loadAccountingData(); render(); });
  }
  catch(error){console.error('[Anbarin] accounting UI init failed',error);toast('بارگذاری حسابداری انجام نشد','error')}
}
