/**
 * ماژول ارسال پیامک انبارین
 * - device: باز کردن برنامه پیامک گوشی
 * - kavenegar: کاوه‌نگار
 * - faraz: فراز اس‌ام‌اس (IPPanel)
 * - melipayamak: ملی‌پیامک
 * - custom: وب‌هوک JSON دلخواه
 *
 * پیش‌فرض خاموش است و روی بقیه بخش‌ها اثر نمی‌گذارد.
 */

import { settings } from './state';
import { toast } from './ui';

export type SmsProvider = 'device' | 'kavenegar' | 'faraz' | 'melipayamak' | 'custom';

export interface SmsPayload {
  phone: string;
  message: string;
}

export interface SmsTemplateVars {
  name?: string;
  amount?: string | number;
  date?: string;
  number?: string;
  balance?: string | number;
  business?: string;
  [key: string]: string | number | undefined;
}

/** نرمال‌سازی شماره موبایل ایران به 09xxxxxxxxx */
export function normalizeIranMobile(raw: string): string | null {
  let s = String(raw || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s\-()]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  if (s.startsWith('98') && s.length >= 12) s = '0' + s.slice(2);
  if (s.startsWith('9') && s.length === 10) s = '0' + s;
  if (!/^09\d{9}$/.test(s)) return null;
  return s;
}

export function isSmsConfigured(): boolean {
  if (!settings.smsEnabled) return false;
  const provider = (settings.smsProvider || 'device') as SmsProvider;
  if (provider === 'device') return true;
  if (provider === 'kavenegar') return !!(settings.smsApiKey || '').trim();
  if (provider === 'faraz') return !!(settings.smsApiKey || '').trim();
  if (provider === 'melipayamak') {
    return !!(settings.smsUsername || '').trim() && !!(settings.smsApiKey || '').trim();
  }
  if (provider === 'custom') return !!(settings.smsCustomUrl || '').trim();
  return false;
}

export function applySmsTemplate(template: string, vars: SmsTemplateVars = {}): string {
  const map: Record<string, string> = {
    name: String(vars.name ?? ''),
    amount: String(vars.amount ?? ''),
    date: String(vars.date ?? ''),
    number: String(vars.number ?? ''),
    balance: String(vars.balance ?? ''),
    business: String(vars.business ?? settings.businessName ?? ''),
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && map[k] === undefined) map[k] = String(v);
  }
  return String(template || '')
    .replace(/\{(\w+)\}/g, (_, key: string) => (map[key] !== undefined ? map[key] : `{${key}}`))
    .trim();
}

function openDeviceSms(phone: string, message: string): void {
  const body = encodeURIComponent(message);
  const uriPrimary = `sms:${phone}?body=${body}`;
  const uriAlt = `sms:${phone}&body=${body}`;
  try {
    const a = document.createElement('a');
    a.href = uriPrimary;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    try {
      window.location.href = uriAlt;
    } catch {
      window.open(uriPrimary, '_blank');
    }
  }
}

async function readJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function sendKavenegar(phone: string, message: string): Promise<void> {
  const apiKey = (settings.smsApiKey || '').trim();
  if (!apiKey) throw new Error('کلید API کاوه‌نگار تنظیم نشده است');
  const sender = (settings.smsSender || '').trim();
  const url = `https://api.kavenegar.com/v1/${encodeURIComponent(apiKey)}/sms/send.json`;
  const body = new URLSearchParams();
  body.set('receptor', phone);
  body.set('message', message);
  if (sender) body.set('sender', sender);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString(),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error((data && (data.return?.message || data.message)) || `خطای کاوه‌نگار (${res.status})`);
  }
  const status = data?.return?.status;
  if (status !== undefined && Number(status) !== 200) {
    throw new Error(data?.return?.message || 'ارسال از کاوه‌نگار ناموفق بود');
  }
}

/**
 * فراز اس‌ام‌اس (IPPanel)
 * API کلیدمحور: Authorization: AccessKey {apiKey}
 * مستندات رایج: api2.ippanel.com
 */
