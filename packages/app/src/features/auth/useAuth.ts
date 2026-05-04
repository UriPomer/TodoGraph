import { useEffect, useState, useCallback } from 'react';

interface AuthState {
  loading: boolean;
  user: { id: string; username: string } | null;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({ loading: true, user: null, error: null });

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json() as { ok: boolean; id?: string; username?: string };
      if (data.ok && data.id && data.username) {
        setState({ loading: false, user: { id: data.id, username: data.username }, error: null });
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

  const login = async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json() as { ok: boolean; username?: string; error?: string };
      if (data.ok) {
        await checkAuth();
        return null;
      }
      return data.error ?? '登录失败';
    } catch {
      return '无法连接到服务器';
    }
  };

  const register = async (username: string, password: string, registrationKey: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, registrationKey }),
      });
      const data = await res.json() as { ok: boolean; username?: string; error?: string };
      if (data.ok) {
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
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    setState({ loading: false, user: null, error: null });
  };

  return { ...state, login, register, logout, checkAuth };
}
