/** Local-device accounts. This is a convenience gate, not server-grade identity/security. */
import { PERMISSION_LABELS, authorizeLocally, setLocalPermissionOverrides, type AppRole, type Permission, type PermissionOverrides } from './authorization';
import { settings, saveSettingsNow, logAudit } from './state';
import { setOperatorName } from './storage';
import { toast } from './ui';
import { applyRoleUI } from './filters-roles';
import { Capacitor, registerPlugin } from '@capacitor/core';

type LocalUser = { id: string; username: string; name: string; role: AppRole; permissionOverrides?: PermissionOverrides; salt: string; hash: string; disabled: boolean; createdAt: string };
const USERS_KEY = 'anbarin_local_users_v1';
let users: LocalUser[] = [];
let activeUser: LocalUser | null = null;

interface BiometricAuthAPI {
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  authenticate(options?: { title?: string; subtitle?: string }): Promise<{ ok: boolean; cancelled?: boolean }>;
}
const NativeBiometric = registerPlugin<BiometricAuthAPI>('BiometricAuth');
const BIO_ENABLED_KEY = 'anbarin_biometric_enabled';
const BIO_USER_KEY = 'anbarin_biometric_user_id';

function isBiometricEnabled(): boolean {
  return localStorage.getItem(BIO_ENABLED_KEY) === '1' && !!localStorage.getItem(BIO_USER_KEY);
}
function setBiometricForUser(userId: string, enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(BIO_ENABLED_KEY, '1');
    localStorage.setItem(BIO_USER_KEY, userId);
  } else {
    localStorage.removeItem(BIO_ENABLED_KEY);
    localStorage.removeItem(BIO_USER_KEY);
  }
}
async function deviceBiometricAvailable(): Promise<boolean> {
  if (!(Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android')) return false;
  try {
    const s = await NativeBiometric.isAvailable();
    return !!s.available;
  } catch {
    return false;
  }
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function readUsers(): LocalUser[] {
  try { const value = JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); return Array.isArray(value) ? value.filter(u => u && typeof u.username === 'string' && typeof u.hash === 'string') : []; }
  catch { return []; }
}
async function hashPassword(password: string, salt: Uint8Array): Promise<string> {
  if (!crypto?.subtle) throw new Error('مرورگر از رمزنگاری امن پشتیبانی نمی‌کند');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 180000, hash: 'SHA-256' }, key, 256);
  return b64(new Uint8Array(bits));
}
function persist(): void { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }
function showGate(): void {
  document.getElementById('localAuthGate')?.remove();
  const gate = document.createElement('div'); gate.id = 'localAuthGate'; gate.className = 'local-auth-gate';
  const first = users.length === 0;
  gate.innerHTML = `<form class="local-auth-card" id="localAuthForm">
    <div class="local-auth-mark">انبارین پرو</div>
    <h2>${first ? 'خوش آمدید — ساخت مدیر اصلی' : 'ورود به برنامه'}</h2>
    <p>${first
      ? 'برای اولین استفاده، یک حساب مدیر روی این دستگاه بسازید. بعد از ورود می‌توانید کالاها، فروشگاه و فاکتورها را تنظیم کنید.'
      : 'برای ادامه، نام کاربری و رمز عبور را وارد کنید.'}</p>
    ${first ? '<label>نام نمایشی<input name="name" required maxlength="60" autocomplete="name" placeholder="مثلاً مدیر فروشگاه"></label>' : ''}
    <label>نام کاربری<input name="username" required maxlength="40" autocomplete="username" autocapitalize="none" placeholder="بدون فاصله"></label>
    <label>رمز عبور<input name="password" type="password" required minlength="8" autocomplete="${first ? 'new-password' : 'current-password'}" placeholder="حداقل ۸ نویسه"></label>
    ${first ? '<label>تکرار رمز عبور<input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>' : ''}
    <p class="local-auth-error" id="localAuthError" role="alert"></p>
    <button class="btn btn-primary btn-block" type="submit">${first ? 'ایجاد حساب و ورود' : 'ورود با رمز'}</button>
    ${!first ? '<button class="btn btn-secondary btn-block" type="button" id="localAuthBiometricBtn" style="margin-top:8px;display:none">ورود با اثرانگشت / چهره</button>' : ''}
    <small>${first
      ? 'حساب روی این دستگاه است. برنامه در Documents/AnbarinBackups پشتیبان خودکار می‌گیرد. پس از ورود کالا و مشخصات فروشگاه را تکمیل کنید.'
      : 'می‌توانید بعد از ورود با رمز، ورود بیومتریک را فعال کنید. پشتیبان خودکار در اندروید فعال است.'}</small>
  </form>`;
  document.body.appendChild(gate);
  const form = gate.querySelector('form')!;
  void setupBiometricGateButton(gate);
  form.addEventListener('submit', async e => {
    e.preventDefault(); const data = new FormData(form); const username = String(data.get('username') || '').trim().toLowerCase(); const password = String(data.get('password') || '');
    const error = gate.querySelector('#localAuthError')!; error.textContent = '';
    let isFirstAccount = first;
    try {
      if (first) {
        const name = String(data.get('name') || '').trim();
        if (password !== String(data.get('confirm') || '')) throw new Error('تکرار رمز عبور یکسان نیست.');
        if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username)) throw new Error('نام کاربری باید ۳ تا ۴۰ نویسه و بدون فاصله باشد.');
        if (password.length < 8) throw new Error('رمز عبور باید حداقل ۸ نویسه باشد.');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        users = [{ id: crypto.randomUUID(), username, name: name || 'مدیر', role: 'admin', salt: b64(salt), hash: await hashPassword(password, salt), disabled: false, createdAt: new Date().toISOString() }]; persist();
        isFirstAccount = true;
      }
      const user = users.find(u => u.username === username && !u.disabled);
      if (!user || await hashPassword(password, unb64(user.salt)) !== user.hash) throw new Error('نام کاربری یا رمز عبور نادرست است.');
      activate(user, { isFirstAccount });
    } catch (err) { error.textContent = err instanceof Error ? err.message : 'ورود انجام نشد.'; }
  });
}
async function setupBiometricGateButton(gate: HTMLElement): Promise<void> {
  const btn = gate.querySelector('#localAuthBiometricBtn') as HTMLButtonElement | null;
  if (!btn) return;
  if (!isBiometricEnabled()) return;
  const ok = await deviceBiometricAvailable();
  if (!ok) return;
  btn.style.display = 'block';
  btn.addEventListener('click', async () => {
    const error = gate.querySelector('#localAuthError') as HTMLElement | null;
    if (error) error.textContent = '';
    try {
      const result = await NativeBiometric.authenticate({
        title: 'ورود به انبارین',
        subtitle: 'با اثرانگشت، چهره یا رمز قفل صفحه تأیید کنید',
      });
      if (!result.ok) return;
      const userId = localStorage.getItem(BIO_USER_KEY) || '';
      const user = users.find(u => u.id === userId && !u.disabled);
      if (!user) {
        setBiometricForUser('', false);
        if (error) error.textContent = 'حساب بیومتریک پیدا نشد؛ با رمز وارد شوید.';
        btn.style.display = 'none';
        return;
      }
      activate(user, { isFirstAccount: false, viaBiometric: true });
    } catch (e) {
      if (error) error.textContent = e instanceof Error ? e.message : 'احراز هویت بیومتریک ناموفق بود.';
    }
  });
  // کاربر دکمه بیومتریک را می‌زند؛ از اجرای خودکار خودداری می‌کنیم تا با فرم رمز تداخل نداشته باشد
}

