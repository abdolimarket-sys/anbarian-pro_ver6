/** Local role and permission policy. This is a device-local convenience gate,
 * not a server-side security boundary; a trusted backend must re-check actions. */
import type { AppSettings } from '@/types';

export type AppRole = 'admin' | 'counter' | 'viewer';
export type Permission =
  | 'inventory.read' | 'inventory.count' | 'inventory.edit' | 'inventory.import' | 'inventory.export'
  | 'session.start' | 'session.close' | 'team.sync' | 'users.manage' | 'roles.assign'
  | 'audit.read' | 'audit.clear' | 'license.manage' | 'settings.manage';
export type PermissionOverrides = Partial<Record<Permission, boolean>>;

export interface AuthenticatedUser {
  id: string; displayName: string; role: AppRole; organizationId: string; warehouseIds: string[];
}
export interface AuthorizationDecision { allowed: boolean; reason?: string; }
export const AUTHORIZATION_MODE = 'local-only' as const;
export interface LocalAuthorizationSnapshot {
  mode: typeof AUTHORIZATION_MODE; role: AppRole; permissions: Permission[];
  trustedIdentity: false; warning: string;
}
export interface AuthorizationProvider {
  getCurrentUser(): Promise<AuthenticatedUser | null>;
  authorize(permission: Permission, resource?: { warehouseId?: string; sessionId?: string }): Promise<AuthorizationDecision>;
  signIn?(credentials: unknown): Promise<AuthenticatedUser>;
  signOut?(): Promise<void>;
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  'inventory.read': 'مشاهده کالا و موجودی',
  'inventory.count': 'ثبت شمارش و اسکن بارکد',
  'inventory.edit': 'ویرایش کالا و اطلاعات موجودی',
  'inventory.import': 'ورود اطلاعات و فایل‌ها',
  'inventory.export': 'خروجی و گزارش‌گیری',
  'session.start': 'شروع دوره شمارش',
  'session.close': 'بستن دوره شمارش',
  'team.sync': 'همگام‌سازی تیمی',
  'users.manage': 'ساخت و غیرفعال‌سازی کاربران',
  'roles.assign': 'تغییر نقش و مجوز کاربران',
  'audit.read': 'مشاهده تاریخچه فعالیت‌ها',
  'audit.clear': 'پاک‌سازی تاریخچه فعالیت‌ها',
  'license.manage': 'مدیریت مجوز نرم‌افزار',
  'settings.manage': 'تغییر تنظیمات برنامه',
};

const ROLE_PERMISSIONS: Record<AppRole, ReadonlySet<Permission>> = {
  admin: new Set(Object.keys(PERMISSION_LABELS) as Permission[]),
  counter: new Set<Permission>(['inventory.read','inventory.count','inventory.export','session.start','session.close','team.sync','audit.read']),
  viewer: new Set<Permission>(['inventory.read','inventory.export','audit.read']),
};
let activeOverrides: PermissionOverrides = {};

export function setLocalPermissionOverrides(overrides?: PermissionOverrides | null): void {
  activeOverrides = {};
  if (!overrides || typeof overrides !== 'object') return;
  for (const [key, value] of Object.entries(overrides)) {
    if (isKnownPermission(key) && typeof value === 'boolean') activeOverrides[key] = value;
  }
}
export function roleAllows(role: AppRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
export function getLocalAuthorizationSnapshot(settings: Pick<AppSettings, 'role'>): LocalAuthorizationSnapshot {
  const role = currentLocalRole(settings);
  const permissions = (Object.keys(PERMISSION_LABELS) as Permission[]).filter(p =>
    role === 'admin' || (activeOverrides[p] ?? roleAllows(role, p))
  );
  return { mode: AUTHORIZATION_MODE, role, permissions, trustedIdentity: false,
    warning: 'نقش و مجوزها فقط روی همین دستگاه ذخیره می‌شوند و جایگزین احراز هویت سمت سرور نیستند.' };
}
export function authorizeLocally(settings: Pick<AppSettings, 'role'>, permission: Permission): AuthorizationDecision {
  const role = currentLocalRole(settings);
  // مدیر اصلی همیشه دسترسی کامل دارد تا برنامه قفل نشود.
  const allowed = role === 'admin' || (activeOverrides[permission] ?? roleAllows(role, permission));
  return allowed ? { allowed: true } : { allowed: false, reason: `نقش ${role} مجوز ${permission} را ندارد` };
}
export function currentLocalRole(settings: Pick<AppSettings, 'role'>): AppRole {
  return settings.role === 'counter' || settings.role === 'viewer' ? settings.role : 'admin';
}
export function isKnownPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSION_LABELS, value);
}
