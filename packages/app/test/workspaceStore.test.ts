import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta, PageData, PageInfo } from '@todograph/shared';

const { api, toast } = vi.hoisted(() => ({
  api: {
    loadMeta: vi.fn(),
    updateSettings: vi.fn(),
    loadPage: vi.fn(),
    savePage: vi.fn(),
    createPage: vi.fn(),
    deletePage: vi.fn(),
    renamePage: vi.fn(),
    setActivePage: vi.fn(),
    reorderPages: vi.fn(),
    moveNodes: vi.fn(),
    createBackup: vi.fn(),
    loadAllTasks: vi.fn(),
    exportMarkdown: vi.fn(),
  },
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    action: vi.fn(),
  },
}));

vi.mock('@/api/client', () => ({ api }));
vi.mock('@/components/ui/toaster-store', () => ({ toast }));

import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useHistoryStore } from '@/stores/useHistoryStore';

function makePage(id: string, title: string, order: number): PageInfo {
  return {
    id,
    title,
    order,
    createdAt: '2026-05-18T00:00:00.000Z',
  };
}

function makeMeta(revision: number, activePageId: string, pages: PageInfo[]): Meta {
  return {
    version: 2,
    revision,
    activePageId,
    pages,
    settings: {
      mergeHoverMs: 600,
      ungroupConfirmMs: 1200,
    },
  };
}

function makePageData(version: number, id = 'node-from-server'): PageData {
  return {
    version,
    nodes: [{ id, title: id, status: 'todo' }],
    edges: [],
  };
}

