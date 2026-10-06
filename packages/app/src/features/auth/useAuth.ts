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
      setState({ loading: false, user: data.ok && user ? user : null, error: null });
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

  const authenticate = async (
    action: 'login' | 'register',
    credentials: { username: string; password: string; remember: boolean; registrationKey?: string },
  ): Promise<string | null> => {
    const label = action === 'login' ? '登录' : '注册';
    try {
      const native = isNativeRuntime();
      const res = await apiFetch(`${getApiBase()}/api/auth/${native ? 'native/' : ''}${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      const data = await res.json() as { ok: boolean; token?: string; username?: string; error?: string };
      if (data.ok) {
        if (native) {
          if (!data.token) return `${label}响应缺少设备令牌`;
          await setNativeSessionToken(data.token, credentials.remember);
        }
        await checkAuth();
        return null;
      }
      return data.error ?? `${label}失败`;
    } catch {
      return '无法连接到服务器';
    }
  };

  const login = (username: string, password: string, remember: boolean) =>
    authenticate('login', { username, password, remember });
  const register = (username: string, password: string, registrationKey: string, remember: boolean) =>
    authenticate('register', { username, password, registrationKey, remember });

  const logout = async () => {
    try {
      await apiFetch(`${getApiBase()}${isNativeRuntime() ? '/api/auth/native/logout' : '/api/auth/logout'}`, { method: 'POST' });
    } catch { /* ignore */ }
    await clearNativeSessionToken();
    setState({ loading: false, user: null, error: null });
  };

  return { ...state, login, register, logout, checkAuth };
}
