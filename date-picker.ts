/** تقویم شمسی یکپارچه — فاکتور، اسناد، سال مالی، گزارش‌ها.
 *  پنل با position:fixed روی body باز می‌شود تا overflow برگه فاکتور آن را مخفی نکند.
 *  باز شدن با event delegation است تا جابه‌جایی DOM برگه فاکتور listener را از بین نبرد.
 */
const normalize = (value: string) =>
  value
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

const MONTH_NAMES = ['', 'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

export function todayJalali(): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(x => x.type === 'year')?.value || '1400';
  const m = parts.find(x => x.type === 'month')?.value || '01';
  const d = parts.find(x => x.type === 'day')?.value || '01';
  return `${y}/${m}/${d}`;
}

export function persianParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find(x => x.type === 'year')?.value),
    month: Number(parts.find(x => x.type === 'month')?.value),
    day: Number(parts.find(x => x.type === 'day')?.value),
  };
}

function parseJalali(value: string): { y: number; m: number; d: number } | null {
  const match = normalize(value).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (y < 1200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function formatJalali(y: number, m: number, d: number): string {
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

function findJalaliYearStart(year: number): Date | null {
  for (let day = 18; day <= 24; day++) {
    for (const yOff of [621, 622]) {
      const candidate = new Date(year + yOff - 1, 2, day, 12, 0, 0);
      const p = persianParts(candidate);
      if (p.year === year && p.month === 1 && p.day === 1) return candidate;
    }
  }
  const probe = new Date(year + 621, 2, 15, 12);
  for (let i = -5; i < 25; i++) {
    const d = new Date(probe);
    d.setDate(probe.getDate() + i);
    const p = persianParts(d);
    if (p.year === year && p.month === 1 && p.day === 1) return d;
  }
  return null;
}

function daysOfJalaliMonth(year: number, month: number): Date[] {
  const yearStart = findJalaliYearStart(year);
  if (!yearStart) return [];
  const monthOffset = month <= 6 ? (month - 1) * 31 : 186 + (month - 7) * 30;
  const first = new Date(yearStart);
  first.setDate(first.getDate() + monthOffset);
  const firstParts = persianParts(first);
  let start = first;
  if (firstParts.year !== year || firstParts.month !== month || firstParts.day !== 1) {
    let found: Date | null = null;
    for (let i = -5; i <= 8; i++) {
      const t = new Date(first);
      t.setDate(first.getDate() + i);
      const p = persianParts(t);
      if (p.year === year && p.month === month && p.day === 1) { found = t; break; }
    }
    if (!found) return [];
    start = found;
  }
  const days: Date[] = [];
  for (let i = 0; i < 32; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const p = persianParts(day);
    if (p.year !== year || p.month !== month) break;
    days.push(day);
  }
  return days;
}

let activePanel: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;
let activeInput: HTMLInputElement | null = null;
let delegationReady = false;

function hidePanel(panel: HTMLElement): void {
  panel.hidden = true;
  panel.style.display = 'none';
  panel.classList.remove('is-open');
  if (activePanel === panel) {
    activePanel = null;
    activeAnchor = null;
    activeInput = null;
  }
}

function closeAllPanels(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.invoice-jalali-calendar').forEach(panel => {
    if (panel !== except) hidePanel(panel);
  });
}

function getOrCreatePanel(input: HTMLInputElement): HTMLElement {
  const key = input.id ? `jalali-panel-${input.id}` : '';
  let panel = (key ? document.getElementById(key) : null) as HTMLElement | null;
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'invoice-jalali-calendar';
    if (key) panel.id = key;
    panel.hidden = true;
  } else {
    panel.classList.add('invoice-jalali-calendar');
  }
  if (panel.parentElement !== document.body) {
    panel.hidden = true;
    panel.style.display = 'none';
    document.body.appendChild(panel);
  }
  // پنل کهنه با id قدیمی فرم فاکتور
  if (input.id === 'invoiceDate') {
    document.querySelectorAll<HTMLElement>('#invoiceJalaliCalendarPanel').forEach(p => {
      if (p !== panel) p.remove();
    });
  }
  return panel;
}

function positionPanel(panel: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const margin = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  panel.hidden = false;
  panel.style.display = 'block';
  panel.style.visibility = 'hidden';
  panel.style.position = 'fixed';
  panel.style.zIndex = '12000';
  panel.style.left = '0';
  panel.style.top = '0';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  const pw = Math.min(Math.max(panel.offsetWidth || 280, 260), vw - 16);
  const ph = panel.offsetHeight || 280;
  panel.style.minWidth = `${Math.min(280, vw - 16)}px`;
  panel.style.width = `${pw}px`;
  panel.style.maxWidth = `${vw - 16}px`;

  let top = rect.bottom + margin;
  if (top + ph > vh - 8) top = Math.max(8, rect.top - ph - margin);
  let left = rect.right - pw;
  if (left < 8) left = 8;
  if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = 'visible';
  panel.classList.add('is-open');
}

