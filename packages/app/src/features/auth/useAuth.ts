import { useEffect, useState, useCallback } from 'react';
import { apiFetch, getApiBase, subscribeToUnauthorized } from '@/api/client';
import {
  clearNativeSessionToken,
  isNativeRuntime,
  setNativeSessionToken,
} from '@/platform/nativeSession';

interface AuthState {
  loading: boolean;
  user: { id: string; username: string } | null;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ loading: true, user: null, error: null });

  const checkAuth = useCallback(async () => {
    try {
      const native = isNativeRuntime();
      const res = await apiFetch(`${getApiBase()}${native ? '/api/auth/native/me' : '/api/auth/me'}`);
      const data = await res.json() as {
        ok: boolean;
        id?: string;
        username?: string;
        user?: { id: string; username: string };
      };
      const user = native ? data.user : data.id && data.username ? { id: data.id, username: data.username } : undefined;
      if (data.ok && user) {
        setState({ loading: false, user, error: null });
      } else {
        setState({ loading: false, user: null, error: null });
      }
    } catch {
      setState({ loading: false, user: null, error: '无法连接到服务器' });
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(
    () =>
      subscribeToUnauthorized(() => {
        setState({ loading: false, user: null, error: '会话已失效，请重新登录' });
      }),
    [],
  );

  const login = async (username: string, password: string, remember: boolean): Promise<string | null> => {
    try {
      const native = isNativeRuntime();
      const res = await apiFetch(`${getApiBase()}${native ? '/api/auth/native/login' : '/api/auth/login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember }),
      });
      const data = await res.json() as { ok: boolean; token?: string; username?: string; error?: string };
      if (data.ok) {
        if (native) {
          if (!data.token) return '登录响应缺少设备令牌';
          await setNativeSessionToken(data.token, remember);
        }
        await checkAuth();
        return null;
      }
      return data.error ?? '登录失败';
    } catch {
      return '无法连接到服务器';
    }
  };

  const register = async (
    username: string,
    password: string,
    registrationKey: string,
    remember: boolean,
  ): Promise<string | null> => {
    try {
      const native = isNativeRuntime();
      const res = await apiFetch(`${getApiBase()}${native ? '/api/auth/native/register' : '/api/auth/register'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, registrationKey, remember }),
      });
      const data = await res.json() as { ok: boolean; token?: string; username?: string; error?: string };
      if (data.ok) {
        if (native) {
          if (!data.token) return '注册响应缺少设备令牌';
          await setNativeSessionToken(data.token, remember);
        }
        await checkAuth();
        return null;
      }
      return data.error ?? '注册失败';
    } catch {
      return '无法连接到服务器';
    }
  };

  const logout = async () => {
    try {
      await apiFetch(`${getApiBase()}${isNativeRuntime() ? '/api/auth/native/logout' : '/api/auth/logout'}`, { method: 'POST' });
    } catch { /* ignore */ }
    await clearNativeSessionToken();
    setState({ loading: false, user: null, error: null });
  };

  return { ...state, login, register, logout, checkAuth };
}
