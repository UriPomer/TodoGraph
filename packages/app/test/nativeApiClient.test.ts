import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  token: 'tdg-native-device-token',
}));

vi.mock('@/platform/nativeSession', () => ({
  clearNativeSessionToken: mocks.clear,
  getNativeSessionToken: vi.fn(async () => mocks.token),
  isNativeRuntime: () => true,
  isNativeSessionPersisted: () => true,
  replaceNativeSessionToken: vi.fn(async () => undefined),
}));

import { apiFetch } from '@/api/client';

describe('native API client', () => {
  beforeEach(() => {
    mocks.clear.mockClear();
    vi.stubEnv('VITE_API_BASE', 'https://todo.example.com');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('adds the device bearer token to HTTPS requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await apiFetch('https://todo.example.com/api/meta');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${mocks.token}`);
    expect(headers.get('X-TodoGraph-Client')).toBe('native');
  });

  it('never sends the device token outside the configured API origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await expect(apiFetch('https://evil.example/api/meta')).rejects.toThrow('原生 API 请求目标不受信任');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not erase a session for expected login or password failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await apiFetch('https://todo.example.com/api/auth/native/login');
    await apiFetch('https://todo.example.com/api/auth/native/change-password');
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('erases a session for protected or explicitly expired native requests', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 401,
        headers: { 'X-Session-Expired': '1' },
      }));
    await apiFetch('https://todo.example.com/api/meta');
    await apiFetch('https://todo.example.com/api/auth/native/change-password');
    expect(mocks.clear).toHaveBeenCalledTimes(2);
  });
});
