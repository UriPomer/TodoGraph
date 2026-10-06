import { create } from 'zustand';
import type { PageData } from '@todograph/shared';
import { api, getApiSessionGeneration } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { repairGeometry } from '@/lib/taskGeometry';
import { useHistoryStore } from './useHistoryStore';
import { emitAllTasksInvalidated, emitWorkspaceMetaUpdated } from './workspaceEvents';
import { createTaskPersistenceCoordinator } from './taskPersistenceCoordinator';
import { clearTaskDraft, clearTaskDraftIfMatching, loadTaskDraft, saveTaskDraft } from './taskDraftStorage';
import { createTaskActions } from './taskActions';
import { createTaskHierarchyActions } from './taskHierarchyActions';
import type { TaskStore } from './taskStoreTypes';

export const useTaskStore = create<TaskStore>((set, get) => {
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  let loadRequestId = 0;
  let sessionUserId: string | null = null;
  let draftStorageWarningShown = false;
  const warnedStaleDrafts = new Set<string>();
  const pageCache = new Map<string, PageData>();
  const rememberPage = (pageId: string, data: PageData) => {
    pageCache.delete(pageId);
    pageCache.set(pageId, data);
    if (pageCache.size > 12) pageCache.delete(pageCache.keys().next().value!);
  };
  const stopPolling = () => {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  };
  const startPolling = (pageId: string) => {
    stopPolling();
    const generation = getApiSessionGeneration();
    pollTimer = setInterval(async () => {
      if (hasPendingSave() || pollInFlight) return;
      pollInFlight = true;
      try {
        const g = await api.loadPage(pageId);
        if (generation !== getApiSessionGeneration()) return;
        if (hasPendingSave()) return;
        const { activePageId, pageVersion } = get();
        if (g.version !== pageVersion && activePageId === pageId) {
          const repaired = repairGeometry(g.nodes);
          rememberPage(pageId, { ...g, nodes: repaired });
          set((state) => ({
            nodes: repaired,
            edges: g.edges,
            pageVersion: g.version ?? 0,
            backupDirty: false,
            recommendationRevision: state.recommendationRevision + 1,
            listRevision: state.listRevision + 1,
          }));
          useHistoryStore.getState().clear();
          if (repaired !== g.nodes) scheduleSave();
        }
      } catch {
      } finally {
        pollInFlight = false;
      }
    }, 5000);
  };
  const persistence = createTaskPersistenceCoordinator({
    getActivePageId: () => get().activePageId,
    onScheduled: () => set((state) => ({
      backupDirty: true,
      backupRevision: state.backupRevision + 1,
    })),
    shouldRetry: (error, pageId) => {
      const candidate = error as Error & { conflict?: boolean };
      return !candidate.conflict && get().activePageId === pageId;
    },
    persist: async (pid) => {
      const generation = getApiSessionGeneration();
      const { activePageId, nodes, edges, pageVersion } = get();
      if (activePageId !== pid) return;
      const persistedDraft = sessionUserId
        ? saveTaskDraft(sessionUserId, pid, pageVersion, nodes, edges)
        : null;
      try {
        const { version: newVersion } = await api.savePage(pid, { nodes, edges }, pageVersion);
        if (generation !== getApiSessionGeneration()) return;
        set({ pageVersion: newVersion });
        if (sessionUserId && persistedDraft) clearTaskDraftIfMatching(sessionUserId, persistedDraft);
        emitAllTasksInvalidated();
      } catch (err) {
        if (generation !== getApiSessionGeneration()) return;
        const e = err as Error & { conflict?: boolean; serverVersion?: number };
        if (e.conflict) {
          let recoveryMessage = persistedDraft
            ? '本地修改已保存在此设备的恢复草稿中'
            : '无法创建恢复页，本地修改未能持久化';
          try {
            const recovery = await api.createPage(`冲突恢复 ${new Date().toLocaleString()}`);
            const empty = await api.loadPage(recovery.page.id);
            await api.savePage(recovery.page.id, { nodes, edges }, empty.version);
            if (sessionUserId && persistedDraft) clearTaskDraftIfMatching(sessionUserId, persistedDraft);
            emitWorkspaceMetaUpdated(recovery.meta);
            recoveryMessage = `本地修改已另存为“${recovery.page.title}”`;
          } catch {
            // The durable local draft remains the last-resort recovery point.
          }
          toast.error('保存冲突', `${recoveryMessage}，当前页已加载服务器版本`);
          try {
            const g = await api.loadPage(pid);
            if (generation !== getApiSessionGeneration()) return;
            applyPage(pid, { ...g, version: e.serverVersion ?? g.version });
          } catch (_reloadErr) {
            toast.error('重新加载失败', '请刷新页面');
          }
          throw e;
        }
        toast.error('保存失败', String(e.message ?? err));
        throw e;
      }
    },
  });
  const hasPendingSave = () => persistence.hasPending();
  const scheduleSave = () => {
    const state = get();
    if (sessionUserId && state.activePageId) {
      const stored = saveTaskDraft(
        sessionUserId,
        state.activePageId,
        state.pageVersion,
        state.nodes,
        state.edges,
      );
      if (typeof localStorage !== 'undefined' && !stored && !draftStorageWarningShown) {
        draftStorageWarningShown = true;
        toast.error('本地草稿不可用', '浏览器存储空间不足，请先导出工作区');
      }
    }
    persistence.schedule();
  };
  const flush = () => persistence.flush();
  /**
   * 在 mutation 之前记录前态快照 —— undo 返回的就是这个前态。
   * nodes/edges 引用本身不可变（store 所有写都走 immutable 模式），
   * 所以共享引用安全，不需要深拷贝。
   */
  const pushPre = () => {
    const { nodes, edges } = get();
    useHistoryStore.getState().push({ nodes, edges });
  };
  const applyPage = (pageId: string, data: PageData) => {
    const draft = sessionUserId ? loadTaskDraft(sessionUserId, pageId) : null;
    const serverMatchesDraft = draft
      ? JSON.stringify({ nodes: draft.nodes, edges: draft.edges }) ===
        JSON.stringify({ nodes: data.nodes, edges: data.edges })
      : false;
    if (draft && serverMatchesDraft && sessionUserId) clearTaskDraft(sessionUserId, pageId);
    const recoveredDraft = draft && !serverMatchesDraft && draft.baseVersion === (data.version ?? 0)
      ? draft
      : null;
    if (draft && !serverMatchesDraft && !recoveredDraft) {
      const warningKey = `${pageId}:${draft.baseVersion}:${draft.savedAt}`;
      if (!warnedStaleDrafts.has(warningKey)) {
        warnedStaleDrafts.add(warningKey);
        toast.error('发现冲突草稿', '服务器版本已变化，本地草稿仍保存在此设备中');
      }
    }
    const effective = recoveredDraft
      ? { ...data, nodes: recoveredDraft.nodes, edges: recoveredDraft.edges }
      : data;
    const repaired = repairGeometry(effective.nodes);
    rememberPage(pageId, { ...data, nodes: repaired, edges: effective.edges });
    set((state) => ({
      activePageId: pageId,
      pageVersion: data.version ?? 0,
      nodes: repaired,
      edges: effective.edges,
      loaded: true,
      viewportCenter: null,
      backupDirty: false,
      recommendationRevision: state.recommendationRevision + 1,
      listRevision: state.listRevision + 1,
    }));
    useHistoryStore.getState().clear();
    if (recoveredDraft) toast.info('已恢复本地草稿', '正在重新保存关闭前的修改');
    if (recoveredDraft || repaired !== effective.nodes) scheduleSave();
  };
  const cancelScheduledSave = () => {
    persistence.cancel();
  };
  const resetSession = () => {
    loadRequestId += 1;
    stopPolling();
    cancelScheduledSave();
    sessionUserId = null;
    draftStorageWarningShown = false;
    warnedStaleDrafts.clear();
    pageCache.clear();
    useHistoryStore.getState().clear();
    set({
      activePageId: null,
      pageVersion: 0,
      nodes: [],
      edges: [],
      loaded: false,
      viewportCenter: null,
      backupDirty: false,
      recommendationRevision: get().recommendationRevision + 1,
      listRevision: get().listRevision + 1,
    });
  };
  return {
    activePageId: null,
    pageVersion: 0,
    nodes: [],
    edges: [],
    recommendationRevision: 0,
    listRevision: 0,
    loaded: false,
    viewportCenter: null,
    backupDirty: false,
    backupRevision: 0,
    setViewportCenter: (p) => set({ viewportCenter: p }),
    loadPage: async (pageId) => {
      const requestId = ++loadRequestId;
      const generation = getApiSessionGeneration();
      await flush();
      if (generation !== getApiSessionGeneration() || requestId !== loadRequestId) return;
      const current = get();
      if (current.activePageId && current.loaded) {
        rememberPage(current.activePageId, {
          nodes: current.nodes,
          edges: current.edges,
          version: current.pageVersion,
        });
      }
      const cached = pageCache.get(pageId);
      if (cached) {
        applyPage(pageId, cached);
        startPolling(pageId);
      }
      try {
        const g = await api.loadPage(pageId);
        if (generation !== getApiSessionGeneration() || requestId !== loadRequestId) return;
        const visible = get();
        if (!cached || visible.activePageId !== pageId || visible.pageVersion !== (g.version ?? 0)) {
          applyPage(pageId, g);
        } else {
          rememberPage(pageId, g);
        }
        startPolling(pageId);
      } catch (err) {
        if (generation !== getApiSessionGeneration() || requestId !== loadRequestId) return;
        if (cached) {
          toast.info('已显示页面缓存', '连接恢复后会自动同步最新数据');
          return;
        }
        toast.error('加载页面失败', String((err as Error).message));
        set({ loaded: true });
        throw err;
      }
    },
    replaceLoadedPage: (pageId, data) => {
      loadRequestId += 1;
      cancelScheduledSave();
      if (sessionUserId) clearTaskDraft(sessionUserId, pageId);
      applyPage(pageId, data);
      startPolling(pageId);
    },
    flush,
    hasPendingSave,
    resetSession,
    setSessionUser: (userId) => {
      sessionUserId = userId;
      draftStorageWarningShown = false;
      warnedStaleDrafts.clear();
    },
    ...createTaskActions({ set, get, pushPre, scheduleSave }),
    ...createTaskHierarchyActions({ set, get, pushPre, scheduleSave }),
    markBackupDone: (pageId, revision) => set((state) => state.activePageId === pageId
      && state.backupRevision === revision ? { backupDirty: false } : state),
  };
});
