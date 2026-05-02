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
  const scheduleAllTasksRefresh = () => {
    if (allTasksTimer) clearTimeout(allTasksTimer);
    allTasksTimer = setTimeout(() => {
      allTasksTimer = null;
      void get().refreshAllTasks();
    }, 300);
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
      await useTaskStore.getState().flush();
      // 2. 加载目标页
      try {
        await useTaskStore.getState().loadPage(pageId);
      } catch (err) {
        toast.error('切换页面失败', String((err as Error).message));
        return;
      }
      // 3. 持久化 activePageId（失败不影响本地状态）
      try {
        await api.setActivePage(pageId);
      } catch (err) {
        // 不打扰用户：本地已经切过去了；下次启动会落到老的 activePageId
        console.warn('setActivePage failed', err);
      }
      set({ meta: { ...meta, activePageId: pageId } });
      scheduleAllTasksRefresh();
    },

    createPage: async (title) => {
      try {
        const info = await api.createPage(title);
        const meta = get().meta;
        if (meta) set({ meta: { ...meta, pages: [...meta.pages, info] } });
        scheduleAllTasksRefresh();
        return info;
      } catch (err) {
        toast.error('创建页面失败', String((err as Error).message));
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
        await api.deletePage(pageId);
        const nextPages = meta.pages.filter((p) => p.id !== pageId);
        const nextActive =
          meta.activePageId === pageId ? (nextPages[0]?.id ?? meta.activePageId) : meta.activePageId;
        set({ meta: { ...meta, pages: nextPages, activePageId: nextActive } });
        // 若删的是当前页，切到新 active
        if (meta.activePageId === pageId && nextActive !== pageId) {
          await useTaskStore.getState().loadPage(nextActive);
        }
        scheduleAllTasksRefresh();
      } catch (err) {
        toast.error('删除页面失败', String((err as Error).message));
      }
    },

    renamePage: async (pageId, title) => {
      const meta = get().meta;
      if (!meta) return;
      try {
        await api.renamePage(pageId, title);
        const nextPages = meta.pages.map((p) => (p.id === pageId ? { ...p, title } : p));
        set({ meta: { ...meta, pages: nextPages } });
        scheduleAllTasksRefresh();
      } catch (err) {
        toast.error('重命名失败', String((err as Error).message));
      }
    },

    reorderPages: async (ids) => {
      const meta = get().meta;
      if (!meta) return;
      try {
        await api.reorderPages(ids);
        const byId = new Map(meta.pages.map((p) => [p.id, p]));
        const nextPages: PageInfo[] = ids
          .map((id, i) => {
            const p = byId.get(id);
            return p ? { ...p, order: i } : null;
          })
          .filter((p): p is PageInfo => p !== null);
        set({ meta: { ...meta, pages: nextPages } });
      } catch (err) {
        toast.error('排序失败', String((err as Error).message));
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
        targetTitle =
          get().meta?.pages.find((page) => page.id === targetPageId)?.title ?? targetPageId;
      }

      if (targetPageId === sourcePageId) {
        toast.error('不能移动到当前页面');
        return null;
      }

      try {
        await useTaskStore.getState().flush();
        const resp = await api.moveNodes(sourcePageId, targetPageId, ids);

        await useTaskStore.getState().loadPage(targetPageId);
        try {
          await api.setActivePage(targetPageId);
        } catch (err) {
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
        toast.error('移动节点失败', String((err as Error).message));
        return null;
      }
    },

    updateSettings: async (settings) => {
      const meta = get().meta;
      try {
        await api.updateSettings(settings);
        if (meta) set({ meta: { ...meta, settings } });
      } catch (err) {
        toast.error('保存设置失败', String((err as Error).message));
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
