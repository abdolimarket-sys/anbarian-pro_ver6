/**
 * تبدیل selectهای طولانی به کادر جستجوپذیر
 * مقدار و رویداد change همان select اصلی حفظ می‌شود تا بقیه کدها نشکنند.
 */

/** نرمال‌سازی متن برای جستجوی فارسی/عربی (ک/ك، ی/ي، ارقام، فاصله‌ها) */
export function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    // ی عربی/فارسی و اشکال مشابه
    .replace(/[یيىئ]/g, 'ی')
    // ک عربی/فارسی
    .replace(/[کكڪ]/g, 'ک')
    // الف و همزه
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ةهۀ]/g, 'ه')
    .replace(/[ؤ]/g, 'و')
    // حذف کشیده، نیم‌فاصله و نویسه‌های نامرئی
    .replace(/[ـ‌‏‎‪-‮⁦-⁩]/g, ' ')
    // ارقام فارسی و عربی → لاتین
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

type EnhanceOptions = {
  placeholder?: string;
  /** اگر تعداد گزینه‌ها کمتر از این باشد، جستجو فعال نمی‌شود */
  minOptions?: number;
  /** حداکثر تعداد پیشنهاد همزمان */
  maxVisible?: number;
};

const enhanced = new WeakMap<HTMLSelectElement, { destroy: () => void; refresh: () => void }>();

/**
 * یک <select> را جستجوپذیر می‌کند.
 * می‌توان بارها صدا زد؛ در صورت پر شدن دوبارهٔ گزینه‌ها، لیست تازه‌سازی می‌شود.
 */
