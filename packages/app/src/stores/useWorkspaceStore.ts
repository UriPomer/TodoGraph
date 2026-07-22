import { create } from 'zustand';
import type {
  AllTasksItem,
  Meta,
  PageInfo,
} from '@todograph/shared';
import { api, getApiSessionGeneration, resetApiSession } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { useTaskStore } from './useTaskStore';
import { subscribeAllTasksInvalidated, subscribeWorkspaceMetaUpdated } from './workspaceEvents';
import type { PageViewportCache } from '@/features/graph/pageViewportCache';
import {
  DEFAULT_PAGE_MODE_CONTEXT,
  rememberPageModeContext as nextPageModeContext,
  type PageModeContext,
  type WorkspaceView,
} from '@/features/workspace/workspaceNavigation';

interface WorkspaceStore {
  sessionUserId: string | null;
  meta: Meta | null;
  loaded: boolean;
  /** 全量任务列表（所有页面聚合） —— 左侧全局列表用。 */
  allTasks: AllTasksItem[];
  allTasksLoading: boolean;
  /** Session-scoped graph viewports; mutated by the graph controller as an LRU. */
  pageViewportCache: PageViewportCache;
  /** Session-only return target when leaving checklist mode. */
  pageModeContext: PageModeContext;

  // ---- lifecycle ----
  bootstrap: (userId: string) => Promise<void>;
  resetSession: () => void;
  rememberPageModeContext: (pageId: string | null | undefined, view: WorkspaceView) => void;

  // ---- pages ----
  switchPage: (pageId: string) => Promise<void>;
  createPage: (title: string) => Promise<PageInfo | null>;
  deletePage: (pageId: string) => Promise<void>;
  renamePage: (pageId: string, title: string) => Promise<void>;
  reorderPages: (ids: string[]) => Promise<void>;
  moveNodesToPage: (
    nodeIds: string[],
    target: { pageId?: string; newPageTitle?: string },
  ) => Promise<string | null>;

  // ---- aggregation ----
  refreshAllTasks: () => Promise<void>;
  /** 当前页的写操作完成后调用 —— 标脏 allTasks，稍后重拉。 */
  invalidateAllTasks: () => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  let allTasksTimer: ReturnType<typeof setTimeout> | null = null;
  let metaPollTimer: ReturnType<typeof setInterval> | null = null;
  let metaPollInFlight = false;
  let allTasksRequest = 0;
  let pageSwitchRequest = 0;
  const isCurrentSession = (generation: number) => generation === getApiSessionGeneration();
  const WORKSPACE_SYNCED_MESSAGE = '工作区已被其他设备修改，已同步最新状态';
  const WORKSPACE_RETRY_MESSAGE = '工作区已被其他设备修改，已刷新最新状态，请重新执行刚才的操作';
  const WORKSPACE_SYNC_FAILED_MESSAGE = '工作区已被其他设备修改，但刷新失败，请刷新页面后重试';
  const PAGE_RETRY_MESSAGE = '页面已被其他设备修改，已重新加载最新数据，请重新执行刚才的操作';
  const scheduleAllTasksRefresh = () => {
    if (allTasksTimer) clearTimeout(allTasksTimer);
    allTasksTimer = setTimeout(() => {
      allTasksTimer = null;
      void get().refreshAllTasks();
    }, 300);
  };

  const stopMetaPolling = () => {
    if (metaPollTimer) {
      clearInterval(metaPollTimer);
      metaPollTimer = null;
    }
  };

  const startMetaPolling = () => {
    stopMetaPolling();
    const generation = getApiSessionGeneration();
    metaPollTimer = setInterval(async () => {
      if (metaPollInFlight) return;
      metaPollInFlight = true;
      try {
        const latest = await api.loadMeta();
        if (!isCurrentSession(generation)) return;
        const current = get().meta;
        if (!current || latest.revision === current.revision) return;
        const storePageId = useTaskStore.getState().activePageId;
        const pageIds = new Set(latest.pages.map((p) => p.id));
        set({ meta: storePageId && pageIds.has(storePageId)
          ? { ...latest, activePageId: storePageId } : latest });
        scheduleAllTasksRefresh();
        if (!storePageId || !pageIds.has(storePageId)) {
          const next = latest.activePageId ?? latest.pages[0]?.id;
          if (next) await useTaskStore.getState().loadPage(next);
        }
      } catch {
        // 静默忽略网络错误
      } finally {
        metaPollInFlight = false;
      }
    }, 5000);
  };
  const isConflictError = (
    err: unknown,
  ): err is Error & { conflict: boolean; serverRevision?: number; serverVersion?: number } =>
    !!err && typeof err === 'object' && 'conflict' in err && (err as { conflict?: unknown }).conflict === true;

