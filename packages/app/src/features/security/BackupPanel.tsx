import { useEffect, useState } from 'react';
import { ArchiveRestore, ChevronDown, Download, History, Loader2, Upload } from 'lucide-react';
import { api, type BackupInfo, type TrashedPageInfo, type WorkspaceExport } from '@/api/client';
import { Button } from '@/components/ui/button';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { clearTaskDraft, listTaskDrafts, type TaskDraft } from '@/stores/taskDraftStorage';

type Action = 'export' | 'import' | 'restore' | 'trash-restore' | 'draft-restore';
const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:border-[hsl(var(--primary))] appearance-none !pr-12';

function backupLabel(backup: BackupInfo): string {
  const date = new Date(backup.createdAt);
  const size = backup.size < 1024 ? `${backup.size} B`
    : backup.size < 1024 ** 2 ? `${(backup.size / 1024).toFixed(1)} KB`
      : `${(backup.size / 1024 ** 2).toFixed(1)} MB`;
  return `${Number.isNaN(date.getTime()) ? backup.name : date.toLocaleString()} · ${size}`;
}

export function BackupPanel({ embedded = false }: { embedded?: boolean }) {
  const activePageId = useTaskStore((state) => state.activePageId);
  const sessionUserId = useWorkspaceStore((state) => state.sessionUserId);
  // A different page/account owns a different catalog and request lifetime.
  return <BackupContent key={`${sessionUserId}:${activePageId}`} embedded={embedded} activePageId={activePageId} sessionUserId={sessionUserId} />;
}