export function enhanceSelectWithSearch(
  select: HTMLSelectElement | null | undefined,
  opts: EnhanceOptions = {}
): void {
  if (!select || !(select instanceof HTMLSelectElement)) return;
  // ثابت برای narrowing داخل closureهای تو در تو (رفع خطای TS strict null)
  const sel: HTMLSelectElement = select;

  const existing = enhanced.get(sel);
  if (existing) {
    existing.refresh();
    return;
  }

  const placeholder = opts.placeholder || 'جستجو و انتخاب...';
  const minOptions = opts.minOptions ?? 8;
  const maxVisible = opts.maxVisible ?? 50;

  // اگر گزینه‌ها کم است، نیازی به جستجو نیست
  if (sel.options.length < minOptions) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-select';
  wrapper.style.cssText =
    'position:relative;width:100%;display:block;';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = sel.className || 'search-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.style.cssText = 'width:100%;box-sizing:border-box;';

  const list = document.createElement('div');
  list.className = 'searchable-select-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  list.style.cssText =
    'position:absolute;z-index:40;left:0;right:0;top:calc(100% + 4px);max-height:240px;overflow:auto;' +
    'background:var(--bg,#fff);border:1px solid var(--border,#ccc);border-radius:10px;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.12);padding:4px;';

  // select اصلی را مخفی نگه می‌داریم ولی در DOM می‌ماند
  sel.style.position = 'absolute';
  sel.style.opacity = '0';
  sel.style.pointerEvents = 'none';
  sel.style.width = '1px';
  sel.style.height = '1px';
  sel.tabIndex = -1;

  const parent = sel.parentElement;
  if (!parent) return;
  parent.insertBefore(wrapper, sel);
  wrapper.appendChild(input);
  wrapper.appendChild(list);
  wrapper.appendChild(sel);

  let activeIndex = -1;

  function currentLabel(): string {
    const opt = sel.selectedOptions[0];
    return opt && opt.value ? opt.textContent || '' : '';
  }

  function syncInputFromSelect(): void {
    input.value = currentLabel();
  }

  function optionItems(): { value: string; label: string }[] {
    return Array.from(sel.options).map((o) => ({
      value: o.value,
      label: o.textContent || '',
    }));
  }

  function filteredItems(q: string): { value: string; label: string }[] {
    const items = optionItems().filter((it) => it.value !== '' || it.label);
    if (!q.trim()) return items.slice(0, maxVisible);
    const tokens = normalizeSearchText(q)
      .split(' ')
      .filter(Boolean);
    return items
      .filter((it) => {
        const hay = normalizeSearchText(it.label + ' ' + it.value);
        return tokens.every((t) => hay.includes(t));
      })
      .slice(0, maxVisible);
  }

  function renderList(q: string, keepIndex = false): void {
    const items = filteredItems(q);
    if (!keepIndex) activeIndex = items.length ? 0 : -1;
    if (!items.length) {
      list.innerHTML =
        '<div style="padding:10px 12px;color:var(--muted,#666);font-size:13px">موردی پیدا نشد</div>';
      list.hidden = false;
      return;
    }
    list.innerHTML = items
      .map(
        (it, i) =>
          `<button type="button" role="option" data-value="${escapeAttr(it.value)}" data-idx="${i}" ` +
          `class="searchable-select-item${i === activeIndex ? ' active' : ''}" ` +
          `style="display:block;width:100%;text-align:right;padding:9px 12px;border:0;border-radius:8px;` +
          `background:${i === activeIndex ? 'var(--primary-soft,#e8f0fe)' : 'transparent'};` +
          `color:var(--text,#222);cursor:pointer;font:inherit;">${escapeHtml(it.label || '—')}</button>`
      )
      .join('');
    list.hidden = false;
    list.querySelectorAll<HTMLButtonElement>('[data-value]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(btn.dataset.value || '');
      });
    });
  }

  function pick(value: string): void {
    const prev = sel.value;
    sel.value = value;
    syncInputFromSelect();
    list.hidden = true;
    activeIndex = -1;
    if (prev !== value) {
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    input.blur();
  }

  function openList(): void {
    renderList(input.value, false);
  }

  input.addEventListener('focus', () => {
    openList();
    // برای راحتی، متن انتخاب شود تا سریع جایگزین شود
    requestAnimationFrame(() => input.select());
  });

  input.addEventListener('input', () => {
    renderList(input.value, false);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      openList();
      e.preventDefault();
      return;
    }
    const items = list.querySelectorAll<HTMLButtonElement>('[data-value]');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!items.length) return;
      activeIndex = Math.min(items.length - 1, activeIndex + 1);
      highlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeIndex = Math.max(0, activeIndex - 1);
      highlight(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const btn = items[activeIndex];
      if (btn) pick(btn.dataset.value || '');
    } else if (e.key === 'Escape') {
      list.hidden = true;
      syncInputFromSelect();
      input.blur();
    }
  });

  function highlight(items: NodeListOf<HTMLButtonElement>): void {
    items.forEach((btn, i) => {
      const on = i === activeIndex;
      btn.classList.toggle('active', on);
      btn.style.background = on ? 'var(--primary-soft,#e8f0fe)' : 'transparent';
      if (on) btn.scrollIntoView({ block: 'nearest' });
    });
  }

  // کلیک بیرون
  const onDocPointer = (e: Event) => {
    if (!wrapper.contains(e.target as Node)) {
      list.hidden = true;
      syncInputFromSelect();
    }
  };
  document.addEventListener('pointerdown', onDocPointer, true);

  // اگر مقدار select از بیرون عوض شد
  sel.addEventListener('change', syncInputFromSelect);

  function refresh(): void {
    // اگر گزینه‌ها کم شد، به حالت عادی برگرد
    if (sel.options.length < minOptions) {
      destroy();
      return;
    }
    syncInputFromSelect();
  }

  function destroy(): void {
    document.removeEventListener('pointerdown', onDocPointer, true);
    // بازگرداندن select
    sel.style.position = '';
    sel.style.opacity = '';
    sel.style.pointerEvents = '';
    sel.style.width = '';
    sel.style.height = '';
    sel.tabIndex = 0;
    if (wrapper.parentElement) {
      wrapper.parentElement.insertBefore(sel, wrapper);
      wrapper.remove();
    }
    enhanced.delete(sel);
  }

  enhanced.set(sel, { destroy, refresh });
  syncInputFromSelect();
}

/** بعد از پر کردن دوبارهٔ options صدا بزنید */
export function refreshSearchableSelect(select: HTMLSelectElement | null | undefined): void {
  if (!select) return;
  const rec = enhanced.get(select);
  if (rec) rec.refresh();
  else enhanceSelectWithSearch(select);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
