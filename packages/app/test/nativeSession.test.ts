import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: true,
  read: vi.fn(async (): Promise<{ value: string | null }> => ({ value: null })),
  write: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
}));

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  });
  return values;
}

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
  registerPlugin: () => ({ read: mocks.read, write: mocks.write, clear: mocks.clear }),
}));

import {
  clearNativeSessionToken,
  getNativeSessionToken,
  isNativeSessionPersisted,
  replaceNativeSessionToken,
  resetNativeSessionForTests,
  setNativeSessionToken,
} from '@/platform/nativeSession';

describe('native secure session boundary', () => {
  beforeEach(() => {
    mocks.native = true;
    mocks.read.mockReset().mockResolvedValue({ value: null });
    mocks.write.mockReset().mockResolvedValue(undefined);
    mocks.clear.mockReset().mockResolvedValue(undefined);
    installStorage();
    resetNativeSessionForTests();
  });

  it('loads a persisted device token once', async () => {
    mocks.read.mockResolvedValue({ value: 'tdg-native-existing' });
    expect(await getNativeSessionToken()).toBe('tdg-native-existing');
    expect(await getNativeSessionToken()).toBe('tdg-native-existing');
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(isNativeSessionPersisted()).toBe(true);
  });

  it('keeps non-persistent sessions in memory and clears stale secure storage', async () => {
    await setNativeSessionToken('tdg-native-memory', false);
    expect(mocks.clear).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await getNativeSessionToken()).toBe('tdg-native-memory');
    expect(isNativeSessionPersisted()).toBe(false);
  });

  it('writes persistent replacements before exposing them in memory', async () => {
    await setNativeSessionToken('tdg-native-old', true);
    mocks.write.mockRejectedValueOnce(new Error('keychain unavailable'));
    await expect(replaceNativeSessionToken('tdg-native-new')).rejects.toThrow('keychain unavailable');
    expect(await getNativeSessionToken()).toBe('tdg-native-old');
  });

  it('clears both memory and platform storage on logout', async () => {
    await setNativeSessionToken('tdg-native-token', true);
    await clearNativeSessionToken();
    expect(await getNativeSessionToken()).toBeNull();
    expect(isNativeSessionPersisted()).toBe(false);
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('marks a failed secure clear and retries it before reading on restart', async () => {
    mocks.clear.mockRejectedValueOnce(new Error('keychain unavailable'));
    await setNativeSessionToken('tdg-native-token', true);
    await clearNativeSessionToken();

    resetNativeSessionForTests();
    mocks.clear.mockResolvedValue(undefined);
    expect(await getNativeSessionToken()).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledTimes(2);
  });
});
