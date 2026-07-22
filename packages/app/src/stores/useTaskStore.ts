import { create } from 'zustand';
import { wouldCreateCycle } from '@todograph/core';
import type { Edge, PageData, Task, TaskStatus } from '@todograph/shared';
import { api, getApiSessionGeneration } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { uid } from '@/lib/utils';
import { measureTextWidth, MAX_TITLE_LENGTH } from '@/lib/measureText';
import {
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  MAX_HIERARCHY_DEPTH,
  resolveNodeOverlaps,
} from '@todograph/shared';
import { useHistoryStore } from './useHistoryStore';
import { emitAllTasksInvalidated, emitWorkspaceMetaUpdated } from './workspaceEvents';
import { createTaskPersistenceCoordinator } from './taskPersistenceCoordinator';
import {
  clearTaskDraft,
  clearTaskDraftIfMatching,
  loadTaskDraft,
  saveTaskDraft,
} from './taskDraftStorage';
interface TaskStore {
  /** 当前页的 pageId —— 供 scheduleSave/flush 使用。null 表示未加载任何页。 */
  activePageId: string | null;
  /** 乐观锁版本号：loadPage 时从服务端获取，保存时带上，用于检测多设备冲突。 */
  pageVersion: number;
  nodes: Task[];
  edges: Edge[];
  /** Only changes when ids, statuses, or dependency edges change. */
  recommendationRevision: number;
  /** Only changes when fields used by the list projection change; coordinates are excluded. */
  listRevision: number;
  loaded: boolean;
  /**
   * 图视口中心（世界坐标系）。GraphView 在初始化 / viewport 变动时
   * 通过 setViewportCenter 写入；列表里新建任务时读取用于放置新节点。
   * 未设置时 addTask 会回落到随机位置。
   */
  viewportCenter: { x: number; y: number } | null;
  setViewportCenter: (p: { x: number; y: number } | null) => void;
  /** 加载（或切换到）指定页面；会把之前页面的 nodes/edges 整体替换。 */
  loadPage: (pageId: string) => Promise<void>;
  /** 用服务端返回的数据替换当前页，不先 flush pending local edits。 */
  replaceLoadedPage: (pageId: string, data: PageData) => void;
  /** 立即把 pending 的保存写出去 —— 切页/卸载前调用。 */
  flush: () => Promise<void>;
  hasPendingSave: () => boolean;
  /** 退出登录或切换账号时停止后台任务并清空全部用户数据。 */
  resetSession: () => void;
  setSessionUser: (userId: string) => void;
  addTask: (input: {
    title: string;
    x?: number;
    y?: number;
    parentId?: string;
  }) => Task;
  updateTask: (id: string, patch: Partial<Omit<Task, 'id'>>) => void;
  deleteTask: (id: string) => void;
  deleteTasks: (ids: readonly string[]) => void;
  detachTasks: (ids: readonly string[]) => void;
  /** 批量更新坐标等，避免每次 set 都触发订阅者重渲染。 */
  updateTasksBulk: (patches: Array<{ id: string; patch: Partial<Omit<Task, 'id'>> }>) => void;
  /** 同步浏览器实测尺寸；属于派生几何，不进入撤销历史。 */
  syncMeasuredSizes: (measurements: Array<{ id: string; width: number; height: number }>) => void;
  toggleStatus: (id: string) => boolean;
  completeTask: (id: string) => boolean;
  setStatus: (id: string, status: TaskStatus) => void;
  addEdge: (from: string, to: string) => boolean;
  removeEdge: (from: string, to: string) => void;
  insertBetween: (aId: string, bId: string, title: string) => Task | null;
  /**
   * 把 childId 归入 parentId 下（parentId === null 表示解除归属到顶层）。
   * positionHint 提供时，直接用作 child 在新父下的相对坐标，跳过 world→local 转换。
   */
  setParent: (
    childId: string,
    parentId: string | null,
    positionHint?: { x: number; y: number },
  ) => boolean;
  /** 按列表视觉顺序把任务放到同级锚点之前或之后，不改变父子关系。 */
  reorderTask: (taskId: string, anchorId: string, position: 'before' | 'after', storageOrder: 'forward' | 'reverse') => boolean;
  /** 原子地改为锚点的同级任务并放入指定列表插槽。 */
  moveTaskToSibling: (taskId: string, anchorId: string, position: 'before' | 'after', storageOrder: 'forward' | 'reverse') => boolean;
  ascendOneLevel: (childId: string) => boolean;
  /** 把一批子任务合并到一个新父任务下；若 existingParentId 给出则复用它，否则创建新父。 */
  groupTasks: (
    childIds: string[],
    opts?: { title?: string; existingParentId?: string },
  ) => string | null;
  normalizeGroupBounds: (parentId: string, changedIds?: readonly string[]) => boolean;
  /** 回滚到最后一次 push 的快照；返回是否真正发生回滚。 */
  undo: () => boolean;
  /** 重新应用 redo 栈顶的快照；返回是否真正发生前进。 */
  redo: () => boolean;
  /** 自上次备份以来是否有新的 mutation。 */
  backupDirty: boolean;
  /** mutation 单调版本，避免旧备份完成后清掉新修改的 dirty 标记。 */
  backupRevision: number;
  markBackupDone: (pageId: string, revision: number) => void;
}

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'done',
  done: 'todo',
};
function hasUndoneChild(nodes: readonly Task[], parentId: string): boolean {
  return nodes.some((node) => node.parentId === parentId && node.status !== 'done');
}
interface HierarchyIndex {
  byId: Map<string, Task>;
  childIdsByParentId: Map<string, string[]>;
}

