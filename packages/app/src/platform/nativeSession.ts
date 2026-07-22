import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureSessionPlugin {
  read(): Promise<{ value: string | null }>;
  write(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
}

const SecureSession = registerPlugin<SecureSessionPlugin>('SecureSession');
const CLEAR_PENDING_KEY = 'todograph.nativeSessionClearPending';
let token: string | null = null;
let persisted = false;
let loaded: Promise<void> | null = null;

function hasPendingClear(): boolean {
  try { return localStorage.getItem(CLEAR_PENDING_KEY) === 'true'; } catch { return false; }
}

function markPendingClear(): boolean {
  try {
    localStorage.setItem(CLEAR_PENDING_KEY, 'true');
    return true;
  } catch {
    return false;
  }
}

function clearPendingMarker(): void {
  try { localStorage.removeItem(CLEAR_PENDING_KEY); } catch { /* storage is optional */ }
}

export function isNativeRuntime(): boolean {
  return Capacitor.isNativePlatform();
}

export async function initializeNativeSession(): Promise<void> {
  if (!isNativeRuntime() || loaded) return loaded ?? Promise.resolve();
  if (hasPendingClear()) {
    loaded = SecureSession.clear()
      .then(clearPendingMarker)
      .catch(() => undefined)
      .then(() => {
        token = null;
        persisted = false;
      });
    return loaded;
  }
  loaded = SecureSession.read()
    .then((result) => {
      token = result.value;
      persisted = Boolean(result.value);
    })
    .catch(() => {
      token = null;
      persisted = false;
    });
  return loaded;
}

export async function getNativeSessionToken(): Promise<string | null> {
  await initializeNativeSession();
  return token;
}

export function isNativeSessionPersisted(): boolean {
  return persisted;
}

export async function setNativeSessionToken(value: string, shouldPersist: boolean): Promise<void> {
  if (isNativeRuntime()) {
    if (shouldPersist) await SecureSession.write({ value });
    else await SecureSession.clear();
    clearPendingMarker();
  }
  token = value;
  persisted = shouldPersist;
  loaded = Promise.resolve();
}

export async function replaceNativeSessionToken(value: string): Promise<void> {
  if (isNativeRuntime() && persisted) await SecureSession.write({ value });
  token = value;
  loaded = Promise.resolve();
}

export async function clearNativeSessionToken(): Promise<void> {
  token = null;
  persisted = false;
  loaded = Promise.resolve();
  if (!isNativeRuntime()) return;
  const retryRecorded = markPendingClear();
  try {
    await SecureSession.clear();
    clearPendingMarker();
  } catch (error) {
    if (!retryRecorded) throw error;
  }
}

export function resetNativeSessionForTests(): void {
  token = null;
  persisted = false;
  loaded = null;
}
