/** Offline, vendor-signed ANBARIN-LICENSE activation (RS256 / RSA-PKCS1-v1_5 + SHA-256).
 * The matching public key must be configured at build time as VITE_LICENSE_PUBLIC_KEY.
 * Never put the issuer private key in this application or APK.
 */
import { getDeviceId } from './license';
import { ISSUER_PUBLIC_KEY_PEM } from '../license/issuer-public-key';

export interface OfflineLicensePayload {
  schemaVersion: 1;
  applicationId: 'com.anbarian.app';
  licenseId: string;
  customerName: string;
  customerReference?: string;
  plan: string;
  /** ماژول‌های خریداری‌شده: count | accounting — اگر خالی باشد از روی plan تفسیر می‌شود */
  modules?: Array<'count' | 'accounting'>;
  issuedAt: string;
  validUntil: string;
  deviceId: string;
  maxDevices: 1;
  status: 'active';
  transferRequiresIssuerApproval: true;
  internalNote?: string;
}
interface LicenseEnvelope { format: 'ANBARIN-LICENSE'; algorithm: 'RS256'; keyId: string; payload: string; signature: string; }
const STORAGE_KEY = 'anbarin_offline_signed_license_v1';

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function pemToBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function configuredPublicKey(): string {
  // اولویت: متغیر بیلد (اگر بخواهید کلید را عوض کنید) → کلید عمومی همراه برنامه
  const fromEnv = String(import.meta.env.VITE_LICENSE_PUBLIC_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return String(ISSUER_PUBLIC_KEY_PEM || '').trim();
}

export function getOfflineLicense(): OfflineLicensePayload | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { payload?: OfflineLicensePayload; envelope?: LicenseEnvelope } | null;
    const value = stored?.payload;
    if (!value || !stored?.envelope?.signature || value.schemaVersion !== 1 || value.applicationId !== 'com.anbarian.app') return null;
    if (value.deviceId !== getDeviceId() || value.status !== 'active') return null;
    if (!value.validUntil || !Number.isFinite(Date.parse(value.validUntil))) return null;
    if (Date.parse(value.validUntil + (value.validUntil.length === 10 ? 'T23:59:59Z' : '')) < Date.now()) return null;
    return value;
  } catch { return null; }
}

export async function activateOfflineLicenseFile(file: File): Promise<OfflineLicensePayload> {
  if (!file || file.size > 128 * 1024) throw new Error('حجم فایل لایسنس نامعتبر است.');
  const publicPem = configuredPublicKey();
  if (!publicPem) throw new Error('کلید عمومی صادرکننده در برنامه موجود نیست.');
  let envelope: LicenseEnvelope;
  try { envelope = JSON.parse(await file.text()) as LicenseEnvelope; }
  catch { throw new Error('ساختار فایل لایسنس قابل‌خواندن نیست.'); }
  if (envelope.format !== 'ANBARIN-LICENSE' || envelope.algorithm !== 'RS256' || !envelope.payload || !envelope.signature) {
    throw new Error('فرمت یا الگوریتم فایل لایسنس پشتیبانی نمی‌شود.');
  }
  const payloadBytes = decodeBase64Url(envelope.payload);
  const signature = decodeBase64Url(envelope.signature);
  const key = await crypto.subtle.importKey('spki', pemToBytes(publicPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, payloadBytes);
  if (!verified) throw new Error('امضای دیجیتال لایسنس معتبر نیست.');
  let payload: OfflineLicensePayload;
  try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as OfflineLicensePayload; }
  catch { throw new Error('اطلاعات داخل لایسنس خراب است.'); }
  if (payload.schemaVersion !== 1 || payload.applicationId !== 'com.anbarian.app' || payload.status !== 'active') throw new Error('این لایسنس برای این برنامه صادر نشده است.');
  if (!payload.licenseId || !payload.customerName || !payload.deviceId || payload.maxDevices !== 1 || payload.transferRequiresIssuerApproval !== true) throw new Error('فیلدهای ضروری لایسنس ناقص است.');
  if (payload.deviceId !== getDeviceId()) throw new Error('این لایسنس برای دستگاه دیگری صادر شده است. برای انتقال، تأیید صادرکننده لازم است.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.validUntil) || !Number.isFinite(Date.parse(payload.validUntil + 'T23:59:59Z'))) throw new Error('تاریخ انقضای لایسنس معتبر نیست.');
  if (Date.parse(payload.validUntil + 'T23:59:59Z') < Date.now()) throw new Error('اعتبار این لایسنس به پایان رسیده است.');
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ payload, envelope }));
  return payload;
}

export function deactivateOfflineLicense(): void { localStorage.removeItem(STORAGE_KEY); }
export function getOfflineLicenseStatus(): string | null {
  const license = getOfflineLicense();
  if (!license) return null;
  const mods = Array.isArray(license.modules) && license.modules.length
    ? license.modules.join('+')
    : license.plan;
  return `لایسنس آفلاین امضاشده فعال — ${license.customerName} | ${mods} | تا ${license.validUntil}`;
}