export interface HierarchyMetrics extends HierarchyIndex {
  depthById: Map<string, number>;
  subtreeHeightById: Map<string, number>;
}

function buildHierarchyIndex(nodes: Task[]): HierarchyIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childIdsByParentId = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const arr = childIdsByParentId.get(n.parentId);
    if (arr) arr.push(n.id);
    else childIdsByParentId.set(n.parentId, [n.id]);
  }
  return { byId, childIdsByParentId };
}

function depthOfFromIndex(index: HierarchyIndex, id: string): number {
  let depth = 0;
  let cur = index.byId.get(id);
  const seen = new Set<string>();
  while (cur?.parentId) {
    if (seen.has(cur.id)) break; // 防御环
    seen.add(cur.id);
    cur = index.byId.get(cur.parentId);
    depth++;
  }
  return depth;
}

function worldPositionFromIndex(index: HierarchyIndex, id: string): { x: number; y: number } {
  let node = index.byId.get(id);
  let x = node?.x ?? 0;
  let y = node?.y ?? 0;
  const seen = new Set<string>([id]);
  while (node?.parentId && !seen.has(node.parentId)) {
    seen.add(node.parentId);
    node = index.byId.get(node.parentId);
    if (!node) break;
    x += node.x ?? 0;
    y += node.y ?? 0;
  }
  return { x, y };
}

function collectDepths(index: HierarchyIndex): Map<string, number> {
  return new Map([...index.byId.keys()].map((id) => [id, depthOfFromIndex(index, id)]));
}

function subtreeHeightFromIndex(index: HierarchyIndex, id: string): number {
  const walk = (root: string, seen = new Set<string>()): number => {
    if (seen.has(root)) return 0;
    seen.add(root);
    const childIds = index.childIdsByParentId.get(root);
    if (!childIds || childIds.length === 0) return 0;
    let best = 0;
    for (const childId of childIds) {
      const height = 1 + walk(childId, seen);
      if (height > best) best = height;
    }
    return best;
  };
  return walk(id);
}

function wouldExceedMaxDepthFromIndex(
  index: HierarchyIndex,
  childId: string,
  newParentId: string | null,
): boolean {
  if (!newParentId) return false;
  const parentDepth = depthOfFromIndex(index, newParentId); // 根=0 ...
  const childHeight = subtreeHeightFromIndex(index, childId); // 叶=0 ...
  return parentDepth + 1 + childHeight + 1 > MAX_HIERARCHY_DEPTH;
}

function collectSubtreeHeights(index: HierarchyIndex): Map<string, number> {
  return new Map(
    [...index.byId.keys()].map((id) => [id, subtreeHeightFromIndex(index, id)]),
  );
}

export function buildHierarchyMetrics(nodes: Task[]): HierarchyMetrics {
  const index = buildHierarchyIndex(nodes);
  return {
    ...index,
    depthById: collectDepths(index),
    subtreeHeightById: collectSubtreeHeights(index),
  };
}

