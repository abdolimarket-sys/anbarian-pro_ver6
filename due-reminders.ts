/** هشدار سررسید در ورود؛ مستقل و خاموش به‌صورت پیش‌فرض */
import { settings } from './state';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { getAgingDashboard } from './accounting-aging';
import { loadCommerceData } from './accounting-commerce';

function jalaliToday(): string {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${part('year')}/${part('month')}/${part('day')}`;
}


interface DueNotificationsAPI {
  requestPermission(): Promise<{ granted: boolean }>;
  schedule(options: { id: number; at: number; title: string; body: string }): Promise<{ scheduled: boolean }>;
  cancelAll(): Promise<{ cancelled: boolean }>;
}
const NativeDueNotifications = registerPlugin<DueNotificationsAPI>('DueNotifications');
const NATIVE_SCHEDULE_KEY = 'anbarin_due_native_scheduled_';

function jalaliToGregorianDate(jalali: string): Date | null {
  const [jy, jm, jd] = jalali.split('/').map(Number);
  if (!jy || !jm || !jd) return null;
  const center = new Date(jy + 621, 2, 20);
  let yearStart: Date | null = null;
  for (let offset = -3; offset <= 3; offset++) {
    const candidate = new Date(center.getFullYear(), center.getMonth(), center.getDate() + offset);
    const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(candidate);
    const val = (type: string) => Number(parts.find(p => p.type === type)?.value || 0);
    if (val('year') === jy && val('month') === 1 && val('day') === 1) { yearStart = candidate; break; }
  }
  if (!yearStart || jm < 1 || jm > 12 || jd < 1 || jd > (jm <= 6 ? 31 : jm <= 11 ? 30 : 30)) return null;
  const dayOfYear = (jm <= 6 ? (jm - 1) * 31 : 186 + (jm - 7) * 30) + jd - 1;
  yearStart.setDate(yearStart.getDate() + dayOfYear);
  const check = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(yearStart);
  const value = (type: string) => Number(check.find(p => p.type === type)?.value || 0);
  return value('year') === jy && value('month') === jm && value('day') === jd ? yearStart : null;
}

function stableNotificationId(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % 2000000000 + 1;
}

async function syncNativeDueNotifications(today: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!settings.dueNotificationEnabled) {
    try { await NativeDueNotifications.cancelAll(); } catch { /* native bridge may be unavailable */ }
    try { Object.keys(localStorage).filter(k => k.startsWith(NATIVE_SCHEDULE_KEY)).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
    return;
  }
  try {
    const permission = await NativeDueNotifications.requestPermission();
    if (!permission.granted) { await NativeDueNotifications.cancelAll(); return; }
    await NativeDueNotifications.cancelAll();
    try { Object.keys(localStorage).filter(k => k.startsWith(NATIVE_SCHEDULE_KEY)).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
    const dashboard = await getAgingDashboard(today);
    const commerce = await loadCommerceData();
    const chequeDocs = commerce.cashTransactions
      .filter(row => row.method === 'cheque' && row.chequeStatus === 'pending' && !!row.chequeDueDate && /^\d{4}\/\d{2}\/\d{2}$/.test(row.chequeDueDate) && row.chequeDueDate >= today)
      .map(row => ({ key: `cheque:${row.id}:${row.chequeDueDate}`, date: row.chequeDueDate!, title: 'سررسید چک', body: `چک ${row.chequeNumber || row.number} · ${commerce.parties.find(p => p.id === row.partyId)?.name || '—'}` }));
    const docs = [
      ...dashboard.invoices.filter(row => row.dueDate >= today).map(row => ({ key: `invoice:${row.invoiceId}:${row.dueDate}`, date: row.dueDate, title: 'سررسید فاکتور', body: `فاکتور ${row.number} · ${row.partyName}` })),
      ...chequeDocs,
    ].slice(0, 100);
    const [hourText, minuteText] = (settings.dueNotificationTime || '09:00').split(':');
    const parsedHour = Number(hourText);
    const hour = Number.isFinite(parsedHour) ? Math.min(23, Math.max(0, parsedHour)) : 9;
    const minute = Math.min(59, Math.max(0, Number(minuteText) || 0));
    for (const doc of docs) {
      const marker = NATIVE_SCHEDULE_KEY + doc.key;
      try { if (localStorage.getItem(marker) === '1') continue; } catch { /* continue */ }
      const day = jalaliToGregorianDate(doc.date);
      if (!day) continue;
      day.setHours(hour, minute, 0, 0);
      const at = day.getTime() <= Date.now() ? Date.now() + 60_000 : day.getTime();
      try {
        await NativeDueNotifications.schedule({ id: stableNotificationId(doc.key), at, title: doc.title, body: doc.body });
        try { localStorage.setItem(marker, '1'); } catch { /* native schedule remains active */ }
      } catch (error) { console.warn('[Anbarin] native due notification schedule failed:', error); }
    }
  } catch (error) { console.warn('[Anbarin] native due notification sync failed:', error); }
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] || ch));
}

export async function showDueReminderOnEntry(): Promise<void> {
  const today = jalaliToday();
  await syncNativeDueNotifications(today);
  if (!settings.dueReminderEnabled) return;
  const key = `anbarin_due_reminder_${today}`;
  try { if (localStorage.getItem(key) === '1') return; } catch { /* storage may be unavailable */ }

  let dashboard;
  try { dashboard = await getAgingDashboard(today); } catch (error) {
    console.warn('[Anbarin] due reminder skipped:', error);
    return;
  }
  const overdueInvoices = dashboard.invoices.filter(row => row.overdueDays > 0);
  const overdueCheques = dashboard.overdueCheques;
  const total = overdueInvoices.length + overdueCheques.length;
  if (!total) return;

  const rows = [
    ...overdueInvoices.slice(0, 12).map(row =>
      `<tr><td>فاکتور ${esc(row.number)}</td><td>${esc(row.partyName)}</td><td>${esc(row.dueDate)}</td><td>${row.overdueDays.toLocaleString('fa-IR')}</td></tr>`),
    ...overdueCheques.slice(0, 12).map(row =>
      `<tr><td>چک ${esc(row.chequeNumber || row.number)}</td><td>${esc(row.partyName)}</td><td>${esc(row.dueDate)}</td><td>${row.overdueDays.toLocaleString('fa-IR')}</td></tr>`),
  ].join('');

  const existing = document.getElementById('anbarinDueReminder');
  existing?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'anbarinDueReminder';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:14px';
  overlay.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="dueReminderTitle" style="width:min(760px,100%);max-height:85vh;overflow:auto;background:var(--card,#fff);color:var(--text,#123);border:1px solid var(--border,#ddd);border-radius:14px;padding:16px;box-shadow:0 16px 44px rgba(0,0,0,.25)">
    <h2 id="dueReminderTitle" style="margin:0 0 8px;font-size:1.1rem">یادآوری سررسید</h2>
    <p style="margin:0 0 12px">امروز ${esc(today)}، تعداد <strong>${total.toLocaleString('fa-IR')}</strong> سند دارای سررسید گذشته وجود دارد.</p>
    <div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:.86rem"><thead><tr><th>سند</th><th>طرف حساب</th><th>سررسید</th><th>روز تأخیر</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button type="button" class="btn btn-primary" id="dueReminderClose">متوجه شدم</button></div>
  </section>`;
  document.body.appendChild(overlay);
  const close = () => {
    try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    overlay.remove();
  };
  overlay.querySelector('#dueReminderClose')?.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
}


/** همگام‌سازی مجدد اعلان‌ها پس از تغییر تنظیمات */
export async function syncDueNotificationsNow(): Promise<void> {
  await syncNativeDueNotifications(jalaliToday());
}
window.addEventListener('anbarin:settings-saved', () => { void syncDueNotificationsNow(); });