  const syncMetaAfterConflict = async (
    generation: number,
    preferredActivePageId?: string,
    isStillCurrent: () => boolean = () => true,
  ): Promise<Meta | null> => {
    try {
      const latestMeta = await api.loadMeta();
      if (!isCurrentSession(generation) || !isStillCurrent()) return null;
      const storePageId = useTaskStore.getState().activePageId;
      const pageIds = new Set(latestMeta.pages.map((page) => page.id));
      let nextActivePageId = preferredActivePageId;
      if (!nextActivePageId || !pageIds.has(nextActivePageId)) {
        nextActivePageId =
          (storePageId && pageIds.has(storePageId) ? storePageId : undefined) ??
          latestMeta.activePageId ??
          latestMeta.pages[0]?.id;
      }
      if (nextActivePageId && storePageId !== nextActivePageId) {
        await useTaskStore.getState().loadPage(nextActivePageId);
        if (!isCurrentSession(generation) || !isStillCurrent()) return null;
      }
      const nextMeta = nextActivePageId
        ? { ...latestMeta, activePageId: nextActivePageId }
        : latestMeta;
      set({ meta: nextMeta });
      scheduleAllTasksRefresh();
      return nextMeta;
    } catch { return null; }
  };

  const handleWorkspaceError = async (
    generation: number,
    title: string,
    err: unknown,
    preferredActivePageId?: string,
  ): Promise<void> => {
    if (!isCurrentSession(generation)) return;
    if (isConflictError(err)) {
      const synced = await syncMetaAfterConflict(generation, preferredActivePageId);
      if (!isCurrentSession(generation)) return;
      toast.error(title, synced ? WORKSPACE_RETRY_MESSAGE : WORKSPACE_SYNC_FAILED_MESSAGE);
      return;
    }
    toast.error(title, String((err as Error).message ?? err));
  };
  subscribeAllTasksInvalidated(scheduleAllTasksRefresh);
  subscribeWorkspaceMetaUpdated((meta) => set({ meta }));

  const resetSession = () => {
    pageSwitchRequest += 1;
    resetApiSession();
    stopMetaPolling();
    if (allTasksTimer) clearTimeout(allTasksTimer);
    allTasksTimer = null;
    useTaskStore.getState().resetSession();
    set({
      sessionUserId: null,
      meta: null,
      loaded: false,
      allTasks: [],
      allTasksLoading: false,
      pageViewportCache: new Map(),
      pageModeContext: DEFAULT_PAGE_MODE_CONTEXT,
    });
  };

