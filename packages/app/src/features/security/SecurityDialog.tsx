import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArchiveRestore,
  Download,
  History,
  Loader2,
  Shield,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { api, type BackupInfo, type WorkspaceExport } from '@/api/client';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
}

type BusyAction = 'password' | 'export' | 'import' | 'backups' | 'restore' | null;

function formatBackupLabel(backup: BackupInfo): string {
  const date = new Date(backup.createdAt);
  if (Number.isNaN(date.getTime())) return backup.name;
  return date.toLocaleString();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function SecurityDialog({ open, onClose }: Props) {
  const activePageId = useTaskStore((s) => s.activePageId);
  const replaceLoadedPage = useTaskStore((s) => s.replaceLoadedPage);
  const discardPendingSave = useTaskStore((s) => s.discardPendingSave);
  const refreshAllTasks = useWorkspaceStore((s) => s.refreshAllTasks);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = async (action: Exclude<BusyAction, null>, fn: () => Promise<void>) => {
    setBusyAction(action);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusyAction(null);
    }
  };

  const loadBackups = useCallback(async () => {
    if (!activePageId) {
      setBackups([]);
      setSelectedBackup('');
      return;
    }
    await runAction('backups', async () => {
      const list = await api.listBackups(activePageId);
      setBackups(list);
      setSelectedBackup(list[0]?.name ?? '');
    });
  }, [activePageId]);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setMessage(null);
    setError(null);
    void loadBackups();
  }, [open, loadBackups]);

  if (!open) return null;

  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const changePassword = () => {
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    if (!window.confirm('修改密码后，其他设备上的登录会话将失效。确认继续？')) return;
    void runAction('password', async () => {
      await api.changePassword(currentPassword, newPassword, confirmPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMessage('密码已更新');
    });
  };

  const exportJson = () =>
    runAction('export', async () => {
      await useTaskStore.getState().flush();
      const data = await api.exportWorkspaceJson();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `TodoGraph-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage('JSON 已导出');
    });

  const importJson = (file: File) =>
    runAction('import', async () => {
      const text = await file.text();
      const data = JSON.parse(text) as WorkspaceExport;
      if (!window.confirm('导入会替换当前账号的全部数据，继续？')) return;
      const rearmPendingSave = discardPendingSave();
      try {
        await api.importWorkspaceJson(data);
      } catch (err) {
        rearmPendingSave();
        throw err;
      }
      window.location.reload();
    });

  const restoreSelectedBackup = () =>
    runAction('restore', async () => {
      if (!activePageId || !selectedBackup) return;
      if (!window.confirm('恢复备份会覆盖当前页未保存的修改，继续？')) return;
      const rearmPendingSave = discardPendingSave();
      let restored: Awaited<ReturnType<typeof api.restoreBackup>>;
      try {
        restored = await api.restoreBackup(activePageId, selectedBackup);
      } catch (err) {
        rearmPendingSave();
        throw err;
      }
      replaceLoadedPage(activePageId, restored);
      await refreshAllTasks();
      setMessage('已恢复所选备份');
      await loadBackups();
    });

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-full max-w-lg max-h-full overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold text-foreground">账号与数据安全</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <section className="rounded-lg border border-border p-3">
            <h3 className="mb-2 text-xs font-semibold text-foreground">修改密码</h3>
            <div className="space-y-2">
              <PasswordInput
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="当前密码"
                visibilityLabel="当前密码"
                autoComplete="current-password"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              />
              <PasswordInput
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="新密码，至少 8 位且包含字母和数字"
                visibilityLabel="新密码"
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              />
              <PasswordInput
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
                visibilityLabel="确认新密码"
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                aria-invalid={passwordMismatch}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))]"
              />
              {passwordMismatch && (
                <p className="text-xs text-destructive">两次输入的新密码不一致</p>
              )}
              <Button
                size="sm"
                onClick={changePassword}
                disabled={
                  !currentPassword ||
                  !newPassword ||
                  !confirmPassword ||
                  passwordMismatch ||
                  busyAction === 'password'
                }
              >
                {busyAction === 'password' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                更新密码
              </Button>
            </div>
          </section>

          <section className="rounded-lg border border-border p-3">
            <h3 className="mb-2 text-xs font-semibold text-foreground">完整数据备份</h3>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={exportJson}
                disabled={busyAction === 'export'}
              >
                {busyAction === 'export' ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 h-3.5 w-3.5" />
                )}
                导出 JSON
              </Button>
              <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input px-3 text-xs font-medium transition-colors hover:bg-accent">
                {busyAction === 'import' ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="mr-1 h-3.5 w-3.5" />
                )}
                导入 JSON
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  disabled={busyAction === 'import'}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importJson(file);
                    e.currentTarget.value = '';
                  }}
                />
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1 text-xs font-semibold text-foreground">
                <History className="h-3.5 w-3.5" />
                当前页备份
              </h3>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => void loadBackups()}
                disabled={!activePageId || busyAction === 'backups'}
              >
                {busyAction === 'backups' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                刷新
              </Button>
            </div>

            {!activePageId ? (
              <p className="text-xs text-muted-foreground">当前没有已加载页面</p>
            ) : backups.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {busyAction === 'backups' ? '加载中...' : '暂无自动备份'}
              </p>
            ) : (
              <div className="space-y-2">
                <select
                  value={selectedBackup}
                  onChange={(e) => setSelectedBackup(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                >
                  {backups.map((backup) => (
                    <option key={backup.name} value={backup.name}>
                      {formatBackupLabel(backup)} · {formatBytes(backup.size)}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={restoreSelectedBackup}
                  disabled={!selectedBackup || busyAction === 'restore'}
                >
                  {busyAction === 'restore' ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArchiveRestore className="mr-1 h-3.5 w-3.5" />
                  )}
                  恢复所选备份
                </Button>
              </div>
            )}
          </section>

          {message && <p className="text-xs text-[hsl(var(--success))]">{message}</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SecurityButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5',
          'text-xs font-medium text-muted-foreground',
          'transition-colors hover:bg-accent hover:text-foreground',
        )}
        title="账号与数据安全"
      >
        <Shield className="h-4 w-4" />
        <span className="hidden sm:inline">安全</span>
      </button>
      <SecurityDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
