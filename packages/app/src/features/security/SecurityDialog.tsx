import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, ArrowLeft, ChevronRight, Shield, X } from 'lucide-react';
import { AccountSecurityPanel } from './AccountSecurityPanel';
import { BackupPanel } from './BackupPanel';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';
import { ProBadge } from '@/features/product/ProDialog';

interface Props { open: boolean; onClose?: () => void; username?: string }
export function SecurityDialog({ open, onClose, username }: Props) {
  const [backupsOpen, setBackupsOpen] = useState(false);
  useEffect(() => setBackupsOpen(false), [open, username]);
  if (!open) return null;

  const panel = (
    <div key={backupsOpen ? 'backups' : 'settings'} className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl">
      <header className="mb-5 flex items-center gap-2">
        {backupsOpen && <button type="button" aria-label="返回设置" onClick={() => setBackupsOpen(false)} className="rounded-xl p-2 hover:bg-foreground/5"><ArrowLeft className="h-4 w-4" /></button>}
        <h2 className="flex flex-1 items-center gap-2 text-sm font-semibold"><Shield className="h-5 w-5 text-[hsl(var(--primary))]" />{backupsOpen ? '备份与恢复' : '账号与数据'}</h2>
        <button type="button" aria-label="关闭账号与数据" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button>
      </header>
      {backupsOpen ? <BackupPanel /> : <div className="space-y-5">
        <ProBadge />
        {isLocalWorkspace() ? <p className="text-sm text-muted-foreground">本地工作区的数据保存在这台设备，无需账号和服务器。</p> : <AccountSecurityPanel key={username} username={username} />}
        <button type="button" aria-label="备份与恢复" onClick={() => setBackupsOpen(true)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors duration-200 hover:bg-foreground/5">
          <ArchiveRestore className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="flex-1"><span className="block text-sm font-medium">备份与恢复</span><span className="mt-1 block text-xs text-muted-foreground">导入导出、页面备份、草稿与回收站</span></span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </div>}
    </div>
  );
  return createPortal(<div className="fixed inset-0 z-[210] flex items-center justify-center p-4"><div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />{panel}</div>, document.body);
}

export function SecurityButton({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title="账号与数据安全"><Shield className="h-4 w-4" /><span className="hidden sm:inline">安全</span></button>;
}