describe('workspace/task store conflict handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useHistoryStore.getState().clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('moves nodes to a newly created page using refreshed meta', async () => {
    const sourcePage = makePage('p-source', '源页面', 0);
    const targetPage = makePage('p-target', '新页面', 1);
    const initialMeta = makeMeta(1, sourcePage.id, [sourcePage]);
    const metaAfterCreate = makeMeta(2, sourcePage.id, [sourcePage, targetPage]);
    const metaAfterActivate = makeMeta(3, targetPage.id, [sourcePage, targetPage]);

    useWorkspaceStore.setState({
      meta: initialMeta,
      loaded: true,
      allTasks: [],
      allTasksLoading: false,
    });
    useTaskStore.setState({
      activePageId: sourcePage.id,
      pageVersion: 4,
      nodes: [],
      edges: [],
      loaded: true,
      backupDirty: false,
      flush: vi.fn().mockResolvedValue(undefined),
      loadPage: vi.fn().mockImplementation(async (pageId: string) => {
        useTaskStore.setState({
          activePageId: pageId,
          pageVersion: 0,
          nodes: [],
          edges: [],
          loaded: true,
          backupDirty: false,
        });
      }),
    } as Partial<ReturnType<typeof useTaskStore.getState>>);

    api.createPage.mockResolvedValue({ page: targetPage, meta: metaAfterCreate });
    api.loadPage.mockResolvedValue({ nodes: [], edges: [], version: 0 });
    api.moveNodes.mockResolvedValue({
      movedNodes: 1,
      movedEdges: 0,
      autoIncludedChildren: 0,
      lostEdges: 0,
      droppedParentLinks: 0,
    });
    api.setActivePage.mockResolvedValue(metaAfterActivate);

    const movedTo = await useWorkspaceStore.getState().moveNodesToPage(['n-1'], {
      newPageTitle: targetPage.title,
    });

    expect(movedTo).toBe(targetPage.id);
    expect(api.moveNodes).toHaveBeenCalledWith(sourcePage.id, targetPage.id, ['n-1'], 4, 0);
    expect(useWorkspaceStore.getState().meta?.activePageId).toBe(targetPage.id);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('refreshes workspace revision after setActivePage conflict', async () => {
    const sourcePage = makePage('p-1', '第一页', 0);
    const targetPage = makePage('p-2', '第二页', 1);
    const staleMeta = makeMeta(1, sourcePage.id, [sourcePage, targetPage]);
    const latestMeta = makeMeta(5, sourcePage.id, [sourcePage, targetPage]);

    useWorkspaceStore.setState({
      meta: staleMeta,
      loaded: true,
      allTasks: [],
      allTasksLoading: false,
    });
    useTaskStore.setState({
      activePageId: sourcePage.id,
      pageVersion: 2,
      nodes: [],
      edges: [],
      loaded: true,
      backupDirty: false,
      flush: vi.fn().mockResolvedValue(undefined),
      loadPage: vi.fn().mockImplementation(async (pageId: string) => {
        useTaskStore.setState({
          activePageId: pageId,
          pageVersion: 2,
          nodes: [],
          edges: [],
          loaded: true,
          backupDirty: false,
        });
      }),
    } as Partial<ReturnType<typeof useTaskStore.getState>>);

    api.setActivePage.mockRejectedValue(
      Object.assign(new Error('版本冲突：工作区已被其他设备修改'), {
        conflict: true,
        serverRevision: latestMeta.revision,
      }),
    );
    api.loadMeta.mockResolvedValue(latestMeta);

    await useWorkspaceStore.getState().switchPage(targetPage.id);

    expect(api.loadMeta).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().meta).toMatchObject({
      revision: latestMeta.revision,
      activePageId: targetPage.id,
    });
    expect(toast.info).toHaveBeenCalledWith(
      '切换页面已同步',
      '工作区已被其他设备修改，已同步最新状态',
    );
  });

  it('reloads latest meta and asks for retry on workspace write conflicts', async () => {
    const sourcePage = makePage('p-1', '第一页', 0);
    const staleMeta = makeMeta(1, sourcePage.id, [sourcePage]);
    const latestMeta = makeMeta(4, sourcePage.id, [sourcePage]);

    useWorkspaceStore.setState({
      meta: staleMeta,
      loaded: true,
      allTasks: [],
      allTasksLoading: false,
    });

    api.createPage.mockRejectedValue(
      Object.assign(new Error('版本冲突：工作区已被其他设备修改'), {
        conflict: true,
        serverRevision: latestMeta.revision,
      }),
    );
    api.loadMeta.mockResolvedValue(latestMeta);

    await expect(useWorkspaceStore.getState().createPage('新页面')).resolves.toBeNull();

    expect(api.loadMeta).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().meta).toMatchObject({
      revision: latestMeta.revision,
      activePageId: sourcePage.id,
    });
    expect(toast.error).toHaveBeenCalledWith(
      '创建页面失败',
      '工作区已被其他设备修改，已刷新最新状态，请重新执行刚才的操作',
    );
  });

  it('reloads the current page and asks for retry on move conflict', async () => {
    const sourcePage = makePage('p-source', '源页面', 0);
    const targetPage = makePage('p-target', '目标页', 1);
    const meta = makeMeta(3, sourcePage.id, [sourcePage, targetPage]);
    const loadPage = vi.fn().mockImplementation(async (pageId: string) => {
      useTaskStore.setState({
        activePageId: pageId,
        pageVersion: 8,
        nodes: [{ id: `reloaded-${pageId}`, title: pageId, status: 'todo' }],
        edges: [],
        loaded: true,
        backupDirty: false,
      });
    });

    useWorkspaceStore.setState({
      meta,
      loaded: true,
      allTasks: [],
      allTasksLoading: false,
    });
    useTaskStore.setState({
      activePageId: sourcePage.id,
      pageVersion: 6,
      nodes: [{ id: 'n-1', title: '本地节点', status: 'todo' }],
      edges: [],
      loaded: true,
      backupDirty: false,
      flush: vi.fn().mockResolvedValue(undefined),
      loadPage,
    } as Partial<ReturnType<typeof useTaskStore.getState>>);

    api.loadPage.mockResolvedValue({ nodes: [], edges: [], version: 5 });
    api.moveNodes.mockRejectedValue(
      Object.assign(new Error('版本冲突：页面已被其他设备修改'), {
        conflict: true,
        pageId: targetPage.id,
        serverVersion: 9,
      }),
    );

    await expect(
      useWorkspaceStore.getState().moveNodesToPage(['n-1'], { pageId: targetPage.id }),
    ).resolves.toBeNull();

    expect(loadPage).toHaveBeenCalledWith(sourcePage.id);
    expect(toast.error).toHaveBeenCalledWith(
      '移动节点失败',
      '页面已被其他设备修改，已重新加载最新数据，请重新执行刚才的操作',
    );
  });

  it('flush rejects page conflicts after reloading latest page data', async () => {
    api.savePage.mockRejectedValue(
      Object.assign(new Error('版本冲突：页面已被其他设备修改'), {
        conflict: true,
        serverVersion: 7,
      }),
    );
    api.loadPage.mockResolvedValue(makePageData(7));

    useTaskStore.setState({
      activePageId: 'p-1',
      pageVersion: 1,
      nodes: [],
      edges: [],
      loaded: true,
      backupDirty: false,
    });

    useTaskStore.getState().addTask({ title: 'local change' });

    await expect(useTaskStore.getState().flush()).rejects.toMatchObject({ conflict: true });
    expect(useTaskStore.getState().pageVersion).toBe(7);
    expect(useTaskStore.getState().nodes.map((node) => node.id)).toEqual(['node-from-server']);
    expect(useTaskStore.getState().backupDirty).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(
      '保存冲突',
      '页面已被其他设备修改，已重新加载最新数据，请重新执行刚才的操作',
    );
  });
});