async function sendFaraz(phone: string, message: string): Promise<void> {
  const apiKey = (settings.smsApiKey || '').trim();
  if (!apiKey) throw new Error('کلید API فراز اس‌ام‌اس تنظیم نشده است');
  const sender = (settings.smsSender || '').trim();
  if (!sender) throw new Error('شماره خط ارسال‌کننده فراز اس‌ام‌اس الزامی است');

  // مسیر وب‌سرویس تکی
  const url = 'https://api2.ippanel.com/api/v1/sms/send/webservice/single';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `AccessKey ${apiKey}`,
    },
    body: JSON.stringify({
      recipient: [phone],
      sender,
      message,
    }),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) {
    const msg =
      data?.message ||
      data?.error ||
      data?.meta?.message ||
      data?.data?.message ||
      `خطای فراز اس‌ام‌اس (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : 'ارسال از فراز اس‌ام‌اس ناموفق بود');
  }
  // بعضی پاسخ‌ها status/code داخلی دارند
  const code = data?.status?.code ?? data?.code ?? data?.meta?.code;
  if (code !== undefined && Number(code) >= 400) {
    throw new Error(data?.status?.message || data?.message || 'ارسال از فراز اس‌ام‌اس ناموفق بود');
  }
}

/**
 * ملی‌پیامک (Melipayamak)
 * REST: username + password + to + from + text
 */
async function sendMelipayamak(phone: string, message: string): Promise<void> {
  const username = (settings.smsUsername || '').trim();
  const password = (settings.smsApiKey || '').trim();
  if (!username || !password) {
    throw new Error('نام کاربری و رمز/کلید ملی‌پیامک را در تنظیمات وارد کنید');
  }
  const sender = (settings.smsSender || '').trim();
  if (!sender) throw new Error('شماره خط ارسال‌کننده ملی‌پیامک الزامی است');

  const url = 'https://rest.payamak-panel.com/api/SendSMS/SendSMS';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      to: phone,
      from: sender,
      text: message,
      isFlash: false,
    }),
  });
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      (data && (data.messages || data.message || data.strRetStatus)) ||
        `خطای ملی‌پیامک (${res.status})`
    );
  }
  // پاسخ موفق معمولاً مقدار عددی بلند (شناسه پیامک) یا RetStatus=1 است
  const ret = data?.RetStatus ?? data?.retStatus ?? data?.Value ?? data?.value ?? data;
  if (typeof ret === 'object' && ret !== null) {
    const status = (ret as any).RetStatus ?? (ret as any).retStatus;
    if (status !== undefined && Number(status) !== 1 && Number(status) !== 0) {
      // برخی نسخه‌ها 1 = موفق
      const msg = (ret as any).StrRetStatus || (ret as any).message || 'ارسال از ملی‌پیامک ناموفق بود';
      // اگر Value یک عدد بزرگ باشد یعنی موفق است
      const value = Number((ret as any).Value ?? (ret as any).value ?? 0);
      if (!(value > 10)) throw new Error(String(msg));
    }
  } else if (typeof ret === 'number' || (typeof ret === 'string' && /^\d+$/.test(ret))) {
    const n = Number(ret);
    // مقادیر خطای رایج ملی‌پیامک معمولاً کوچک/منفی‌اند؛ شناسه موفق بزرگ است
    if (n <= 0) throw new Error('ارسال از ملی‌پیامک ناموفق بود');
  }
}

async function sendCustom(phone: string, message: string): Promise<void> {
  const endpoint = (settings.smsCustomUrl || '').trim();
  if (!endpoint) throw new Error('آدرس سرویس پیامک تنظیم نشده است');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.smsApiKey ? { Authorization: `Bearer ${settings.smsApiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      phone,
      message,
      sender: (settings.smsSender || '').trim() || undefined,
      username: (settings.smsUsername || '').trim() || undefined,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(detail || `خطای سرویس پیامک (${res.status})`);
  }
}