function BackupContent({ embedded, activePageId, sessionUserId }: {
  embedded: boolean; activePageId: string | null; sessionUserId: string | null;
}) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState('');
  const [trashedPages, setTrashedPages] = useState<TrashedPageInfo[]>([]);
  const [selectedTrash, setSelectedTrash] = useState('');
  const [drafts, setDrafts] = useState<TaskDraft[]>([]);
  const [selectedDraft, setSelectedDraft] = useState('');
  const [backupLoading, setBackupLoading] = useState(true);
  const [trashLoading, setTrashLoading] = useState(true);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setBackupLoading(true);
    setTrashLoading(true);
    setBackupError(null);
    setTrashError(null);
    const localDrafts = sessionUserId ? listTaskDrafts(sessionUserId) : [];
    setDrafts(localDrafts);
    setSelectedDraft((selected) => localDrafts.some((item) => item.pageId === selected) ? selected : localDrafts[0]?.pageId ?? '');
    void (activePageId ? api.listBackups(activePageId, signal) : Promise.resolve([])).then(nextBackups => {
      if (signal.aborted) return;
      setBackups(nextBackups);
      setSelectedBackup((selected) => nextBackups.some((item) => item.name === selected) ? selected : nextBackups[0]?.name ?? '');
    }).catch((error) => {
      if (!signal.aborted) setBackupError(String((error as Error).message ?? error));
    }).finally(() => { if (!signal.aborted) setBackupLoading(false); });
    void api.listTrashedPages(signal).then(nextTrash => {
      if (signal.aborted) return;
      setTrashedPages(nextTrash);
      setSelectedTrash((selected) => nextTrash.some((item) => item.name === selected) ? selected : nextTrash[0]?.name ?? '');
    }).catch((error) => {
      if (!signal.aborted) setTrashError(String((error as Error).message ?? error));
    }).finally(() => { if (!signal.aborted) setTrashLoading(false); });
    return () => controller.abort();
  }, [activePageId, sessionUserId, refresh]);

  const run = async (action: Action, task: () => Promise<void>) => {
    setBusy(action);
    setNotice(null);
    try { await task(); }
    catch (error) { setNotice({ ok: false, text: String((error as Error).message ?? error) }); }
    finally { setBusy(null); }
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
    if (!activePageId || !selectedBackup || !window.confirm('恢复备份会覆盖当前页的现有版本；系统会先自动备份当前数据。继续？')) return;
    await useTaskStore.getState().flush();
    const store = useTaskStore.getState();
    if (store.activePageId !== activePageId || useWorkspaceStore.getState().sessionUserId !== sessionUserId) return;
    const page = await api.restoreBackup(activePageId, selectedBackup, store.pageVersion);
    if (useWorkspaceStore.getState().sessionUserId !== sessionUserId) return;
    if (useTaskStore.getState().activePageId === activePageId) useTaskStore.getState().replaceLoadedPage(activePageId, page);
    await useWorkspaceStore.getState().refreshAllTasks();
    setNotice({ ok: true, text: '已恢复所选备份' });
    setRefresh((value) => value + 1);
  });
  const restoreTrash = () => void run('trash-restore', async () => {
    if (!selectedTrash || !window.confirm('恢复后页面会重新加入工作区。继续？')) return;
    await useTaskStore.getState().flush();
    const revision = useWorkspaceStore.getState().meta?.revision;
    let restored: Awaited<ReturnType<typeof api.restoreTrashedPage>>;
    try { restored = await api.restoreTrashedPage(selectedTrash, revision); }
    catch (error) {
      if (error && typeof error === 'object' && 'conflict' in error) await useWorkspaceStore.getState().refreshMetaAfterConflict();
      throw error;
    }
    if (restored.cleanupWarning) window.alert(restored.cleanupWarning);
    window.location.reload();
  });
  const restoreDraft = () => void run('draft-restore', async () => {
    if (!sessionUserId || !selectedDraft) return;
    const draft = drafts.find((candidate) => candidate.pageId === selectedDraft);
    if (!draft || !window.confirm('草稿会恢复为一个新页面，不会覆盖服务器上的原页面。继续？')) return;
    const meta = useWorkspaceStore.getState().meta;
    const created = await api.createPage(`草稿恢复 ${new Date(draft.savedAt).toLocaleString()}`, meta?.revision);
    const empty = await api.loadPage(created.page.id);
    await api.savePage(created.page.id, { nodes: draft.nodes, edges: draft.edges }, empty.version);
    clearTaskDraft(sessionUserId, draft.pageId);
    window.location.reload();
  });
  const loading = backupLoading || trashLoading;
  const backupDisabled = backupLoading || backupError !== null || busy !== null;
  const trashDisabled = trashLoading || trashError !== null || busy !== null;
  const mobileAction = embedded ? 'h-11 rounded-xl' : undefined;
  const restoreClass = embedded ? 'h-11 w-full rounded-xl' : undefined;
  const sectionClass = embedded ? 'settings-section' : 'border-b border-border/60 pb-5';
  const chevron = <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />;

  return <div className="space-y-4" data-settings-page="backups">
    <div className="flex min-h-8 items-center justify-between gap-3">
      <div className="text-xs text-muted-foreground">{loading && <span role="status" className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载备份…</span>}</div>
      <Button size="sm" variant="ghost" onClick={() => { setNotice(null); setRefresh((value) => value + 1); }} disabled={loading || busy !== null}>刷新备份</Button>
    </div>
    <section className={sectionClass}>
      <h3 className="mb-3 text-xs font-semibold">完整数据备份</h3>
      <div className="grid grid-cols-2 gap-3">
        <Button size="sm" className={mobileAction} variant="secondary" onClick={exportJson} disabled={busy !== null}><Download className="mr-1 h-3.5 w-3.5" />导出 JSON</Button>
        <label className={`inline-flex cursor-pointer items-center justify-center rounded-xl border border-input px-3 text-xs font-medium hover:bg-foreground/5 ${embedded ? 'h-11' : 'h-8'}`}><Upload className="mr-1 h-3.5 w-3.5" />导入 JSON
          <input type="file" accept="application/json" className="hidden" disabled={busy !== null} onChange={(event) => { const file = event.target.files?.[0]; if (file) importJson(file); event.currentTarget.value = ''; }} />
        </label>
      </div>
    </section>
    <section className={sectionClass}>
      <h3 className="mb-3 flex items-center gap-1 text-xs font-semibold"><History className="h-3.5 w-3.5" />当前页备份</h3>
      {backupError && <p role="alert" className="mb-3 text-xs text-destructive">加载备份失败：{backupError}，请点击刷新备份重试。</p>}
      {backups.length === 0 ? !backupLoading && !backupError && <p className="text-xs text-muted-foreground">{activePageId ? '暂无自动备份' : '当前没有已加载页面'}</p> : <div className="space-y-3">
        <div className="relative"><select aria-label="当前页备份" value={selectedBackup} onChange={(event) => setSelectedBackup(event.target.value)} disabled={backupDisabled} className={inputClass}>{backups.map((backup) => <option key={backup.name} value={backup.name}>{backupLabel(backup)}</option>)}</select>{chevron}</div>
        <Button size="sm" className={restoreClass} variant="secondary" onClick={restore} disabled={backupDisabled || !selectedBackup}><ArchiveRestore className="mr-1 h-3.5 w-3.5" />恢复所选备份</Button>
      </div>}
    </section>
    <section className={sectionClass}>
      <h3 className="mb-3 flex items-center gap-1 text-xs font-semibold"><ArchiveRestore className="h-3.5 w-3.5" />本地恢复草稿</h3>
      {drafts.length === 0 ? <p className="text-xs text-muted-foreground">暂无待处理草稿</p> : <div className="space-y-3">
        <div className="relative"><select aria-label="本地恢复草稿" value={selectedDraft} onChange={(event) => setSelectedDraft(event.target.value)} disabled={busy !== null} className={inputClass}>{drafts.map((draft) => <option key={draft.pageId} value={draft.pageId}>{draft.pageId} · {new Date(draft.savedAt).toLocaleString()} · {draft.nodes.length} 个任务</option>)}</select>{chevron}</div>
        <Button size="sm" className={restoreClass} variant="secondary" onClick={restoreDraft} disabled={busy !== null || !selectedDraft}><ArchiveRestore className="mr-1 h-3.5 w-3.5" />恢复为新页面</Button>
      </div>}
    </section>
    <section className={embedded ? 'settings-section' : undefined}>
      <h3 className="mb-3 flex items-center gap-1 text-xs font-semibold"><ArchiveRestore className="h-3.5 w-3.5" />已删除页面</h3>
      {trashError && <p role="alert" className="mb-3 text-xs text-destructive">加载回收站失败：{trashError}，请点击刷新备份重试。</p>}
      {trashedPages.length === 0 ? !trashLoading && !trashError && <p className="text-xs text-muted-foreground">回收站为空</p> : <div className="space-y-3">
        <div className="relative"><select aria-label="已删除页面" value={selectedTrash} onChange={(event) => setSelectedTrash(event.target.value)} disabled={trashDisabled} className={inputClass}>{trashedPages.map((item) => <option key={item.name} value={item.name}>{item.page.title} · {new Date(item.deletedAt).toLocaleString()}</option>)}</select>{chevron}</div>
        <Button size="sm" className={restoreClass} variant="secondary" onClick={restoreTrash} disabled={trashDisabled || !selectedTrash}><ArchiveRestore className="mr-1 h-3.5 w-3.5" />恢复删除页面</Button>
      </div>}
    </section>
    {notice && <p role={notice.ok ? 'status' : 'alert'} className={`text-xs ${notice.ok ? 'text-[hsl(var(--success))]' : 'text-destructive'}`}>{notice.text}</p>}
  </div>;
}