function wouldCreateParentCycleFromIndex(
  index: HierarchyIndex,
  childId: string,
  newParentId: string,
): boolean {
  if (childId === newParentId) return true;
  let cur: string | undefined = newParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === childId) return true;
    if (seen.has(cur)) return true; // 防御已有环
    seen.add(cur);
    cur = index.byId.get(cur)?.parentId;
  }
  return false;
}

/** 树的最大深度（根 → 子 → 孙 = 3 层；叶子算一层）。 */
/** 节点到根的距离（根 = 0；其父 = 1；祖父 = 2）。 */
export function depthOf(nodes: Task[], id: string): number {
  return depthOfFromIndex(buildHierarchyIndex(nodes), id);
}

/** 以 id 为根的子树高度（叶 = 0；有直接子 = 1）。 */
export function subtreeHeight(nodes: Task[], id: string): number {
  return subtreeHeightFromIndex(buildHierarchyIndex(nodes), id);
}

/**
 * 把 childId 挂到 newParentId 下是否会让树深度超出上限。
 * 深度 = newParentId 的深度 + 1（child 自身）+ childId 的子树高度 + 1 ≤ MAX。
 * 传入 null 表示 child 要变成顶层 —— 永远不会超深度。
 */
export function wouldExceedMaxDepth(
  nodes: Task[],
  childId: string,
  newParentId: string | null,
): boolean {
  return wouldExceedMaxDepthFromIndex(buildHierarchyIndex(nodes), childId, newParentId);
}

export function pureNormalizeGroupBounds(nodes: Task[], parentId: string): Task[] {
  const parent = nodes.find((n) => n.id === parentId);
  if (!parent) return nodes;
  const children = nodes.filter((n) => n.parentId === parentId);
  if (children.length === 0) return nodes;
  let minX = Infinity;
  let minY = Infinity;
  for (const c of children) {
    if ((c.x ?? 0) < minX) minX = c.x ?? 0;
    if ((c.y ?? 0) < minY) minY = c.y ?? 0;
  }
  const dx = minX - GROUP_PADDING_X;
  const dy = minY - GROUP_PADDING_Y;
  if (dx === 0 && dy === 0) return nodes;
  return nodes.map((n) => {
    if (n.id === parentId) {
      return { ...n, x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy };
    }
    if (n.parentId === parentId) {
      return { ...n, x: (n.x ?? 0) - dx, y: (n.y ?? 0) - dy };
    }
    return n;
  });
}

function repairGeometry(
  nodes: Task[],
  changedIds?: readonly string[],
  pinnedIds: readonly string[] = changedIds ?? [],
): Task[] {
  return resolveNodeOverlaps(nodes, { changedIds, pinnedIds }).nodes;
}

function patchAffectsGeometry(patch: Partial<Task>): boolean {
  return patch.x !== undefined ||
    patch.y !== undefined ||
    patch.width !== undefined ||
    patch.height !== undefined ||
    patch.title !== undefined ||
    Object.prototype.hasOwnProperty.call(patch, 'parentId');
}

