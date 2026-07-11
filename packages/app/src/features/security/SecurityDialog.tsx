import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, Download, History, Loader2, Shield, Upload, X } from 'lucide-react';
import { api, type BackupInfo, type WorkspaceExport } from '@/api/client';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

interface Props { open: boolean; onClose?: () => void; embedded?: boolean }
type Action = 'password' | 'export' | 'import' | 'backups' | 'restore';
const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]';

function backupLabel(backup: BackupInfo): string {
  const date = new Date(backup.createdAt);
  const size = backup.size < 1024 ? `${backup.size} B`
    : backup.size < 1024 ** 2 ? `${(backup.size / 1024).toFixed(1)} KB`
      : `${(backup.size / 1024 ** 2).toFixed(1)} MB`;
  return `${Number.isNaN(date.getTime()) ? backup.name : date.toLocaleString()} · ${size}`;
}

export function SecurityDialog({ open, onClose, embedded = false }: Props) {
  const activePageId = useTaskStore((state) => state.activePageId);
  const replaceLoadedPage = useTaskStore((state) => state.replaceLoadedPage);
  const refreshAllTasks = useWorkspaceStore((state) => state.refreshAllTasks);
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const run = async (action: Action, task: () => Promise<void>) => {
    setBusy(action);
    setNotice(null);
    try { await task(); }
    catch (error) { setNotice({ ok: false, text: String((error as Error).message ?? error) }); }
    finally { setBusy(null); }
  };

  const loadBackups = useCallback(async () => {
    if (!activePageId) {
      setBackups([]);
      setSelectedBackup('');
      return;
    }
    await run('backups', async () => {
      const list = await api.listBackups(activePageId);
      setBackups(list);
      setSelectedBackup(list[0]?.name ?? '');
    });
  }, [activePageId]);

  useEffect(() => {
    if (!open) return;
    setPasswords({ current: '', next: '', confirm: '' });
    setNotice(null);
    void loadBackups();
  }, [open, loadBackups]);

  if (!open) return null;
  const mismatch = passwords.confirm.length > 0 && passwords.next !== passwords.confirm;
  const setPassword = (key: keyof typeof passwords) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setPasswords((value) => ({ ...value, [key]: event.target.value }));

  const changePassword = () => {
    if (passwords.next !== passwords.confirm) {
      setNotice({ ok: false, text: '两次输入的新密码不一致' });
      return;
    }
    if (!window.confirm('修改密码后，其他设备上的登录会话将失效。确认继续？')) return;
    void run('password', async () => {
      await api.changePassword(passwords.current, passwords.next);
      setPasswords({ current: '', next: '', confirm: '' });
      setNotice({ ok: true, text: '密码已更新' });
    });
  };

  const exportJson = () => void run('export', async () => {
    await useTaskStore.getState().flush();
    const data = await api.exportWorkspaceJson();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `TodoGraph-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setNotice({ ok: true, text: 'JSON 已导出' });
  });

  const importJson = (file: File) => void run('import', async () => {
    const data = JSON.parse(await file.text()) as WorkspaceExport;
    if (!window.confirm('导入会替换当前账号的全部数据，继续？')) return;
    await useTaskStore.getState().flush();
    await api.importWorkspaceJson(data);
    window.location.reload();
  });

  const restore = () => void run('restore', async () => {
    if (!activePageId || !selectedBackup || !window.confirm('恢复备份会覆盖当前页未保存的修改，继续？')) return;
    await useTaskStore.getState().flush();
    const page = await api.restoreBackup(activePageId, selectedBackup);
    replaceLoadedPage(activePageId, page);
    await refreshAllTasks();
    setNotice({ ok: true, text: '已恢复所选备份' });
    await loadBackups();
  });
  const mobileAction = embedded ? 'h-10' : undefined;

  const panel = (
      <div className={embedded ? 'py-6' : 'relative max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl'}>
        <header className="mb-5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Shield className="h-5 w-5 text-[hsl(var(--primary))]" />账号与数据</h2>
          {!embedded && <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>}
        </header>
        <div className="space-y-5">
          <section className="border-b border-border/60 pb-5">
            <h3 className="mb-3 text-xs font-semibold">修改密码</h3>
            <div className="space-y-3">
              <PasswordInput value={passwords.current} onChange={setPassword('current')} placeholder="当前密码" visibilityLabel="当前密码" autoComplete="current-password" maxLength={200} className={inputClass} />
              <PasswordInput value={passwords.next} onChange={setPassword('next')} placeholder="新密码，至少 8 位且包含字母和数字" visibilityLabel="新密码" autoComplete="new-password" minLength={8} maxLength={200} className={inputClass} />
              <PasswordInput value={passwords.confirm} onChange={setPassword('confirm')} placeholder="再次输入新密码" visibilityLabel="确认新密码" autoComplete="new-password" minLength={8} maxLength={200} aria-invalid={mismatch} className={inputClass} />
              {mismatch && <p className="text-xs text-destructive">两次输入的新密码不一致</p>}
              <Button size="sm" className={embedded ? 'h-10 w-full' : undefined} onClick={changePassword} disabled={!passwords.current || !passwords.next || !passwords.confirm || mismatch || busy === 'password'}>
                {busy === 'password' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}更新密码
              </Button>
            </div>
          </section>
          <section className="border-b border-border/60 pb-5">
            <h3 className="mb-3 text-xs font-semibold">完整数据备份</h3>
            <div className="grid grid-cols-2 gap-3">
              <Button size="sm" className={mobileAction} variant="secondary" onClick={exportJson} disabled={busy === 'export'}><Download className="mr-1 h-3.5 w-3.5" />导出 JSON</Button>
              <label className={`inline-flex cursor-pointer items-center justify-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent ${embedded ? 'h-10' : 'h-8'}`}><Upload className="mr-1 h-3.5 w-3.5" />导入 JSON
                <input type="file" accept="application/json" className="hidden" disabled={busy === 'import'} onChange={(event) => { const file = event.target.files?.[0]; if (file) importJson(file); event.currentTarget.value = ''; }} />
              </label>
            </div>
          </section>
          <section>
            <header className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-1 text-xs font-semibold"><History className="h-3.5 w-3.5" />当前页备份</h3>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => void loadBackups()} disabled={!activePageId || busy === 'backups'}>刷新</Button>
            </header>
            {!activePageId || backups.length === 0 ? <p className="text-xs text-muted-foreground">{busy === 'backups' ? '加载中...' : activePageId ? '暂无自动备份' : '当前没有已加载页面'}</p> : (
              <div className="space-y-3">
                <select value={selectedBackup} onChange={(event) => setSelectedBackup(event.target.value)} className={`${inputClass} text-xs`}>{backups.map((backup) => <option key={backup.name} value={backup.name}>{backupLabel(backup)}</option>)}</select>
                <Button size="sm" className={embedded ? 'h-10 w-full' : undefined} variant="secondary" onClick={restore} disabled={!selectedBackup || busy === 'restore'}><ArchiveRestore className="mr-1 h-3.5 w-3.5" />恢复所选备份</Button>
              </div>
            )}
          </section>
          {notice && <p className={`text-xs ${notice.ok ? 'text-[hsl(var(--success))]' : 'text-destructive'}`}>{notice.text}</p>}
        </div>
      </div>
  );
  if (embedded) return panel;
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      {panel}
    </div>,
    document.body,
  );
}

export function SecurityButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="账号与数据安全"><Shield className="h-4 w-4" /><span className="hidden sm:inline">安全</span></button>;
}