function renderPanel(panel: HTMLElement, input: HTMLInputElement, year: number, month: number, anchor: HTMLElement): void {
  const days = daysOfJalaliMonth(year, month);
  if (!days.length) {
    panel.innerHTML =
      `<div class="jalali-cal-head"><b>خطا در تقویم</b></div>` +
      `<p class="hint" style="padding:8px">امکان نمایش این ماه نیست.</p>`;
    positionPanel(panel, anchor);
    activePanel = panel;
    activeAnchor = anchor;
    activeInput = input;
    return;
  }
  const first = days[0];
  const offset = (first.getDay() + 1) % 7;
  panel.innerHTML =
    `<div class="jalali-cal-head">` +
    `<button type="button" data-cal-prev aria-label="ماه قبل">‹</button>` +
    `<b>${MONTH_NAMES[month]} ${year}</b>` +
    `<button type="button" data-cal-next aria-label="ماه بعد">›</button>` +
    `</div>` +
    `<div class="jalali-cal-grid">` +
    WEEKDAYS.map(n => `<span class="weekday">${n}</span>`).join('') +
    Array.from({ length: offset }, () => '<span></span>').join('') +
    days.map(day => {
      const p = persianParts(day);
      return `<button type="button" data-jdate="${formatJalali(p.year, p.month, p.day)}">${p.day}</button>`;
    }).join('') +
    `</div>`;

  positionPanel(panel, anchor);
  activePanel = panel;
  activeAnchor = anchor;
  activeInput = input;

  panel.querySelector('[data-cal-prev]')?.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    let m = month - 1, y = year;
    if (m < 1) { m = 12; y--; }
    renderPanel(panel, input, y, m, anchor);
  });
  panel.querySelector('[data-cal-next]')?.addEventListener('click', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    let m = month + 1, y = year;
    if (m > 12) { m = 1; y++; }
    renderPanel(panel, input, y, m, anchor);
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-jdate]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      input.value = btn.dataset.jdate || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      hidePanel(panel);
    });
  });
}

function openFor(input: HTMLInputElement, anchor: HTMLElement): void {
  const panel = getOrCreatePanel(input);
  const parsed = parseJalali(input.value) || parseJalali(todayJalali());
  const y = parsed?.y || 1400;
  const m = parsed?.m || 1;
  closeAllPanels(panel);
  renderPanel(panel, input, y, m, anchor);
}

/** پیدا کردن input مرتبط با دکمه تقویم — مخصوص ساختار فاکتور و فرم‌های ساده */
function resolveInputFromButton(btn: HTMLElement): HTMLInputElement | null {
  // صریح برای فاکتور
  if (btn.id === 'invoiceJalaliCalendar') {
    const byId = document.getElementById('invoiceDate');
    if (byId instanceof HTMLInputElement) return byId;
  }
  const wrap = btn.closest('.invoice-jalali-date');
  if (wrap) {
    const inp = wrap.querySelector('input');
    if (inp instanceof HTMLInputElement) return inp;
  }
  const prev = btn.previousElementSibling;
  if (prev instanceof HTMLInputElement) return prev;
  const parent = btn.parentElement;
  if (parent) {
    const inp = parent.querySelector('input');
    if (inp instanceof HTMLInputElement) return inp;
  }
  // data-cal-for="fieldId"
  const forId = btn.getAttribute('data-cal-for') || btn.dataset.calFor;
  if (forId) {
    const el = document.getElementById(forId);
    if (el instanceof HTMLInputElement) return el;
  }
  return null;
}

function isCalButton(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.classList.contains('jalali-cal-btn') ||
    el.id === 'invoiceJalaliCalendar' ||
    el.hasAttribute('data-jalali-cal-btn') ||
    el.getAttribute('aria-label') === 'تقویم شمسی' ||
    el.getAttribute('aria-label') === 'تقویم'
  );
}

function ensureDelegation(): void {
  if (delegationReady) return;
  delegationReady = true;

  // capture=true تا قبل از handlerهای دیگر برگه فاکتور اجرا شود
  document.addEventListener('click', ev => {
    const t = ev.target;
    if (!(t instanceof Element)) return;

    // کلیک روی خود پنل: نبند
    if (t.closest('.invoice-jalali-calendar')) return;

    // کلیک روی دکمه تقویم
    const btnCandidate = t.closest('button, [role="button"]');
    if (isCalButton(btnCandidate) || (t instanceof HTMLElement && isCalButton(t))) {
      const btn = (isCalButton(btnCandidate) ? btnCandidate : t) as HTMLElement;
      ev.preventDefault();
      ev.stopPropagation();
      const input = resolveInputFromButton(btn);
      if (!input) return;
      const panel = getOrCreatePanel(input);
      if (!panel.hidden && panel.classList.contains('is-open') && activeInput === input) {
        hidePanel(panel);
      } else {
        openFor(input, btn);
      }
      return;
    }

    // کلیک بیرون: بستن
    if (activePanel) hidePanel(activePanel);
  }, true);

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && activePanel) hidePanel(activePanel);
  });

  window.addEventListener('resize', () => {
    if (activePanel && activeAnchor && !activePanel.hidden) {
      positionPanel(activePanel, activeAnchor);
    }
  });

  document.addEventListener('scroll', () => {
    if (activePanel) hidePanel(activePanel);
  }, true);
}