function activate(user: LocalUser, opts?: { isFirstAccount?: boolean; viaBiometric?: boolean; offerBiometric?: boolean }): void {
  activeUser = user; setLocalPermissionOverrides(user.permissionOverrides); settings.role = user.role; saveSettingsNow(); setOperatorName(user.name);
  const roleSelect = document.getElementById('setRole') as HTMLSelectElement | null; if (roleSelect) { roleSelect.value = user.role; roleSelect.disabled = true; roleSelect.title = 'نقش از حساب کاربری تعیین می‌شود'; }
  logAudit(opts?.viaBiometric ? 'ورود بیومتریک' : 'ورود کاربر', { username: user.username, role: user.role });
  document.getElementById('localAuthGate')?.remove(); updateAccountBadge(); renderUsers(); applyRoleUI();
  window.dispatchEvent(new CustomEvent('anbarin:auth-ready', {
    detail: { username: user.username, name: user.name, role: user.role, isFirstAccount: !!opts?.isFirstAccount },
  }));
  if (!opts?.viaBiometric) {
    void maybeOfferBiometric(user);
  }
}

async function maybeOfferBiometric(user: LocalUser): Promise<void> {
  if (!(await deviceBiometricAvailable())) return;
  if (isBiometricEnabled() && localStorage.getItem(BIO_USER_KEY) === user.id) return;
  const enable = confirm('ورود سریع با اثرانگشت / چهره برای دفعات بعد فعال شود؟');
  if (!enable) return;
  setBiometricForUser(user.id, true);
  toast('ورود بیومتریک فعال شد', 'success');
}
function updateAccountBadge(): void {
  let button = document.getElementById('localAuthLock') as HTMLButtonElement | null;
  if (!button) { button = document.createElement('button'); button.id = 'localAuthLock'; button.className = 'btn btn-sm btn-secondary local-auth-lock'; document.body.appendChild(button); }
  button.textContent = activeUser ? `🔒 ${activeUser.name} · خروج` : 'قفل برنامه';
  button.onclick = () => { if (!activeUser) return; logAudit('خروج کاربر', { username: activeUser.username }); activeUser = null; showGate(); };
}
export function initLocalAuth(): void {
  users = readUsers(); activeUser = null; setLocalPermissionOverrides({}); showGate(); updateAccountBadge();
  const roleSelect = document.getElementById('setRole') as HTMLSelectElement | null; if (roleSelect) roleSelect.disabled = true;
  const settingsCard = document.querySelector('#roleSettingsPanel');
  if (settingsCard && !document.getElementById('localUsersPanel')) {
    const panel = document.createElement('div'); panel.id = 'localUsersPanel'; panel.className = 'local-users-panel';
    panel.innerHTML = `<h3>کاربران و سطح دسترسی</h3><p>برای هر حساب می‌توانید مجوزهای دقیق را مستقل از نقش پایه تنظیم کنید. مدیر اصلی دسترسی کامل دارد.</p><div id="localUsersList"></div><button class="btn btn-secondary btn-block" id="localAddUser">＋ افزودن کاربر</button><button class="btn btn-secondary btn-block" id="localChangePassword">تغییر رمز حساب من</button><button class="btn btn-secondary btn-block" id="localToggleBiometric">اثرانگشت / چهره</button><small>حساب‌ها و مجوزها محلی هستند؛ برای امنیت سازمانی، احراز هویت و کنترل دسترسی سمت سرور لازم است.</small>`;
    settingsCard.parentElement?.appendChild(panel);
    panel.querySelector('#localAddUser')?.addEventListener('click', () => openUserEditor());
    panel.querySelector('#localToggleBiometric')?.addEventListener('click', async () => {
      if (!activeUser) return;
      if (!(await deviceBiometricAvailable())) return toast('بیومتریک روی این دستگاه در دسترس نیست', 'error');
      if (isBiometricEnabled() && localStorage.getItem(BIO_USER_KEY) === activeUser.id) {
        setBiometricForUser('', false);
        toast('ورود بیومتریک خاموش شد', 'info');
      } else {
        setBiometricForUser(activeUser.id, true);
        toast('ورود بیومتریک برای این حساب فعال شد', 'success');
      }
    });
    panel.querySelector('#localChangePassword')?.addEventListener('click', async () => {
      if (!activeUser) return; const old = prompt('رمز فعلی:') || ''; if (await hashPassword(old, unb64(activeUser.salt)) !== activeUser.hash) return toast('رمز فعلی اشتباه است', 'error');
      const next = prompt('رمز جدید (حداقل ۸ نویسه):') || ''; if (next.length < 8) return toast('رمز جدید کوتاه است', 'error'); const salt = crypto.getRandomValues(new Uint8Array(16)); activeUser.salt = b64(salt); activeUser.hash = await hashPassword(next, salt); persist(); toast('رمز تغییر کرد', 'success');
    });
    renderUsers();
  }
}
function openUserEditor(existing?: LocalUser): void {
  if (!activeUser || !authorizeLocally(settings, 'users.manage').allowed || !authorizeLocally(settings, 'roles.assign').allowed) return toast('مجوز مدیریت کاربران یا تعیین نقش را ندارید', 'error');
  const old = document.getElementById('localUserEditor'); old?.remove();
  const editor = document.createElement('div'); editor.id = 'localUserEditor'; editor.className = 'local-auth-gate';
  const role = existing?.role || 'counter';
  const permissionRows = (Object.entries(PERMISSION_LABELS) as [Permission, string][]).map(([key, label]) => {
    const checked = existing ? (existing.permissionOverrides?.[key] ?? roleDefault(role, key)) : roleDefault(role, key);
    return `<label class="local-permission-option${checked ? ' is-on' : ''}"><input type="checkbox" name="permission" value="${key}" ${checked ? 'checked' : ''}><span class="local-permission-check" aria-hidden="true"></span><span class="local-permission-text">${label}</span></label>`;
  }).join('');
  editor.innerHTML = `<form class="local-auth-card local-user-editor-card"><h2>${existing ? 'ویرایش دسترسی کاربر' : 'افزودن کاربر'}</h2>
    <div class="local-user-editor-fields">
      <label class="local-field">نام نمایشی<input name="name" required maxlength="60" value="${escapeAttr(existing?.name || '')}"></label>
      <label class="local-field">نام کاربری<input name="username" required maxlength="40" ${existing ? 'readonly' : ''} value="${escapeAttr(existing?.username || '')}"></label>
      ${existing ? '' : '<label class="local-field">رمز اولیه<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>'}
      <label class="local-field local-field-role"><span class="local-field-label">نقش پایه</span>
        <select name="role" class="local-role-select">
          <option value="counter" ${role === 'counter' ? 'selected' : ''}>شمارنده</option>
          <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>مشاهده‌گر</option>
          <option value="admin" ${role === 'admin' ? 'selected' : ''}>مدیر</option>
        </select>
        <small class="local-field-hint">نقش پایه پیش‌فرض مجوزها را مشخص می‌کند؛ بعد می‌توانید تیک‌ها را شخصی‌سازی کنید.</small>
      </label>
    </div>
    <section class="local-permission-section" aria-labelledby="localPermTitle">
      <div class="local-permission-head">
        <h3 id="localPermTitle">مجوزهای اختصاصی</h3>
        <p>تیک فعال = اجازه دارد · بدون تیک = مسدود. مدیر اصلی همیشه دسترسی کامل دارد.</p>
      </div>
      <div class="local-permission-grid">${permissionRows}</div>
    </section>
    <p class="local-auth-error" id="localUserEditorError" role="alert"></p>
    <div class="local-user-editor-actions"><button class="btn btn-primary" type="submit">ذخیره</button><button class="btn btn-secondary" type="button" id="localUserEditorCancel">انصراف</button></div></form>`;
  document.body.appendChild(editor);
  const form = editor.querySelector('form')!;
  form.querySelectorAll<HTMLInputElement>('input[name="permission"]').forEach((input) => {
    input.addEventListener('change', () => {
      input.closest('.local-permission-option')?.classList.toggle('is-on', input.checked);
    });
  });
  form.querySelector('#localUserEditorCancel')?.addEventListener('click', () => editor.remove());
  const roleSelect = form.querySelector('[name="role"]') as HTMLSelectElement;
  roleSelect.addEventListener('change', () => {
    const roleNow = roleSelect.value as AppRole;
    form.querySelectorAll<HTMLInputElement>('input[name="permission"]').forEach(input => {
      input.checked = roleDefault(roleNow, input.value as Permission);
      input.closest('.local-permission-option')?.classList.toggle('is-on', input.checked);
    });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form); const username = String(data.get('username') || '').trim().toLowerCase();
    const name = String(data.get('name') || '').trim(); const nextRole = String(data.get('role')) as AppRole;
    const error = form.querySelector('#localUserEditorError')!; error.textContent = '';
    if (!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username)) { error.textContent = 'نام کاربری باید ۳ تا ۴۰ نویسه و بدون فاصله باشد.'; return; }
    if (!existing && users.some(u => u.username === username)) { error.textContent = 'این نام کاربری قبلاً ثبت شده است.'; return; }
    if (!['admin','counter','viewer'].includes(nextRole)) { error.textContent = 'نقش انتخاب‌شده معتبر نیست.'; return; }
    const selected = new Set(data.getAll('permission').map(String));
    const overrides: PermissionOverrides = {};
    (Object.keys(PERMISSION_LABELS) as Permission[]).forEach(key => { overrides[key] = selected.has(key); });
    try {
      if (existing) {
        existing.name = name || username; existing.role = nextRole; existing.permissionOverrides = overrides;
        logAudit('تغییر مجوز کاربر', { username, role: nextRole, permissions: Array.from(selected) });
      } else {
        const password = String(data.get('password') || '');
        if (password.length < 8) { error.textContent = 'رمز عبور باید حداقل ۸ نویسه باشد.'; return; }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        users.push({ id: crypto.randomUUID(), username, name: name || username, role: nextRole, permissionOverrides: overrides,
          salt: b64(salt), hash: await hashPassword(password, salt), disabled: false, createdAt: new Date().toISOString() });
        logAudit('ایجاد کاربر', { username, role: nextRole, permissions: Array.from(selected) });
      }
      persist(); editor.remove(); renderUsers(); toast(existing ? 'مجوزهای کاربر ذخیره شد' : 'کاربر ساخته شد', 'success');
    } catch (err) { error.textContent = err instanceof Error ? err.message : 'ذخیره انجام نشد.'; }
  });
}
function roleDefault(role: AppRole, permission: Permission): boolean {
  const defaults: Record<AppRole, Permission[]> = {
    admin: Object.keys(PERMISSION_LABELS) as Permission[],
    counter: ['inventory.read','inventory.count','inventory.export','session.start','session.close','team.sync','audit.read'],
    viewer: ['inventory.read','inventory.export','audit.read'],
  };
  return defaults[role].includes(permission);
}
function escapeAttr(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, ch => entities[ch] || ch);
}
function renderUsers(): void {
  const list = document.getElementById('localUsersList'); if (!list) return; list.replaceChildren();
  for (const user of users) {
    const row = document.createElement('div'); row.className = 'local-user-row';
    const granted = user.permissionOverrides ? Object.values(user.permissionOverrides).filter(Boolean).length : 'پیش‌فرض نقش';
    const label = document.createElement('span'); label.textContent = `${user.name} (${user.username}) · ${user.role} · ${granted} مجوز${user.disabled ? ' · غیرفعال' : ''}`; row.append(label);
    if (activeUser && user.id !== activeUser.id && authorizeLocally(settings, 'users.manage').allowed) {
      if (authorizeLocally(settings, 'roles.assign').allowed) { const edit = document.createElement('button'); edit.className = 'btn btn-sm btn-secondary'; edit.textContent = 'مجوزها'; edit.onclick = () => openUserEditor(user); row.append(edit); }
      const toggle = document.createElement('button'); toggle.className = 'btn btn-sm btn-secondary'; toggle.textContent = user.disabled ? 'فعال‌سازی' : 'غیرفعال‌سازی'; toggle.onclick = () => {
        user.disabled = !user.disabled; persist(); logAudit(user.disabled ? 'غیرفعال‌سازی کاربر' : 'فعال‌سازی کاربر', { username: user.username }); renderUsers();
      }; row.append(toggle);
    }
    list.append(row);
  }
}