  return {
    sessionUserId: null,
    meta: null,
    loaded: false,
    allTasks: [],
    allTasksLoading: false,
    pageViewportCache: new Map(),
    pageModeContext: DEFAULT_PAGE_MODE_CONTEXT,

    resetSession,
    rememberPageModeContext: (pageId, view) => set((state) => ({
      pageModeContext: nextPageModeContext(state.pageModeContext, pageId, view),
    })),

    bootstrap: async (userId) => {
      resetSession();
      const generation = getApiSessionGeneration();
      useTaskStore.getState().setSessionUser(userId);
      set({ sessionUserId: userId });
      try {
        const meta = await api.loadMeta();
        if (!isCurrentSession(generation)) return;
        set({
          meta,
          pageModeContext: nextPageModeContext(
            DEFAULT_PAGE_MODE_CONTEXT,
            meta.activePageId,
            'list',
          ),
        });
        const active =
          meta.pages.find((p) => p.id === meta.activePageId)?.id ?? meta.pages[0]?.id;
        if (!active) {
          toast.error('加载失败', '工作区无页面');
          set({ loaded: true });
          return;
        }
        await useTaskStore.getState().loadPage(active);
        if (!isCurrentSession(generation)) return;
        set({ loaded: true });
        void get().refreshAllTasks();
        startMetaPolling();
      } catch (err) {
        if (!isCurrentSession(generation)) return;
        toast.error('加载失败', String((err as Error).message));
        set({ loaded: true });
      }
    },

    switchPage: async (pageId) => {
      const requestId = ++pageSwitchRequest;
      const isCurrentSwitch = () => requestId === pageSwitchRequest;
      const generation = getApiSessionGeneration();
      const meta = get().meta;
      if (!meta) return;
      if (meta.activePageId === pageId) return;
      try {
        // loadPage owns the drain-before-switch boundary and can immediately paint a cached page.
        await useTaskStore.getState().loadPage(pageId);
        if (!isCurrentSession(generation) || !isCurrentSwitch()) return;
      } catch (err) {
        if (!isCurrentSession(generation) || !isCurrentSwitch()) return;
        toast.error('切换页面失败', String((err as Error).message));
        return;
      }
      try {
        const nextMeta = await api.setActivePage(pageId, get().meta?.revision ?? meta.revision);
        if (!isCurrentSession(generation) || !isCurrentSwitch()) return;
        if (nextMeta) {
          set({ meta: nextMeta });
          scheduleAllTasksRefresh();
          return;
        }
      } catch (err) {
        if (!isCurrentSession(generation) || !isCurrentSwitch()) return;
        if (isConflictError(err)) {
          const synced = await syncMetaAfterConflict(generation, pageId, isCurrentSwitch);
          if (!isCurrentSession(generation) || !isCurrentSwitch()) return;
          if (synced) toast.info('切换页面已同步', WORKSPACE_SYNCED_MESSAGE);
          else toast.error('切换页面同步失败', WORKSPACE_SYNC_FAILED_MESSAGE);
          return;
        }
        console.warn('setActivePage failed', err);
      }
      set({ meta: { ...(get().meta ?? meta), activePageId: pageId } });
      scheduleAllTasksRefresh();
    },

    createPage: async (title) => {
      const generation = getApiSessionGeneration();
      const meta = get().meta;
      try {
        const result = await api.createPage(title, meta?.revision);
        if (!isCurrentSession(generation)) return null;
        set({ meta: result.meta });
        scheduleAllTasksRefresh();
        return result.page;
      } catch (err) {
        await handleWorkspaceError(generation, '创建页面失败', err);
        return null;
      }
    },

    deletePage: async (pageId) => {
      const generation = getApiSessionGeneration();
      const meta = get().meta;
      if (!meta) return;
      if (meta.pages.length <= 1) {
        toast.error('不能删除最后一个页面');
        return;
      }
      if (useTaskStore.getState().activePageId === pageId) {
        try { await useTaskStore.getState().flush(); } catch { return; }
        if (!isCurrentSession(generation)) return;
      }
      try {
        const nextMeta = await api.deletePage(pageId, meta.revision);
        if (!isCurrentSession(generation)) return;
        set({ meta: nextMeta });
        if (meta.activePageId === pageId && nextMeta.activePageId !== pageId) {
          await useTaskStore.getState().loadPage(nextMeta.activePageId);
          if (!isCurrentSession(generation)) return;
        }
        scheduleAllTasksRefresh();
      } catch (err) {
        await handleWorkspaceError(generation, '删除页面失败', err);
      }
    },

    renamePage: async (pageId, title) => {
      const generation = getApiSessionGeneration();
      const meta = get().meta;
      if (!meta) return;
      try {
        const nextMeta = await api.renamePage(pageId, title, meta.revision);
        if (!isCurrentSession(generation)) return;
        if (nextMeta) set({ meta: nextMeta });
        scheduleAllTasksRefresh();
      } catch (err) {
        await handleWorkspaceError(generation, '重命名失败', err);
      }
    },

    reorderPages: async (ids) => {
      const generation = getApiSessionGeneration();
      const meta = get().meta;
      if (!meta) return;
      try {
        const nextMeta = await api.reorderPages(ids, meta.revision);
        if (!isCurrentSession(generation)) return;
        set({ meta: nextMeta });
      } catch (err) {
        await handleWorkspaceError(generation, '排序失败', err);
      }
    },

    moveNodesToPage: async (nodeIds, target) => {
      const generation = getApiSessionGeneration();
      const meta = get().meta;
      const sourcePageId = useTaskStore.getState().activePageId;
      const ids = [...new Set(nodeIds)];
      if (!meta || !sourcePageId || ids.length === 0) return null;

      let targetPageId = target.pageId;
      let targetTitle = '';

      if (!targetPageId) {
        const info = await get().createPage(target.newPageTitle?.trim() || '新页面');
        if (!isCurrentSession(generation)) return null;
        if (!info) return null;
        targetPageId = info.id;
        targetTitle = info.title;
      } else {
        const page = get().meta?.pages.find((page) => page.id === targetPageId);
        targetTitle = page?.title ?? targetPageId;
      }

      if (targetPageId === sourcePageId) {
        toast.error('不能移动到当前页面');
        return null;
      }

      try {
        await useTaskStore.getState().flush();
        if (!isCurrentSession(generation)) return null;
      } catch {
        return null;
      }

      try {
        const targetPage = get().meta?.pages.find((page) => page.id === targetPageId);
        if (!targetPage) throw new Error(`target page not found: ${targetPageId}`);
        const targetGraph = await api.loadPage(targetPageId);
        if (!isCurrentSession(generation)) return null;
        const resp = await api.moveNodes(
          sourcePageId,
          targetPageId,
          ids,
          useTaskStore.getState().pageVersion,
          targetGraph.version,
        );
        if (!isCurrentSession(generation)) return null;

        await useTaskStore.getState().loadPage(targetPageId);
        if (!isCurrentSession(generation)) return null;
        try {
          const nextMeta = await api.setActivePage(targetPageId, get().meta?.revision);
          if (!isCurrentSession(generation)) return null;
          if (nextMeta) set({ meta: nextMeta });
        } catch (err) {
          if (!isCurrentSession(generation)) return null;
          if (isConflictError(err)) {
            const synced = await syncMetaAfterConflict(generation, targetPageId);
            if (!isCurrentSession(generation)) return null;
            if (synced) toast.info('移动后页面已同步', WORKSPACE_SYNCED_MESSAGE);
            else toast.error('移动后页面同步失败', WORKSPACE_SYNC_FAILED_MESSAGE);
            scheduleAllTasksRefresh();
            return targetPageId;
          }
          console.warn('setActivePage failed after moveNodes', err);
        }

        const nextMeta = get().meta;
        if (nextMeta) {
          set({ meta: { ...nextMeta, activePageId: targetPageId } });
        }
        scheduleAllTasksRefresh();

        const details = [`${resp.movedNodes} 个节点`];
        if (resp.autoIncludedChildren > 0) {
          details.push(`自动带上 ${resp.autoIncludedChildren} 个子节点`);
        }
        if (resp.droppedParentLinks > 0) {
          details.push(`拆开 ${resp.droppedParentLinks} 个父链接`);
        }
        if (resp.lostEdges > 0) {
          details.push(`断开 ${resp.lostEdges} 条跨页依赖`);
        }
        toast.info(`已移动到 ${targetTitle}`, details.join('，'));
        return targetPageId;
      } catch (err) {
        if (!isCurrentSession(generation)) return null;
        if (isConflictError(err)) {
          try {
            await useTaskStore.getState().loadPage(sourcePageId);
            if (!isCurrentSession(generation)) return null;
            scheduleAllTasksRefresh();
            toast.error('移动节点失败', PAGE_RETRY_MESSAGE);
          } catch {
            toast.error('移动节点失败', '页面已被其他设备修改，重新加载最新数据失败，请刷新页面后重试');
          }
          return null;
        }
        toast.error('移动节点失败', String((err as Error).message));
        return null;
      }
    },

    refreshAllTasks: async () => {
      const generation = getApiSessionGeneration();
      const requestId = ++allTasksRequest;
      set({ allTasksLoading: true });
      try {
        const resp = await api.loadAllTasks();
        if (!isCurrentSession(generation) || requestId !== allTasksRequest) return;
        set({ allTasks: resp.tasks, allTasksLoading: false });
        if (resp.errors?.length) {
          toast.error('部分页面读取失败', `有 ${resp.errors.length} 个页面未显示，请先导出数据并检查服务器日志`);
        }
      } catch (err) {
        if (!isCurrentSession(generation) || requestId !== allTasksRequest) return;
        set({ allTasksLoading: false });
        console.warn('loadAllTasks failed', err);
      }
    },

    invalidateAllTasks: scheduleAllTasksRefresh,
  };
});
