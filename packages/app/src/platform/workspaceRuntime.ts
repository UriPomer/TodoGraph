import { Capacitor } from '@capacitor/core';
import { FREE_ENTITLEMENTS, type Entitlements } from '@todograph/shared';

const MODE_KEY = 'todograph.workspace-mode';
let mode: 'local' | 'server' = 'server';
try {
  mode = localStorage.getItem(MODE_KEY) === 'local'
    || (typeof window !== 'undefined' && window.todograph?.isElectron === true)
    || (Capacitor.isNativePlatform() && !import.meta.env.VITE_API_BASE)
    || import.meta.env.VITE_LOCAL_FIRST === 'true' ? 'local' : 'server';
} catch { /* A blocked preference store must not prevent launching. */ }

let nativeEntitlements: Entitlements = FREE_ENTITLEMENTS;
export const LOCAL_USER = { id: 'local-device', username: '本地工作区' };
export const isLocalWorkspace = () => mode === 'local';
export function setWorkspaceMode(next: 'local' | 'server') {
  mode = next;
  try { localStorage.setItem(MODE_KEY, next); } catch { /* This session still works. */ }
}
export const getLocalEntitlements = () => nativeEntitlements.expiresAt && Date.parse(nativeEntitlements.expiresAt) <= Date.now() ? FREE_ENTITLEMENTS : nativeEntitlements;
/** Called only with the platform's verified StoreKit result; no persisted Pro switch. */
export function setVerifiedNativeEntitlements(value: Entitlements) { nativeEntitlements = value; }
