import { create } from 'zustand';
import type {
  AllTasksItem,
  Meta,
  PageInfo,
  WorkspaceSettings,
} from '@todograph/shared';
import { api } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { registerAllTasksInvalidator, useTaskStore } from './useTaskStore';

interface WorkspaceStore {
  meta: Meta | null;
  loaded: boolean;
  /** 全量任务列表（所有页面聚合） —— 左侧全局列表用。 */
  allTasks: AllTasksItem[];
  allTasksLoading: boolean;

  // ---- lifecycle ----
  bootstrap: () => Promise<void>;

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

  // ---- settings ----
  updateSettings: (settings: WorkspaceSettings) => Promise<void>;

  // ---- aggregation ----
  refreshAllTasks: () => Promise<void>;
  /** 当前页的写操作完成后调用 —— 标脏 allTasks，稍后重拉。 */
  invalidateAllTasks: () => void;
}

/**
 * 工作区：多页面的总指挥。
 *
 * 数据流：
 *  bootstrap():  GET /api/meta → 填 meta/activePageId
 *             → 用 activePageId 加载当前页到 useTaskStore
 *             → GET /api/all-tasks 填 allTasks
 *
 *  switchPage(id):
 *             → flush 当前页（useTaskStore.flush）
 *             → useTaskStore.loadPage(id)
 *             → PATCH /api/pages/:id { activate: true }
 *             → meta.activePageId 本地更新
 *
 *  invalidateAllTasks: 任何写（save/create/delete/move）后调用；
 *             内部防抖 300ms 重拉 /api/all-tasks。
 */
