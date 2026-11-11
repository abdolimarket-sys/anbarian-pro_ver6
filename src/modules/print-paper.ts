/**
 * سایزهای استاندارد چاپ — A4، A5، لیبل ۸۰mm (۸ سانتی‌متر)
 * بدون وابستگی به بقیه ماژول‌ها؛ فقط CSS و دیالوگ انتخاب.
 */

export type PaperSizeId = 'a4' | 'a5' | 'label80';

export type PaperSizeDef = {
  id: PaperSizeId;
  /** عنوان فارسی برای UI */
  label: string;
  /** توضیح کوتاه */
  hint: string;
  /** مقدار CSS @page size */
  pageSize: string;
  /** حاشیه صفحه */
  margin: string;
  /** عرض کارت لیبل (برای چاپ بارکد) */
  labelCardWidth: string;
  /** چند لیبل در هر ردیف تقریبی */
  labelsPerRow: number;
  /** مناسب فاکتور/گزارش */
  forDocument: boolean;
  /** مناسب لیبل */
  forLabel: boolean;
};

export const PAPER_SIZES: Record<PaperSizeId, PaperSizeDef> = {
  a4: {
    id: 'a4',
    label: 'A4',
    hint: '۲۱۰×۲۹۷ میلی‌متر — گزارش و فاکتور استاندارد',
    pageSize: 'A4',
    margin: '12mm',
    labelCardWidth: '62mm',
    labelsPerRow: 3,
    forDocument: true,
    forLabel: true,
  },
  a5: {
    id: 'a5',
    label: 'A5',
    hint: '۱۴۸×۲۱۰ میلی‌متر — فاکتور فشرده',
    pageSize: 'A5',
    margin: '10mm',
    labelCardWidth: '58mm',
    labelsPerRow: 2,
    forDocument: true,
    forLabel: true,
  },
  label80: {
    id: 'label80',
    label: '۸ سانتی‌متر (۸۰mm)',
    hint: 'عرض ۸۰ میلی‌متر — پرینتر حرارتی (لیبل و فاکتور فشرده)',
    pageSize: '80mm auto',
    margin: '2mm',
    labelCardWidth: '72mm',
    labelsPerRow: 1,
    forDocument: true,
    forLabel: true,
  },
};

const STORAGE_KEY_LABEL = 'anbarin_print_size_label';
const STORAGE_KEY_DOC = 'anbarin_print_size_doc';

export function getSavedLabelPaperSize(): PaperSizeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY_LABEL) as PaperSizeId | null;
    if (v && PAPER_SIZES[v]?.forLabel) return v;
  } catch {
    /* ignore */
  }
  return 'label80';
}

export function getSavedDocPaperSize(): PaperSizeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY_DOC) as PaperSizeId | null;
    if (v && PAPER_SIZES[v]?.forDocument) return v;
  } catch {
    /* ignore */
  }
  return 'a4';
}

export function saveLabelPaperSize(id: PaperSizeId): void {
  try {
    localStorage.setItem(STORAGE_KEY_LABEL, id);
  } catch {
    /* ignore */
  }
}

export function saveDocPaperSize(id: PaperSizeId): void {
  try {
    localStorage.setItem(STORAGE_KEY_DOC, id);
  } catch {
    /* ignore */
  }
}

/** CSS مشترک @page و بدنه برای یک سایز */
export function pageCssFor(size: PaperSizeId, kind: 'label' | 'document' = 'document'): string {
  const def = PAPER_SIZES[size] || PAPER_SIZES.a4;
  if (kind === 'label' && size === 'label80') {
    return `
@page { size: 80mm auto; margin: 2mm; }
html, body {
  width: 76mm;
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
}
.label-sheet { width: 76mm; margin: 0; padding: 0; }
.label-card {
  width: 72mm !important;
  max-width: 72mm !important;
  margin: 0 0 3mm 0 !important;
  padding: 2mm !important;
  border: 1px dashed #94a3b8;
  border-radius: 4px;
  page-break-after: always;
  break-after: page;
  display: block !important;
  box-sizing: border-box;
}
.label-card:last-child { page-break-after: auto; break-after: auto; }
`;
  }
  return `
@page { size: ${def.pageSize}; margin: ${def.margin}; }
html, body {
  margin: 0;
  padding: 0;
  background: #fff;
  color: #000;
}
.label-sheet { width: 100%; }
.label-card {
  width: ${def.labelCardWidth} !important;
  max-width: ${def.labelCardWidth} !important;
  margin: 3mm !important;
  padding: 3mm !important;
  border: 1px dashed #94a3b8;
  border-radius: 6px;
  display: inline-block !important;
  vertical-align: top;
  box-sizing: border-box;
  page-break-inside: avoid;
  break-inside: avoid;
}
`;
}

