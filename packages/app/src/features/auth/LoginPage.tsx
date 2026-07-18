import { useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { PasswordInput } from '@/components/ui/password-input';

interface Props {
  onLogin: (username: string, password: string, remember: boolean) => Promise<string | null>;
  onRegister: (username: string, password: string, registrationKey: string, remember: boolean) => Promise<string | null>;
}

export function LoginPage({ onLogin, onRegister }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const err = mode === 'login'
      ? await onLogin(username.trim(), password, remember)
      : await onRegister(username.trim(), password, registrationKey.trim(), remember);
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
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              visibilityLabel="密码"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'register' ? '至少 8 位，包含字母和数字' : undefined}
              minLength={mode === 'register' ? 8 : undefined}
              maxLength={200}
              required
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">邀请码</label>
              <PasswordInput
                value={registrationKey}
                onChange={(e) => setRegistrationKey(e.target.value)}
                visibilityLabel="邀请码"
                autoComplete="off"
                className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
                placeholder="如不需要则留空"
              />
            </div>
          )}

          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 px-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="peer sr-only"
            />
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-card transition-colors peer-checked:border-[hsl(var(--primary))] peer-checked:bg-[hsl(var(--primary))] peer-focus-visible:ring-2 peer-focus-visible:ring-[hsl(var(--ring))] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
              {remember && <Check className="h-3 w-3 text-[hsl(var(--primary-foreground))]" strokeWidth={3} />}
            </span>
            <span>在这台设备上保持登录</span>
          </label>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
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
