import { useState, type FormEvent } from 'react';
import { useAuth } from './useAuth';

export function LoginPage() {
  const { login, register, error: authError } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const err = mode === 'login'
      ? await login(username.trim(), password)
      : await register(username.trim(), password, registrationKey.trim());
    if (err) setError(err);
    setBusy(false);
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-[hsl(var(--primary))] text-3xl">◈</span>
          <h1 className="mt-2 text-xl font-semibold">TodoGraph</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              minLength={2}
              maxLength={32}
              required
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={6}
              required
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">邀请码</label>
              <input
                type="text"
                value={registrationKey}
                onChange={(e) => setRegistrationKey(e.target.value)}
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
                placeholder="如不需要则留空"
              />
            </div>
          )}

          {(error || authError) && (
            <p className="text-sm text-destructive">{error || authError}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-[hsl(var(--primary))] py-2.5 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '...' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {mode === 'login' ? (
            <>没有账号？ <button onClick={() => { setMode('register'); setError(null); }} className="underline hover:text-foreground">注册</button></>
          ) : (
            <>已有账号？ <button onClick={() => { setMode('login'); setError(null); }} className="underline hover:text-foreground">登录</button></>
          )}
        </p>
      </div>
    </div>
  );
}
