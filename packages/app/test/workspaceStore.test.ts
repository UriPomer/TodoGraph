import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meta, PageData, PageInfo } from '@todograph/shared';

const { api, toast, session } = vi.hoisted(() => ({
  session: { generation: 0 },
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

vi.mock('@/api/client', () => ({
  api,
  getApiSessionGeneration: () => session.generation,
  resetApiSession: () => { session.generation += 1; },
}));
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
    api.loadAllTasks.mockResolvedValue({ tasks: [] });
    session.generation = 0;
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useHistoryStore.getState().clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clears all user-owned state and history when the session resets', () => {
    useWorkspaceStore.setState({
      sessionUserId: 'u1',
      meta: makeMeta(1, 'p-1', [makePage('p-1', '第一页', 0)]),
      loaded: true,
      allTasks: [{
        id: 'all-1',
        title: '其他页任务',
        status: 'todo',
        _pageId: 'p-1',
        _pageTitle: '第一页',
        _ready: true,
      }],
    });
    useTaskStore.setState({
      activePageId: 'p-1',
      loaded: true,
      nodes: [{ id: 'private-1', title: '用户私有任务', status: 'todo' }],
    });
    useHistoryStore.getState().push({
      nodes: [{ id: 'private-1', title: '用户私有任务', status: 'todo' }],
      edges: [],
    });

    useWorkspaceStore.getState().resetSession();

    expect(useWorkspaceStore.getState()).toMatchObject({
      sessionUserId: null,
      meta: null,
      loaded: false,
      allTasks: [],
    });
    expect(useTaskStore.getState()).toMatchObject({
      activePageId: null,
      loaded: false,
      nodes: [],
      edges: [],
    });
    expect(useHistoryStore.getState()).toMatchObject({ undoStack: [], redoStack: [] });
  });

  it('does not restore stale workspace state when a session resets during page switching', async () => {
    let finishFlush!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => {
      finishFlush = resolve;
    }));
    useWorkspaceStore.setState({
      sessionUserId: 'u1',
      meta: makeMeta(1, 'p-1', [makePage('p-1', '第一页', 0), makePage('p-2', '第二页', 1)]),
      loaded: true,
    });
    useTaskStore.setState({
      activePageId: 'p-1',
      loaded: true,
      flush,
    } as Partial<ReturnType<typeof useTaskStore.getState>>);

    const switching = useWorkspaceStore.getState().switchPage('p-2');
    useWorkspaceStore.getState().resetSession();
    finishFlush();
    await switching;

    expect(useWorkspaceStore.getState()).toMatchObject({
      sessionUserId: null,
      meta: null,
      loaded: false,
    });
    expect(api.setActivePage).not.toHaveBeenCalled();
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

  it('keeps the local active page when meta polling observes another client switch', async () => {
    const first = makePage('p-1', '第一页', 0);
    const second = makePage('p-2', '第二页', 1);
    api.loadMeta
      .mockResolvedValueOnce(makeMeta(1, first.id, [first, second]))
      .mockResolvedValueOnce(makeMeta(2, second.id, [first, second]));
    api.loadPage.mockResolvedValue(makePageData(1));

    await useWorkspaceStore.getState().bootstrap('u1');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(useTaskStore.getState().activePageId).toBe(first.id);
    expect(useWorkspaceStore.getState().meta?.activePageId).toBe(first.id);
    expect(useWorkspaceStore.getState().meta?.revision).toBe(2);
  });

  it('reports when conflict recovery cannot refresh workspace state', async () => {
    const sourcePage = makePage('p-1', '第一页', 0);
    useWorkspaceStore.setState({ meta: makeMeta(1, sourcePage.id, [sourcePage]), loaded: true });
    api.createPage.mockRejectedValue(Object.assign(new Error('conflict'), { conflict: true }));
    api.loadMeta.mockRejectedValue(new Error('offline'));

    await useWorkspaceStore.getState().createPage('新页面');

    expect(toast.error).toHaveBeenCalledWith(
      '创建页面失败',
      '工作区已被其他设备修改，但刷新失败，请刷新页面后重试',
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

  it('serializes edits made while an earlier save is in flight', async () => {
    let finishFirst!: () => void;
    api.savePage
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = () => resolve({ version: 2 });
      }))
      .mockResolvedValueOnce({ version: 3 });
    useTaskStore.setState({
      activePageId: 'p-1', pageVersion: 1, nodes: [], edges: [], loaded: true,
    });

    useTaskStore.getState().addTask({ title: 'first' });
    await vi.advanceTimersByTimeAsync(250);
    useTaskStore.getState().addTask({ title: 'second' });
    await vi.advanceTimersByTimeAsync(250);
    finishFirst();
    await useTaskStore.getState().flush();

    expect(api.savePage).toHaveBeenCalledTimes(2);
    expect(api.savePage.mock.calls[1]?.[1].nodes.map((node: { title: string }) => node.title))
      .toEqual(['first', 'second']);
    expect(api.savePage.mock.calls[1]?.[2]).toBe(2);
    expect(useTaskStore.getState().pageVersion).toBe(3);
  });

  it('does not let polling overwrite a pending local edit', async () => {
    let finishSave!: () => void;
    api.savePage.mockImplementation(() => new Promise((resolve) => {
      finishSave = () => resolve({ version: 2 });
    }));
    api.loadPage
      .mockResolvedValueOnce(makePageData(1, 'initial'))
      .mockResolvedValueOnce(makePageData(2, 'remote'));
    await useTaskStore.getState().loadPage('p-1');
    useTaskStore.getState().addTask({ title: 'local' });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(api.loadPage).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().nodes.some((node) => node.title === 'local')).toBe(true);
    expect(useTaskStore.getState().backupDirty).toBe(true);
    finishSave();
    await useTaskStore.getState().flush();
  });

  it('drains the current page before deleting it', async () => {
    const first = makePage('p-1', '第一页', 0);
    const second = makePage('p-2', '第二页', 1);
    const nextMeta = makeMeta(2, second.id, [second]);
    const flush = vi.fn().mockResolvedValue(undefined);
    const loadPage = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({ meta: makeMeta(1, first.id, [first, second]), loaded: true });
    useTaskStore.setState({ activePageId: first.id, flush, loadPage } as Partial<ReturnType<typeof useTaskStore.getState>>);
    api.deletePage.mockResolvedValue(nextMeta);

    await useWorkspaceStore.getState().deletePage(first.id);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(api.deletePage.mock.invocationCallOrder[0]!);
    expect(loadPage).toHaveBeenCalledWith(second.id);
  });

});
