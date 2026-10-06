import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';

export function AccountSecurityPanel({ username, embedded = false }: { username?: string; embedded?: boolean }) {
  const inputId = useId();
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const mismatch = passwords.confirm.length > 0 && passwords.next !== passwords.confirm;
  const inputClass = embedded ? 'settings-field w-full px-3 py-3 outline-none focus:border-[hsl(var(--primary))]' : 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]';
  const setPassword = (key: keyof typeof passwords) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setPasswords(value => ({ ...value, [key]: event.target.value }));

  const changePassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (passwords.next !== passwords.confirm) {
      setNotice({ ok: false, text: '两次输入的新密码不一致' });
      return;
    }
    if (!/\p{L}/u.test(passwords.next) || !/\p{N}/u.test(passwords.next)) {
      setNotice({ ok: false, text: '新密码必须同时包含字母和数字' });
      return;
    }
    if (!window.confirm('修改密码后，其他设备上的登录会话将失效。确认继续？')) return;
    setBusy(true);
    setNotice(null);
    return (async () => {
      try {
        await api.changePassword(passwords.current, passwords.next);
        setPasswords({ current: '', next: '', confirm: '' });
        setNotice({ ok: true, text: '密码已更新' });
      } catch (error) { setNotice({ ok: false, text: String((error as Error).message ?? error) }); }
      finally { setBusy(false); }
    })();
  };

  return <section className={embedded ? 'settings-section' : 'border-b border-border/60 pb-5'}>
    <h3 className="mb-4 text-sm font-medium">修改密码</h3>
    <form method="post" className="space-y-4" onSubmit={changePassword}>
      {username && <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />}
      <div className="space-y-2">
        {embedded && <label htmlFor={`${inputId}-current`} className="text-xs text-muted-foreground">当前密码</label>}
        <PasswordInput id={`${inputId}-current`} name="current-password" value={passwords.current} onChange={setPassword('current')} placeholder="当前密码" visibilityLabel="当前密码" autoComplete="current-password" maxLength={200} required className={inputClass} />
      </div>
      <div className="space-y-2">
        {embedded && <label htmlFor={`${inputId}-next`} className="text-xs text-muted-foreground">新密码</label>}
        <PasswordInput id={`${inputId}-next`} name="new-password" value={passwords.next} onChange={setPassword('next')} placeholder="新密码，至少 8 位且包含字母和数字" visibilityLabel="新密码" autoComplete="new-password" minLength={8} maxLength={200} required className={inputClass} />
      </div>
      <div className="space-y-2">
        {embedded && <label htmlFor={`${inputId}-confirm`} className="text-xs text-muted-foreground">确认新密码</label>}
        <PasswordInput id={`${inputId}-confirm`} name="confirm-password" value={passwords.confirm} onChange={setPassword('confirm')} placeholder="再次输入新密码" visibilityLabel="确认新密码" autoComplete="new-password" minLength={8} maxLength={200} required aria-invalid={mismatch} className={inputClass} />
      </div>
      {mismatch && <p className="text-xs text-destructive">两次输入的新密码不一致</p>}
      <Button type="submit" size="sm" className={embedded ? 'h-11 w-full rounded-xl' : undefined} disabled={!passwords.current || !passwords.next || !passwords.confirm || mismatch || busy}>
        {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}更新密码
      </Button>
      {notice && <p role={notice.ok ? 'status' : 'alert'} className={`rounded-lg border px-3 py-2 text-xs ${notice.ok ? 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>{notice.text}</p>}
    </form>
  </section>;
}
