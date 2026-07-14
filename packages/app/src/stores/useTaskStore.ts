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
import { emitAllTasksInvalidated } from './workspaceEvents';
interface TaskStore {
  /** 当前页的 pageId —— 供 scheduleSave/flush 使用。null 表示未加载任何页。 */
  activePageId: string | null;
  /** 乐观锁版本号：loadPage 时从服务端获取，保存时带上，用于检测多设备冲突。 */
  pageVersion: number;
  nodes: Task[];
  edges: Edge[];
  /** Only changes when ids, statuses, or dependency edges change. */
  recommendationRevision: number;
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
  addTask: (input: {
    title: string;
    x?: number;
    y?: number;
    parentId?: string;
  }) => Task;
  updateTask: (id: string, patch: Partial<Omit<Task, 'id'>>) => void;
  deleteTask: (id: string) => void;
  /** 批量更新坐标等，避免每次 set 都触发订阅者重渲染。 */
  updateTasksBulk: (patches: Array<{ id: string; patch: Partial<Omit<Task, 'id'>> }>) => void;
  toggleStatus: (id: string) => boolean;
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
    patch.title !== undefined ||
    Object.prototype.hasOwnProperty.call(patch, 'parentId');
}

export const useTaskStore = create<TaskStore>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPageId: string | null = null;
  let saveDrain: Promise<void> | null = null;
  const hasPendingSave = () => saveTimer !== null || pendingPageId !== null || saveDrain !== null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
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
          set((state) => ({
            nodes: repaired,
            edges: g.edges,
            pageVersion: g.version ?? 0,
            backupDirty: false,
            recommendationRevision: state.recommendationRevision + 1,
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
  const saveOnce = async (): Promise<void> => {
    if (!pendingPageId) return;
    const pid = pendingPageId;
    const generation = getApiSessionGeneration();
    pendingPageId = null;
    const { activePageId, nodes, edges, pageVersion } = get();
    if (activePageId !== pid) return;
    try {
      const { version: newVersion } = await api.savePage(pid, { nodes, edges }, pageVersion);
      if (generation !== getApiSessionGeneration()) return;
      set({ pageVersion: newVersion });
      emitAllTasksInvalidated();
    } catch (err) {
      if (generation !== getApiSessionGeneration()) return;
      const e = err as Error & { conflict?: boolean; serverVersion?: number };
      if (e.conflict) {
        pendingPageId = null;
        const message = '页面已被其他设备修改，已重新加载最新数据，请重新执行刚才的操作';
        toast.error('保存冲突', message);
        try {
          const g = await api.loadPage(pid);
          if (generation !== getApiSessionGeneration()) return;
          applyPage(pid, { ...g, version: e.serverVersion ?? g.version });
        } catch (_reloadErr) {
          toast.error('重新加载失败', '请刷新页面');
        }
        throw e;
      }
      if (get().activePageId === pid) pendingPageId = pid;
      toast.error('保存失败', String(e.message ?? err));
      throw e;
    }
  };
  const drainSaves = (): Promise<void> => {
    if (saveDrain) return saveDrain;
    const drain = (async () => { while (pendingPageId) await saveOnce(); })();
    saveDrain = drain.finally(() => { saveDrain = null; });
    return saveDrain;
  };
  const scheduleSave = () => {
    const active = get().activePageId;
    if (!active) return;
    pendingPageId = active;
    set((state) => ({ backupDirty: true, backupRevision: state.backupRevision + 1 }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void drainSaves().catch(() => {});
    }, 250);
  };
  const flush = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (saveDrain) await saveDrain;
    if (pendingPageId) await drainSaves();
  };
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
    const repaired = repairGeometry(data.nodes);
    set((state) => ({
      activePageId: pageId,
      pageVersion: data.version ?? 0,
      nodes: repaired,
      edges: data.edges,
      loaded: true,
      viewportCenter: null,
      backupDirty: false,
      recommendationRevision: state.recommendationRevision + 1,
    }));
    useHistoryStore.getState().clear();
    if (repaired !== data.nodes) scheduleSave();
  };
  const cancelScheduledSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingPageId = null;
  };
  const resetSession = () => {
    stopPolling();
    cancelScheduledSave();
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
    });
  };
  return {
    activePageId: null,
    pageVersion: 0,
    nodes: [],
    edges: [],
    recommendationRevision: 0,
    loaded: false,
    viewportCenter: null,
    backupDirty: false,
    backupRevision: 0,
    setViewportCenter: (p) => set({ viewportCenter: p }),
    loadPage: async (pageId) => {
      const generation = getApiSessionGeneration();
      await flush();
      if (generation !== getApiSessionGeneration()) return;
      try {
        const g = await api.loadPage(pageId);
        if (generation !== getApiSessionGeneration()) return;
        applyPage(pageId, g);
        startPolling(pageId);
      } catch (err) {
        if (generation !== getApiSessionGeneration()) return;
        toast.error('加载页面失败', String((err as Error).message));
        set({ loaded: true });
        throw err;
      }
    },
    replaceLoadedPage: (pageId, data) => {
      cancelScheduledSave();
      applyPage(pageId, data);
      startPolling(pageId);
    },
    flush,
    hasPendingSave,
    resetSession,
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
        };
      });
      scheduleSave();
    },
    deleteTask: (id) => {
      pushPre();
      set((s) => {
        const deleted = s.nodes.find((n) => n.id === id);
        const px = deleted?.x ?? 0;
        const py = deleted?.y ?? 0;
        const nodes = s.nodes
          .filter((n) => n.id !== id)
          .map((n) =>
            n.parentId === id
              ? { ...n, parentId: undefined, x: (n.x ?? 0) + px, y: (n.y ?? 0) + py }
              : n,
          );
        const changedIds = s.nodes
          .filter((node) => node.parentId === id)
          .map((node) => node.id);
        return {
          nodes: repairGeometry(nodes, changedIds),
          edges: s.edges.filter((e) => e.from !== id && e.to !== id),
          recommendationRevision: s.recommendationRevision + 1,
        };
      });
      scheduleSave();
    },
    toggleStatus: (id) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === id);
      if (!node) return false;
      if (node.status !== 'done') {
        const hasUndoneChild = s.nodes.some((n) => n.parentId === id && n.status !== 'done');
        if (hasUndoneChild) return false;
      }
      pushPre();
      set((s2) => ({
        nodes: s2.nodes.map((n) => (n.id === id ? { ...n, status: nextStatus[n.status] } : n)),
        recommendationRevision: s2.recommendationRevision + 1,
      }));
      scheduleSave();
      return true;
    },
    setStatus: (id, status) => {
      pushPre();
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, status } : n)),
        recommendationRevision: s.recommendationRevision + 1,
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
      }));
      scheduleSave();
      return true;
    },
    removeEdge: (from, to) => {
      pushPre();
      set((s) => ({
        edges: s.edges.filter((e) => !(e.from === from && e.to === to)),
        recommendationRevision: s.recommendationRevision + 1,
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
      const newParent = parentId ? idx.byId.get(parentId) : undefined;
      const oldParent = child.parentId
        ? idx.byId.get(child.parentId)
        : undefined;
      let patch: Partial<Task> = { parentId: parentId ?? undefined };
      const cx = child.x ?? 0;
      const cy = child.y ?? 0;
      if (positionHint) {
        patch = { ...patch, x: positionHint.x, y: positionHint.y };
      } else if (oldParent && !newParent) {
        patch = { ...patch, x: cx + (oldParent.x ?? 0), y: cy + (oldParent.y ?? 0) };
      } else if (!oldParent && newParent) {
        patch = { ...patch, x: cx - (newParent.x ?? 0), y: cy - (newParent.y ?? 0) };
      } else if (oldParent && newParent && oldParent.id !== newParent.id) {
        const worldX = cx + (oldParent.x ?? 0);
        const worldY = cy + (oldParent.y ?? 0);
        patch = { ...patch, x: worldX - (newParent.x ?? 0), y: worldY - (newParent.y ?? 0) };
      }
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === childId ? { ...n, ...patch } : n)),
      }));
      if (parentId) {
        get().normalizeGroupBounds(parentId, [childId]);
      } else {
        set((s) => ({ nodes: repairGeometry(s.nodes, [childId]) }));
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
        const n = byId.get(id)!;
        if (!n.parentId) return { x: n.x ?? 0, y: n.y ?? 0 };
        const p = byId.get(n.parentId);
        return { x: (n.x ?? 0) + (p?.x ?? 0), y: (n.y ?? 0) + (p?.y ?? 0) };
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
      const parentX = parentTask.x ?? 0;
      const parentY = parentTask.y ?? 0;
      const targetSet = new Set(targets);
      pushPre();
      set((s) => {
        let next = s.nodes;
        if (isNewParent) next = [...next, parentTask];
        next = next.map((n) => {
          if (!targetSet.has(n.id)) return n;
          if (!isNewParent && wouldCreateParentCycleFromIndex(index, n.id, parentId)) return n;
          let worldX = n.x ?? 0;
          let worldY = n.y ?? 0;
          if (n.parentId) {
            const oldParent = index.byId.get(n.parentId);
            if (oldParent) {
              worldX += oldParent.x ?? 0;
              worldY += oldParent.y ?? 0;
            }
          }
          return {
            ...n,
            parentId,
            x: worldX - parentX,
            y: worldY - parentY,
          };
        });
        return {
          nodes: repairGeometry(next, [parentId, ...targets], [parentId, ...targets]),
          recommendationRevision: isNewParent
            ? s.recommendationRevision + 1
            : s.recommendationRevision,
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
      }));
      scheduleSave();
      return true;
    },
    markBackupDone: (pageId, revision) => set((state) => state.activePageId === pageId
      && state.backupRevision === revision ? { backupDirty: false } : state),
  };
});