export async function sendSms(payload: SmsPayload): Promise<{ ok: true; mode: SmsProvider }> {
  if (!settings.smsEnabled) {
    throw new Error('ارسال پیامک در تنظیمات غیرفعال است');
  }
  const phone = normalizeIranMobile(payload.phone);
  if (!phone) throw new Error('شماره موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷)');
  const message = String(payload.message || '').trim();
  if (!message) throw new Error('متن پیامک خالی است');
  if (message.length > 900) throw new Error('متن پیامک خیلی طولانی است');

  const provider = (settings.smsProvider || 'device') as SmsProvider;
  if (provider === 'device') {
    openDeviceSms(phone, message);
    return { ok: true, mode: 'device' };
  }
  if (provider === 'kavenegar') {
    await sendKavenegar(phone, message);
    return { ok: true, mode: 'kavenegar' };
  }
  if (provider === 'faraz') {
    await sendFaraz(phone, message);
    return { ok: true, mode: 'faraz' };
  }
  if (provider === 'melipayamak') {
    await sendMelipayamak(phone, message);
    return { ok: true, mode: 'melipayamak' };
  }
  if (provider === 'custom') {
    await sendCustom(phone, message);
    return { ok: true, mode: 'custom' };
  }
  throw new Error('ارائه‌دهنده پیامک ناشناخته است');
}

export async function sendTemplatedSms(
  phone: string,
  vars: SmsTemplateVars = {},
  template?: string
): Promise<{ ok: true; mode: SmsProvider }> {
  const tpl =
    (template || settings.smsDefaultTemplate || '').trim() || 'سلام {name}، از طرف {business}';
  const message = applySmsTemplate(tpl, vars);
  return sendSms({ phone, message });
}

export function openSmsComposeDialog(opts: {
  phone?: string;
  name?: string;
  defaultMessage?: string;
  title?: string;
}): void {
  const existing = document.getElementById('anbarinSmsDialog');
  if (existing) existing.remove();

  const phone = opts.phone || '';
  const msg =
    opts.defaultMessage ||
    applySmsTemplate(settings.smsDefaultTemplate || '', {
      name: opts.name || '',
      business: settings.businessName || '',
    });

  const wrap = document.createElement('div');
  wrap.id = 'anbarinSmsDialog';
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;';
  wrap.innerHTML = `
    <div role="dialog" aria-modal="true" style="width:min(420px,100%);background:var(--card,#fff);color:var(--text,#123);border-radius:14px;padding:16px 16px 14px;box-shadow:0 16px 40px rgba(0,0,0,.25);border:1px solid var(--border,#ddd)">
      <h3 style="margin:0 0 10px;font-size:1.05rem">${escapeHtml(opts.title || 'ارسال پیامک')}</h3>
      <label class="field" style="display:block;margin-bottom:8px">
        <span style="font-size:.82rem;color:var(--text-soft,#666)">شماره موبایل</span>
        <input id="smsDlgPhone" value="${escapeAttr(phone)}" inputmode="tel" placeholder="0912..." style="width:100%;margin-top:4px;padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);background:var(--bg,#fff);color:inherit;direction:ltr;text-align:left" />
      </label>
      <label class="field" style="display:block;margin-bottom:12px">
        <span style="font-size:.82rem;color:var(--text-soft,#666)">متن پیام</span>
        <textarea id="smsDlgMessage" rows="4" style="width:100%;margin-top:4px;padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);background:var(--bg,#fff);color:inherit;resize:vertical">${escapeHtml(msg)}</textarea>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary" id="smsDlgCancel">انصراف</button>
        <button type="button" class="btn btn-primary" id="smsDlgSend">ارسال</button>
      </div>
      <p class="hint" style="margin:10px 0 0;font-size:.78rem">اگر سرویس API تنظیم نشده باشد، برنامه پیامک گوشی باز می‌شود.</p>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.querySelector('#smsDlgCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#smsDlgSend')?.addEventListener('click', async () => {
    const p = (document.getElementById('smsDlgPhone') as HTMLInputElement | null)?.value || '';
    const m = (document.getElementById('smsDlgMessage') as HTMLTextAreaElement | null)?.value || '';
    const btn = document.getElementById('smsDlgSend') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'در حال ارسال...';
    }
    try {
      const wasEnabled = settings.smsEnabled;
      const wasProvider = settings.smsProvider;
      if (!wasEnabled) {
        settings.smsEnabled = true;
        settings.smsProvider = 'device';
      }
      const result = await sendSms({ phone: p, message: m });
      if (!wasEnabled) {
        settings.smsEnabled = wasEnabled;
        settings.smsProvider = wasProvider;
      }
      if (result.mode === 'device') toast('برنامه پیامک گوشی باز شد', 'success');
      else toast('پیامک ارسال شد', 'success');
      close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'ارسال پیامک ناموفق بود', 'error');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'ارسال';
      }
    }
  });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