function patchAffectsList(patch: Partial<Task>): boolean {
  return patch.title !== undefined ||
    patch.status !== undefined ||
    patch.description !== undefined ||
    Object.prototype.hasOwnProperty.call(patch, 'parentId');
}

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
    addTask: ({ title, x, y, parentId }) => {
      pushPre();
      const safeTitle = (title || '未命名').slice(0, MAX_TITLE_LENGTH);
      const t: Task = {
        id: uid(),
        title: safeTitle,
        status: 'todo',
        x,
        y,
        width: measureTextWidth(safeTitle),
        ...(parentId ? { parentId } : {}),
      };
      set((s) => ({
        nodes: repairGeometry([...s.nodes, t], [t.id]),
        recommendationRevision: s.recommendationRevision + 1,
        listRevision: s.listRevision + 1,
      }));
      scheduleSave();
      return get().nodes.find((node) => node.id === t.id) ?? t;
    },
    updateTask: (id, patch) => {
      pushPre();
      set((s) => {
        let changed = false;
        const next = s.nodes.map((n) => {
          if (n.id !== id) return n;
          changed = true;
          const updated = { ...n, ...patch };
          if (patch.title !== undefined) {
            updated.title = patch.title.slice(0, MAX_TITLE_LENGTH);
            updated.width = measureTextWidth(updated.title);
            updated.height = undefined;
          }
          return updated;
        });
        return changed
          ? {
              nodes: patchAffectsGeometry(patch) ? repairGeometry(next, [id]) : next,
              recommendationRevision:
                patch.status === undefined
                  ? s.recommendationRevision
                  : s.recommendationRevision + 1,
              listRevision: patchAffectsList(patch) ? s.listRevision + 1 : s.listRevision,
            }
          : s;
      });
      scheduleSave();
    },
    updateTasksBulk: (patches) => {
      if (patches.length === 0) return;
      pushPre();
      const byId = new Map(patches.map((p) => [p.id, p.patch]));
      const affectsRecommendation = patches.some(({ patch }) => patch.status !== undefined);
      const affectsList = patches.some(({ patch }) => patchAffectsList(patch));
      const geometryIds = patches
        .filter(({ patch }) => patchAffectsGeometry(patch))
        .map(({ id }) => id);
      set((s) => {
        const next = s.nodes.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, ...p } : n;
        });
        return {
          nodes: geometryIds.length > 0 ? repairGeometry(next, geometryIds) : next,
          recommendationRevision: affectsRecommendation
            ? s.recommendationRevision + 1
            : s.recommendationRevision,
          listRevision: affectsList ? s.listRevision + 1 : s.listRevision,
        };
      });
      scheduleSave();
    },
    syncMeasuredSizes: (measurements) => {
      if (measurements.length === 0) return;
      const sizeById = new Map(measurements.map(({ id, width, height }) => [id, { width, height }]));
      let changed = false;
      set((state) => {
        const changedIds: string[] = [];
        const next = state.nodes.map((node) => {
          const size = sizeById.get(node.id);
          if (!size || (node.width === size.width && node.height === size.height)) return node;
          changed = true;
          changedIds.push(node.id);
          return { ...node, ...size };
        });
        if (!changed) return state;
        const allAtOrigin = next.length > 0 && next.every((node) => !node.x && !node.y);
        return {
          nodes: allAtOrigin ? next : repairGeometry(next, changedIds, changedIds),
        };
      });
      if (changed) scheduleSave();
    },
    deleteTask: (id) => get().deleteTasks([id]),
    deleteTasks: (ids) => {
      const state = get();
      const existingIds = new Set(state.nodes.map((node) => node.id));
      const deletedIds = new Set(ids.filter((id) => existingIds.has(id)));
      if (deletedIds.size === 0) return;
      pushPre();
      set((s) => {
        const index = buildHierarchyIndex(s.nodes);
        const releasedIds: string[] = [];
        const nodes = s.nodes
          .filter((node) => !deletedIds.has(node.id))
          .map((node) => {
            if (!node.parentId || !deletedIds.has(node.parentId)) return node;
            releasedIds.push(node.id);
            const world = worldPositionFromIndex(index, node.id);
            return { ...node, parentId: undefined, ...world };
          });
        return {
          nodes: repairGeometry(nodes, releasedIds),
          edges: s.edges.filter((edge) => !deletedIds.has(edge.from) && !deletedIds.has(edge.to)),
          recommendationRevision: s.recommendationRevision + 1,
          listRevision: s.listRevision + 1,
        };
      });
      scheduleSave();
    },
    detachTasks: (ids) => {
      const state = get();
      const index = buildHierarchyIndex(state.nodes);
      const detachedIds = new Set(ids.filter((id) => index.byId.get(id)?.parentId));
      if (detachedIds.size === 0) return;
      const worldById = new Map(
        [...detachedIds].map((id) => [id, worldPositionFromIndex(index, id)]),
      );
      pushPre();
      set((s) => ({
        nodes: repairGeometry(
          s.nodes.map((node) => detachedIds.has(node.id)
            ? { ...node, parentId: undefined, ...worldById.get(node.id)! }
            : node),
          [...detachedIds],
        ),
        listRevision: s.listRevision + 1,
      }));
      scheduleSave();
    },
    toggleStatus: (id) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === id);
      if (!node) return false;
      if (nextStatus[node.status] === 'done' && hasUndoneChild(s.nodes, id)) return false;
      pushPre();
      set((s2) => ({
        nodes: s2.nodes.map((n) => (n.id === id ? { ...n, status: nextStatus[n.status] } : n)),
        recommendationRevision: s2.recommendationRevision + 1,
        listRevision: s2.listRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    completeTask: (id) => {
      const state = get();
      const node = state.nodes.find((candidate) => candidate.id === id);
      if (!node || node.status === 'done' || hasUndoneChild(state.nodes, id)) return false;
      pushPre();
      set((current) => ({
        nodes: current.nodes.map((candidate) => (
          candidate.id === id ? { ...candidate, status: 'done' as const } : candidate
        )),
        recommendationRevision: current.recommendationRevision + 1,
        listRevision: current.listRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    setStatus: (id, status) => {
      pushPre();
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, status } : n)),
        recommendationRevision: s.recommendationRevision + 1,
        listRevision: s.listRevision + 1,
      }));
      scheduleSave();
    },
    addEdge: (from, to) => {
      if (from === to) {
        toast.error('不能依赖自己');
        return false;
      }
      const state = get();
      if (state.edges.some((e) => e.from === from && e.to === to)) return false;
      if (wouldCreateCycle({ nodes: state.nodes, edges: state.edges }, from, to)) {
        toast.error('会形成循环依赖', '已阻止');
        return false;
      }
      pushPre();
      set((s) => ({
        edges: [...s.edges, { from, to }],
        recommendationRevision: s.recommendationRevision + 1,
        listRevision: s.listRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    removeEdge: (from, to) => {
      pushPre();
      set((s) => ({
        edges: s.edges.filter((e) => !(e.from === from && e.to === to)),
        recommendationRevision: s.recommendationRevision + 1,
        listRevision: s.listRevision + 1,
      }));
      scheduleSave();
    },
    insertBetween: (aId, bId, title) => {
      pushPre();
      const state = get();
      const nodeA = state.nodes.find((n) => n.id === aId);
      const nodeB = state.nodes.find((n) => n.id === bId);
      if (!nodeA || !nodeB) return null;
      const mx = ((nodeA.x ?? 0) + (nodeB.x ?? 0)) / 2;
      const my = ((nodeA.y ?? 0) + (nodeB.y ?? 0)) / 2;
      const safeTitle = (title || '未命名').slice(0, MAX_TITLE_LENGTH);
      const newTask: Task = {
        id: uid(),
        title: safeTitle,
        status: 'todo',
        x: mx - 90,
        y: my - 28,
        width: measureTextWidth(safeTitle),
      };
      const abEdge = state.edges.find((e) => e.from === aId && e.to === bId);
      const baEdge = state.edges.find((e) => e.from === bId && e.to === aId);
      const edges = state.edges.filter(
        (e) => !(e.from === aId && e.to === bId) && !(e.from === bId && e.to === aId),
      );
      if (abEdge) {
        edges.push({ from: aId, to: newTask.id }, { from: newTask.id, to: bId });
      } else if (baEdge) {
        edges.push({ from: bId, to: newTask.id }, { from: newTask.id, to: aId });
      } else {
        const aLeft = nodeA.x ?? 0;
        const bLeft = nodeB.x ?? 0;
        if (aLeft <= bLeft) {
          edges.push({ from: aId, to: newTask.id }, { from: newTask.id, to: bId });
        } else {
          edges.push({ from: bId, to: newTask.id }, { from: newTask.id, to: aId });
        }
      }

      set({
        nodes: repairGeometry([...state.nodes, newTask], [newTask.id]),
        edges,
        recommendationRevision: state.recommendationRevision + 1,
        listRevision: state.listRevision + 1,
      });
      scheduleSave();
      return get().nodes.find((node) => node.id === newTask.id) ?? newTask;
    },
    setParent: (childId, parentId, positionHint) => {
      const state = get();
      const idx = buildHierarchyIndex(state.nodes);
      if (parentId && wouldCreateParentCycleFromIndex(idx, childId, parentId)) {
        toast.error('父子关系会形成循环', '已阻止');
        return false;
      }
      if (wouldExceedMaxDepthFromIndex(idx, childId, parentId)) {
        toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
        return false;
      }
      const child = idx.byId.get(childId);
      if (!child) return false;
      pushPre();
      let patch: Partial<Task> = { parentId: parentId ?? undefined };
      if (positionHint) {
        patch = { ...patch, x: positionHint.x, y: positionHint.y };
      } else {
        const world = child.x === undefined || child.y === undefined
          ? (state.viewportCenter ?? { x: 200, y: 100 })
          : worldPositionFromIndex(idx, childId);
        const parentWorld = parentId
          ? worldPositionFromIndex(idx, parentId)
          : { x: 0, y: 0 };
        patch = { ...patch, x: world.x - parentWorld.x, y: world.y - parentWorld.y };
      }
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === childId ? { ...n, ...patch } : n)),
        listRevision: s.listRevision + 1,
      }));
      if (parentId) {
        get().normalizeGroupBounds(parentId, [childId]);
      } else {
        set((s) => ({ nodes: repairGeometry(s.nodes, [childId]) }));
      }
      scheduleSave();
      return true;
    },
    reorderTask: (taskId, anchorId, position, storageOrder) => {
      const state = get();
      const task = state.nodes.find((node) => node.id === taskId);
      const anchor = state.nodes.find((node) => node.id === anchorId);
      if (!task || !anchor || task.id === anchor.id) return false;
      if ((task.parentId ?? null) !== (anchor.parentId ?? null)) return false;

      const siblings = state.nodes.filter(
        (node) => (node.parentId ?? null) === (task.parentId ?? null),
      );
      const withoutTask = siblings.filter((node) => node.id !== taskId);
      const anchorIndex = withoutTask.findIndex((node) => node.id === anchorId);
      if (anchorIndex < 0) return false;
      const storagePosition = storageOrder === 'forward'
        ? position
        : position === 'before' ? 'after' : 'before';
      const insertionIndex = anchorIndex + (storagePosition === 'after' ? 1 : 0);
      withoutTask.splice(insertionIndex, 0, task);
      if (siblings.every((node, index) => node.id === withoutTask[index]?.id)) return false;

      pushPre();
      let siblingIndex = 0;
      set((current) => ({
        nodes: current.nodes.map((node) => (
          (node.parentId ?? null) === (task.parentId ?? null)
            ? withoutTask[siblingIndex++]!
            : node
        )),
        listRevision: current.listRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    moveTaskToSibling: (taskId, anchorId, position, storageOrder) => {
      const state = get();
      const index = buildHierarchyIndex(state.nodes);
      const task = index.byId.get(taskId);
      const anchor = index.byId.get(anchorId);
      if (!task || !anchor || task.id === anchor.id) return false;

      const targetParentId = anchor.parentId ?? null;
      if (targetParentId && wouldCreateParentCycleFromIndex(index, taskId, targetParentId)) {
        toast.error('父子关系会形成循环', '已阻止');
        return false;
      }
      if (wouldExceedMaxDepthFromIndex(index, taskId, targetParentId)) {
        toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
        return false;
      }

      const storagePosition = storageOrder === 'forward'
        ? position
        : position === 'before' ? 'after' : 'before';
      const withoutTask = state.nodes.filter((node) => node.id !== taskId);
      const anchorIndex = withoutTask.findIndex((node) => node.id === anchorId);
      if (anchorIndex < 0) return false;
      const insertionIndex = anchorIndex + (storagePosition === 'after' ? 1 : 0);
      const sameParent = (task.parentId ?? null) === targetParentId;
      let movedTask = task;
      if (!sameParent) {
        const world = task.x === undefined || task.y === undefined
          ? (state.viewportCenter ?? { x: 200, y: 100 })
          : worldPositionFromIndex(index, taskId);
        const parentWorld = targetParentId
          ? worldPositionFromIndex(index, targetParentId)
          : { x: 0, y: 0 };
        movedTask = {
          ...task,
          parentId: targetParentId ?? undefined,
          x: world.x - parentWorld.x,
          y: world.y - parentWorld.y,
        };
      }
      withoutTask.splice(insertionIndex, 0, movedTask);
      if (state.nodes.every((node, nodeIndex) => node === withoutTask[nodeIndex])) return false;

      pushPre();
      set({
        nodes: withoutTask,
        listRevision: state.listRevision + 1,
      });
      if (targetParentId && !sameParent) {
        get().normalizeGroupBounds(targetParentId, [taskId]);
      } else if (!targetParentId && !sameParent) {
        set((current) => ({ nodes: repairGeometry(current.nodes, [taskId]) }));
      }
      scheduleSave();
      return true;
    },
    ascendOneLevel: (childId) => {
      const state = get();
      const child = state.nodes.find((n) => n.id === childId);
      if (!child || !child.parentId) return false;
      const parent = state.nodes.find((n) => n.id === child.parentId);
      const targetParentId = parent?.parentId ?? null;
      return get().setParent(childId, targetParentId);
    },
    groupTasks: (childIds, opts) => {
      if (childIds.length === 0) return null;
      const state = get();
      const index = buildHierarchyIndex(state.nodes);
      const targets = childIds.filter((id) => index.byId.has(id));
      if (targets.length === 0) return null;
      if (opts?.existingParentId) {
        for (const cid of targets) {
          if (wouldCreateParentCycleFromIndex(index, cid, opts.existingParentId)) {
            toast.error('父子关系会形成循环', '已阻止');
            return null;
          }
          if (wouldExceedMaxDepthFromIndex(index, cid, opts.existingParentId)) {
            toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
            return null;
          }
        }
      } else {
        for (const cid of targets) {
          if (1 + subtreeHeightFromIndex(index, cid) + 1 > MAX_HIERARCHY_DEPTH) {
            toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
            return null;
          }
        }
      }

      const byId = index.byId;
      const worldPosOf = (id: string): { x: number; y: number } => {
        return worldPositionFromIndex(index, id);
      };
      const existingParent = opts?.existingParentId ? byId.get(opts.existingParentId) : undefined;
      let parentTask: Task;
      let isNewParent = false;
      if (existingParent) {
        parentTask = existingParent;
      } else {
        const worlds = targets.map(worldPosOf);
        const minX = Math.min(...worlds.map((p) => p.x));
        const minY = Math.min(...worlds.map((p) => p.y));
        const GROUP_PAD_X = 28;
        const GROUP_PAD_Y = 44;
        parentTask = {
          id: uid(),
          title: opts?.title?.trim() || '新分组',
          status: 'todo',
          x: minX - GROUP_PAD_X,
          y: minY - GROUP_PAD_Y,
        };
        isNewParent = true;
      }

      const parentId = parentTask.id;
      const parentWorld = isNewParent
        ? { x: parentTask.x ?? 0, y: parentTask.y ?? 0 }
        : worldPositionFromIndex(index, parentTask.id);
      const targetSet = new Set(targets);
      const targetWorldById = new Map(targets.map((id) => [id, worldPositionFromIndex(index, id)]));
      pushPre();
      set((s) => {
        let next = s.nodes;
        if (isNewParent) next = [...next, parentTask];
        next = next.map((n) => {
          if (!targetSet.has(n.id)) return n;
          if (!isNewParent && wouldCreateParentCycleFromIndex(index, n.id, parentId)) return n;
          const world = targetWorldById.get(n.id)!;
          return {
            ...n,
            parentId,
            x: world.x - parentWorld.x,
            y: world.y - parentWorld.y,
          };
        });
        return {
          nodes: repairGeometry(next, [parentId, ...targets], [parentId, ...targets]),
          recommendationRevision: isNewParent
            ? s.recommendationRevision + 1
            : s.recommendationRevision,
          listRevision: s.listRevision + 1,
        };
      });
      scheduleSave();
      return parentId;
    },
    normalizeGroupBounds: (parentId, changedIds = [parentId]) => {
      const before = get().nodes;
      const normalized = pureNormalizeGroupBounds(before, parentId);
      const after = repairGeometry(normalized, changedIds);
      if (after === before) return false;
      set({ nodes: after });
      scheduleSave();
      return true;
    },
    undo: () => {
      const prev = useHistoryStore.getState().undo();
      if (!prev) return false;
      const current = { nodes: get().nodes, edges: get().edges };
      useHistoryStore.getState().pushToRedo(current);
      set((state) => ({
        nodes: repairGeometry(prev.nodes),
        edges: prev.edges,
        recommendationRevision: state.recommendationRevision + 1,
        listRevision: state.listRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    redo: () => {
      const next = useHistoryStore.getState().redo();
      if (!next) return false;
      const current = { nodes: get().nodes, edges: get().edges };
      useHistoryStore.getState().pushToUndo(current);
      set((state) => ({
        nodes: repairGeometry(next.nodes),
        edges: next.edges,
        recommendationRevision: state.recommendationRevision + 1,
        listRevision: state.listRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    markBackupDone: (pageId, revision) => set((state) => state.activePageId === pageId
      && state.backupRevision === revision ? { backupDirty: false } : state),
  };
});