/** آماده‌سازی ساختار DOM (دکمه + کلاس‌ها)؛ باز شدن از delegation است */
export function attachJalaliCalendar(input: HTMLInputElement, button?: HTMLButtonElement | null, _panel?: HTMLElement | null): void {
  if (!input) return;
  ensureDelegation();

  let btn = button
    || input.parentElement?.querySelector<HTMLButtonElement>('.jalali-cal-btn, #invoiceJalaliCalendar, [data-jalali-cal-btn]')
    || null;

  const foundWrap = input.closest('.invoice-jalali-date');
  let wrap: HTMLElement | null = foundWrap instanceof HTMLElement ? foundWrap : null;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'invoice-jalali-date';
    input.parentNode?.insertBefore(wrap, input);
    wrap.appendChild(input);
  }

  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary jalali-cal-btn';
    btn.setAttribute('aria-label', 'تقویم شمسی');
    btn.title = 'تقویم شمسی';
    btn.textContent = '▦';
    wrap.appendChild(btn);
  } else {
    btn.classList.add('jalali-cal-btn');
    btn.type = 'button';
    if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'تقویم شمسی');
    // اگر دکمه بیرون wrap است، برای تشخیص resolveInputFromButton داخل wrap باشد
    if (btn.parentElement !== wrap) {
      wrap.appendChild(btn);
    }
  }
  if (input.id) btn.setAttribute('data-cal-for', input.id);

  // پنل از پیش در HTML فاکتور ممکن است باشد — به body منتقل/پاکسازی
  getOrCreatePanel(input);
  // حذف پنل داخل فرم تا absolute قدیمی دیده نشود
  wrap.querySelectorAll('.invoice-jalali-calendar').forEach(p => p.remove());

  input.dataset.calendarEnhanced = 'true';
  btn.dataset.calBound = '1';

  // blur نرمال‌سازی
  if (input.dataset.calBlurBound !== '1') {
    input.dataset.calBlurBound = '1';
    input.addEventListener('blur', () => {
      const p = parseJalali(input.value);
      if (p) input.value = formatJalali(p.y, p.m, p.d);
    });
  }
}

function isDateField(input: HTMLInputElement): boolean {
  if (input.dataset.calendarEnhanced === 'true') return false;
  if (input.type === 'date' || input.type === 'datetime-local' || input.type === 'month' || input.type === 'time') return false;
  if (input.disabled || input.readOnly || input.hidden) return false;
  const id = (input.id || '').toLowerCase();
  const name = (input.name || '').toLowerCase();
  const placeholder = input.placeholder || '';
  const label = input.closest('label')?.textContent || '';
  return (
    input.id === 'invoiceDate' ||
    input.id === 'jeDate' ||
    input.id === 'fyStart' ||
    input.id === 'fyEnd' ||
    input.id === 'arFrom' ||
    input.id === 'arTo' ||
    input.id === 'opDate' ||
    input.id === 'settlementDueDate' ||
    /(^|[-_])(date|from|to|start|end|due|expiry|issued|period)([-_]|$)/i.test(id) ||
    /(^|[-_])(date|from|to|start|end|due)([-_]|$)/i.test(name) ||
    /۱۴۰\d\s*\/|\d{4}\s*\/\d{2}\s*\/\d{2}|yyyy\s*\/\s*mm\s*\/\s*dd|140\d\s*\//i.test(placeholder) ||
    /تاریخ/.test(label)
  );
}

function enhance(input: HTMLInputElement): void {
  if (!isDateField(input)) return;
  attachJalaliCalendar(input);
}

export function enhanceDateFields(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input').forEach(enhance);
}

export function initUnifiedDatePickers(): void {
  ensureDelegation();
  enhanceDateFields(document);
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of [...record.addedNodes]) {
        if (!(node instanceof HTMLElement)) continue;
        if (node instanceof HTMLInputElement) enhance(node);
        else enhanceDateFields(node);
        // دکمه فاکتور که بعداً به DOM اضافه می‌شود
        if (node.id === 'invoiceJalaliCalendar' || node.querySelector?.('#invoiceJalaliCalendar')) {
          const inv = document.getElementById('invoiceDate');
          if (inv instanceof HTMLInputElement) {
            delete inv.dataset.calendarEnhanced;
            const btn = document.getElementById('invoiceJalaliCalendar');
            attachJalaliCalendar(inv, btn instanceof HTMLButtonElement ? btn : null);
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