/**
 * دیالوگ ساده انتخاب سایز چاپ.
 * Promise با سایز انتخاب‌شده resolve می‌شود؛ در انصراف null.
 */
export function choosePaperSize(opts: {
  mode: 'label' | 'document';
  title?: string;
}): Promise<PaperSizeId | null> {
  return new Promise((resolve) => {
    const existing = document.getElementById('anbarinPrintSizeModal');
    if (existing) existing.remove();

    const defaultId = opts.mode === 'label' ? getSavedLabelPaperSize() : getSavedDocPaperSize();
    const sizes = (Object.values(PAPER_SIZES) as PaperSizeDef[]).filter((s) =>
      opts.mode === 'label' ? s.forLabel : s.forDocument
    );

    const overlay = document.createElement('div');
    overlay.id = 'anbarinPrintSizeModal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:50000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;';

    const card = document.createElement('div');
    card.style.cssText =
      'background:var(--bg,#fff);color:var(--text,#0f172a);border-radius:14px;max-width:420px;width:100%;' +
      'box-shadow:0 20px 50px rgba(0,0,0,.25);padding:18px 16px;direction:rtl;font-family:inherit;';

    card.innerHTML = `
      <h3 style="margin:0 0 6px;font-size:1.05rem">${opts.title || 'انتخاب سایز چاپ'}</h3>
      <p style="margin:0 0 14px;font-size:.85rem;color:var(--muted,#64748b)">سایز مناسب کاغذ یا رول پرینتر را انتخاب کنید.</p>
      <div id="printSizeOptions" style="display:flex;flex-direction:column;gap:8px"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button type="button" id="printSizeCancel" class="btn btn-secondary" style="min-width:88px">انصراف</button>
        <button type="button" id="printSizeOk" class="btn btn-primary" style="min-width:88px">چاپ</button>
      </div>
    `;

    const optionsHost = card.querySelector('#printSizeOptions')!;
    let selected = defaultId;

    sizes.forEach((s) => {
      const row = document.createElement('label');
      row.style.cssText =
        'display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--border,#e2e8f0);' +
        'border-radius:10px;cursor:pointer;background:var(--card,#f8fafc)';
      if (s.id === selected) row.style.borderColor = 'var(--primary,#2563eb)';
      row.innerHTML = `
        <input type="radio" name="anbarinPaperSize" value="${s.id}" ${s.id === selected ? 'checked' : ''} style="margin-top:3px" />
        <span>
          <strong style="display:block">${s.label}</strong>
          <small style="color:var(--muted,#64748b)">${s.hint}</small>
        </span>
      `;
      row.addEventListener('click', () => {
        selected = s.id;
        optionsHost.querySelectorAll('label').forEach((l) => {
          (l as HTMLElement).style.borderColor = 'var(--border,#e2e8f0)';
        });
        row.style.borderColor = 'var(--primary,#2563eb)';
        const input = row.querySelector('input') as HTMLInputElement;
        if (input) input.checked = true;
      });
      optionsHost.appendChild(row);
    });

    const close = (value: PaperSizeId | null) => {
      overlay.remove();
      resolve(value);
    };

    card.querySelector('#printSizeCancel')?.addEventListener('click', () => close(null));
    card.querySelector('#printSizeOk')?.addEventListener('click', () => {
      if (opts.mode === 'label') saveLabelPaperSize(selected);
      else saveDocPaperSize(selected);
      close(selected);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  });
}

/** تزریق سایز صفحه به HTML کامل چاپ (اگر از قبل @page نداشت، اضافه می‌کند) */
export function injectPageSize(html: string, size: PaperSizeId, kind: 'label' | 'document' = 'document'): string {
  const css = pageCssFor(size, kind);
  if (/@page\s*\{/.test(html)) {
    return html.replace(/@page\s*\{[^}]*\}/g, `@page { size: ${PAPER_SIZES[size].pageSize}; margin: ${PAPER_SIZES[size].margin}; }`);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `<style>${css}</style></head>`);
  }
  return `<style>${css}</style>` + html;
}
