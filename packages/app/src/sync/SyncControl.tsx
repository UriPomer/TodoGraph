import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, X } from 'lucide-react';
import { isCloudKitConfigured } from './cloudKit';
import { useSyncStore, startSyncLifecycle } from './syncEngine';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';
import { useProductStore } from '@/features/product/entitlements';
import { localTransaction } from '@/local/localWorkspace';
import { api } from '@/api/client';

const labels = { local: '仅本地', syncing: '正在同步', synced: '已同步', offline: '等待联网', conflict: '同步冲突', error: '同步需处理' };
export function SyncLifecycle() { useEffect(startSyncLifecycle, []); return null; }
export function SyncControl() {
  const sync = useSyncStore();
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)} aria-label="同步设置" className="inline-flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs text-muted-foreground transition-colors duration-200 hover:bg-foreground/5"><Cloud className="h-3.5 w-3.5" /><span>{isLocalWorkspace() ? labels[sync.status] : '服务器工作区'}</span></button>{open && <SyncDialog onClose={() => setOpen(false)} />}</>;
}

function SyncDialog({ onClose }: { onClose: () => void }) {
  const sync = useSyncStore();
  const pro = useProductStore(state => state.entitlements.plan === 'pro');
  const [recovery, setRecovery] = useState<Array<{ index: number; date: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    if (isLocalWorkspace()) void localTransaction(record => record.history.map((snapshot, index) => ({ index, date: snapshot.exportedAt })), false).then(setRecovery).catch(error => setError(error.message));
  }, [sync.status]);
  const exportRecovery = async (index: number) => {
    try {
      const snapshot = await localTransaction(record => record.history[index], false);
      if (!snapshot) throw new Error('恢复点已变化，请重开同步设置');
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `TodoGraph-recovery-${index}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError((error as Error).message); }
  };
  const exportCurrent = async () => {
    try {
      const { useTaskStore } = await import('@/stores/useTaskStore'); await useTaskStore.getState().flush();
      const snapshot = await api.exportWorkspaceJson();
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'TodoGraph-workspace.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError((error as Error).message); }
  };
  return createPortal(<div className="fixed inset-0 z-[240] flex items-center justify-center p-4" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label="同步设置" className="relative max-h-full w-full max-w-md overflow-auto rounded-xl border border-border bg-card p-5 text-card-foreground shadow-2xl">
      <header className="mb-4 flex items-center justify-between"><h2 ref={heading} tabIndex={-1} className="font-semibold outline-none">同步设置</h2><button onClick={onClose} aria-label="关闭同步设置" className="rounded-xl p-2 hover:bg-foreground/5"><X className="h-4 w-4" /></button></header>
      <p className="text-sm">{isLocalWorkspace() ? '编辑先保存在本机，再同步到你的 iCloud。' : '当前数据保存在 TodoGraph 服务器。iCloud 同步用于独立的本地工作区。'}</p>
      <p role="status" className="mt-3 text-sm text-muted-foreground">{isLocalWorkspace() ? labels[sync.status] : '服务器工作区'}</p>
      {sync.lastSynced && <p className="mt-1 text-xs text-muted-foreground">上次同步：{new Date(sync.lastSynced).toLocaleString()}</p>}
      {!isCloudKitConfigured() && <p className="mt-4 rounded-xl bg-muted p-3 text-sm">iCloud 同步尚未配置</p>}
      <div id="cloudkit-sign-in" className="mt-3" /><div id="cloudkit-sign-out" />
      <div className="my-4 flex flex-wrap gap-2">
        {isLocalWorkspace() && (!pro ? <button onClick={() => { onClose(); useProductStore.getState().openPro(); }} className="rounded-xl border px-3 py-2 text-sm">解锁 Pro 同步</button> : <>
          <button disabled={!isCloudKitConfigured() || sync.status === 'syncing'} onClick={() => void (sync.enabled ? sync.sync() : sync.enable())} className="rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">{sync.enabled ? '立即同步' : '启用 iCloud 同步'}</button>
          {sync.enabled && <button onClick={() => sync.disable()} className="rounded-xl border px-3 py-2 text-sm">暂停同步</button>}
        </>)}
        <button onClick={() => void exportCurrent()} className="rounded-xl border px-3 py-2 text-sm">导出当前工作区</button>
      </div>
      {sync.status === 'conflict' && <div className="space-y-2 rounded-xl border p-3 text-sm"><p>选择完整工作区，另一份保留为本机恢复点。</p><button onClick={() => void sync.sync('local')} className="mr-2 rounded-xl border px-3 py-2">保留本机版本</button><button onClick={() => void sync.sync('cloud')} className="rounded-xl border px-3 py-2">使用 iCloud 版本</button></div>}
      {(sync.error || error) && <p role="alert" className="mt-3 text-sm text-destructive">{error ?? sync.error}</p>}
      {recovery.length > 0 && <section className="mt-5 border-t pt-4"><h3 className="text-sm font-medium">本地恢复点</h3>{recovery.map(item => <button key={item.index} onClick={() => void exportRecovery(item.index)} className="mt-2 block w-full rounded-xl px-3 py-2 text-left text-xs hover:bg-foreground/5">导出 {new Date(item.date).toLocaleString()}</button>)}</section>}
    </div>
  </div>, document.body);
}