export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  let allTasksTimer: ReturnType<typeof setTimeout> | null = null;
  let metaPollTimer: ReturnType<typeof setInterval> | null = null;
  const WORKSPACE_SYNCED_MESSAGE = '工作区已被其他设备修改，已同步最新状态';
  const WORKSPACE_RETRY_MESSAGE = '工作区已被其他设备修改，已刷新最新状态，请重新执行刚才的操作';
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
    metaPollTimer = setInterval(async () => {
      try {
        const latest = await api.loadMeta();
        const current = get().meta;
        if (!current || latest.revision === current.revision) return;
        // 工作区元信息已变更：更新页面列表
        set({ meta: latest });
        scheduleAllTasksRefresh();
        // 若当前活跃页被删或变更，切到新的活跃页
        const storePageId = useTaskStore.getState().activePageId;
        const pageIds = new Set(latest.pages.map((p) => p.id));
        if (!pageIds.has(storePageId)) {
          const next = latest.activePageId ?? latest.pages[0]?.id;
          if (next) await useTaskStore.getState().loadPage(next);
        }
      } catch {
        // 静默忽略网络错误
      }
    }, 5000);
  };
  const isConflictError = (
    err: unknown,
  ): err is Error & { conflict: boolean; serverRevision?: number; serverVersion?: number } =>
    !!err && typeof err === 'object' && 'conflict' in err && (err as { conflict?: unknown }).conflict === true;

  const syncMetaAfterConflict = async (preferredActivePageId?: string): Promise<Meta | null> => {
    try {
      const latestMeta = await api.loadMeta();
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
      }
      const nextMeta = nextActivePageId
        ? { ...latestMeta, activePageId: nextActivePageId }
        : latestMeta;
      set({ meta: nextMeta });
      scheduleAllTasksRefresh();
      return nextMeta;
    } catch (reloadErr) {
      console.warn('reload meta after conflict failed', reloadErr);
      return null;
    }
  };

  const handleWorkspaceError = async (
    title: string,
    err: unknown,
    preferredActivePageId?: string,
  ): Promise<void> => {
    if (isConflictError(err)) {
      await syncMetaAfterConflict(preferredActivePageId);
      toast.error(title, WORKSPACE_RETRY_MESSAGE);
      return;
    }
    toast.error(title, String((err as Error).message ?? err));
  };

  return {
    meta: null,
    loaded: false,
    allTasks: [],
    allTasksLoading: false,

    bootstrap: async () => {
      // 把 invalidate 方法挂进 useTaskStore —— 它写完数据后会触发
      registerAllTasksInvalidator(() => scheduleAllTasksRefresh());
      try {
        const meta = await api.loadMeta();
        set({ meta });
        // 保底：meta.activePageId 指向的页若不在列表里，退化到首个
        const active =
          meta.pages.find((p) => p.id === meta.activePageId)?.id ?? meta.pages[0]?.id;
        if (!active) {
          toast.error('加载失败', '工作区无页面');
          set({ loaded: true });
          return;
        }
        await useTaskStore.getState().loadPage(active);
        set({ loaded: true });
        void get().refreshAllTasks();
        startMetaPolling();
      } catch (err) {
        toast.error('加载失败', String((err as Error).message));
        set({ loaded: true });
      }
    },

    switchPage: async (pageId) => {
      const meta = get().meta;
      if (!meta) return;
      if (meta.activePageId === pageId) return;
      // 1. flush 当前页
      try {
        await useTaskStore.getState().flush();
      } catch {
        return;
      }
      // 2. 加载目标页
      try {
        await useTaskStore.getState().loadPage(pageId);
      } catch (err) {
        toast.error('切换页面失败', String((err as Error).message));
        return;
      }
      // 3. 持久化 activePageId（失败不影响本地状态）
      try {
        const nextMeta = await api.setActivePage(pageId, get().meta?.revision ?? meta.revision);
        if (nextMeta) {
          set({ meta: nextMeta });
          scheduleAllTasksRefresh();
          return;
        }
      } catch (err) {
        if (isConflictError(err)) {
          await syncMetaAfterConflict(pageId);
          toast.info('切换页面已同步', WORKSPACE_SYNCED_MESSAGE);
          return;
        }
        // 不打扰用户：本地已经切过去了；下次启动会落到老的 activePageId
        console.warn('setActivePage failed', err);
      }
      set({ meta: { ...(get().meta ?? meta), activePageId: pageId } });
      scheduleAllTasksRefresh();
    },

    createPage: async (title) => {
      const meta = get().meta;
      try {
        const result = await api.createPage(title, meta?.revision);
        set({ meta: result.meta });
        scheduleAllTasksRefresh();
        return result.page;
      } catch (err) {
        await handleWorkspaceError('创建页面失败', err);
        return null;
      }
    },

    deletePage: async (pageId) => {
      const meta = get().meta;
      if (!meta) return;
      if (meta.pages.length <= 1) {
        toast.error('不能删除最后一个页面');
        return;
      }
      try {
        const nextMeta = await api.deletePage(pageId, meta.revision);
        set({ meta: nextMeta });
        // 若删的是当前页，切到新 active
        if (meta.activePageId === pageId && nextMeta.activePageId !== pageId) {
          await useTaskStore.getState().loadPage(nextMeta.activePageId);
        }
        scheduleAllTasksRefresh();
      } catch (err) {
        await handleWorkspaceError('删除页面失败', err);
      }
    },

    renamePage: async (pageId, title) => {
      const meta = get().meta;
      if (!meta) return;
      try {
        const nextMeta = await api.renamePage(pageId, title, meta.revision);
        if (nextMeta) set({ meta: nextMeta });
        scheduleAllTasksRefresh();
      } catch (err) {
        await handleWorkspaceError('重命名失败', err);
      }
    },

    reorderPages: async (ids) => {
      const meta = get().meta;
      if (!meta) return;
      try {
        const nextMeta = await api.reorderPages(ids, meta.revision);
        set({ meta: nextMeta });
      } catch (err) {
        await handleWorkspaceError('排序失败', err);
      }
    },

    moveNodesToPage: async (nodeIds, target) => {
      const meta = get().meta;
      const sourcePageId = useTaskStore.getState().activePageId;
      const ids = [...new Set(nodeIds)];
      if (!meta || !sourcePageId || ids.length === 0) return null;

      let targetPageId = target.pageId;
      let targetTitle = '';

      if (!targetPageId) {
        const info = await get().createPage(target.newPageTitle?.trim() || '新页面');
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
      } catch {
        return null;
      }

      try {
        const targetPage = get().meta?.pages.find((page) => page.id === targetPageId);
        if (!targetPage) throw new Error(`target page not found: ${targetPageId}`);
        const targetGraph = await api.loadPage(targetPageId);
        const resp = await api.moveNodes(
          sourcePageId,
          targetPageId,
          ids,
          useTaskStore.getState().pageVersion,
          targetGraph.version,
        );

        await useTaskStore.getState().loadPage(targetPageId);
        try {
          const nextMeta = await api.setActivePage(targetPageId, get().meta?.revision);
          if (nextMeta) set({ meta: nextMeta });
        } catch (err) {
          if (isConflictError(err)) {
            await syncMetaAfterConflict(targetPageId);
            toast.info('移动后页面已同步', WORKSPACE_SYNCED_MESSAGE);
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
        if (isConflictError(err)) {
          try {
            await useTaskStore.getState().loadPage(sourcePageId);
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

    updateSettings: async (settings) => {
      const meta = get().meta;
      try {
        const nextMeta = await api.updateSettings(settings, meta?.revision);
        set({ meta: nextMeta });
      } catch (err) {
        await handleWorkspaceError('保存设置失败', err);
      }
    },

    refreshAllTasks: async () => {
      set({ allTasksLoading: true });
      try {
        const resp = await api.loadAllTasks();
        set({ allTasks: resp.tasks, allTasksLoading: false });
      } catch (err) {
        set({ allTasksLoading: false });
        console.warn('loadAllTasks failed', err);
      }
    },

    invalidateAllTasks: scheduleAllTasksRefresh,
  };
});
