import { create } from 'zustand';
import { wouldCreateCycle, readyTasks, recommend } from '@todograph/core';
import type { Edge, PageData, Task, TaskStatus } from '@todograph/shared';
import { api } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { uid } from '@/lib/utils';
import { measureTextWidth, MAX_TITLE_LENGTH } from '@/lib/measureText';
import {
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
} from '@todograph/shared';
import { useHistoryStore } from './useHistoryStore';

interface TaskStore {
  /** 当前页的 pageId —— 供 scheduleSave/flush 使用。null 表示未加载任何页。 */
  activePageId: string | null;
  /** 乐观锁版本号：loadPage 时从服务端获取，保存时带上，用于检测多设备冲突。 */
  pageVersion: number;
  nodes: Task[];
  edges: Edge[];
  loaded: boolean;

  /**
   * 图视口中心（世界坐标系）。GraphView 在初始化 / viewport 变动时
   * 通过 setViewportCenter 写入；列表里新建任务时读取用于放置新节点。
   * 未设置时 addTask 会回落到随机位置。
   */
  viewportCenter: { x: number; y: number } | null;
  setViewportCenter: (p: { x: number; y: number } | null) => void;

  // ---- lifecycle ----
  /** 加载（或切换到）指定页面；会把之前页面的 nodes/edges 整体替换。 */
  loadPage: (pageId: string) => Promise<void>;
  /** 立即把 pending 的保存写出去 —— 切页/卸载前调用。 */
  flush: () => Promise<void>;

  // ---- mutators ----
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

  // ---- hierarchy ----
  /**
   * 把 childId 归入 parentId 下（parentId === null 表示解除归属到顶层）。
   * positionHint 提供时，直接用作 child 在新父下的相对坐标，跳过 world→local 转换。
   */
  setParent: (
    childId: string,
    parentId: string | null,
    positionHint?: { x: number; y: number },
  ) => boolean;
  /**
   * 让节点"脱出一层" —— 挂到当前父的父上；若当前父已经是顶层，则直接变顶层。
   * 区别于 setParent(id, null)：后者语义是"回到顶层"（ListView drop-blank 用）。
   * 本方法给 GraphView 的 ungroup 手势用，三层嵌套下才有意义。
   */
  ascendOneLevel: (childId: string) => boolean;
  /** 把一批子任务合并到一个新父任务下；若 existingParentId 给出则复用它，否则创建新父。 */
  groupTasks: (
    childIds: string[],
    opts?: { title?: string; existingParentId?: string },
  ) => string | null;
  /**
   * 归一化某个父节点下的子坐标：若有子节点出现负相对坐标，
   * 把父节点左/上移 |min|，所有子节点同步右/下移 |min|，
   * 视觉上保持不变但消除负值（便于父框正确包围）。
   */
  normalizeGroupBounds: (parentId: string) => boolean;

  // ---- derived ----
  getGraph: () => PageData;
  getReadySet: () => Set<string>;
  getRecommended: () => Task | null;

  // ---- undo/redo ----
  /** 回滚到最后一次 push 的快照；返回是否真正发生回滚。 */
  undo: () => boolean;
  /** 重新应用 redo 栈顶的快照；返回是否真正发生前进。 */
  redo: () => boolean;

  // ---- auto-backup ----
  /** 自上次备份以来是否有新的 mutation。 */
  backupDirty: boolean;
  /** 标记备份已完成（清空 dirty 标记）。 */
  markBackupDone: () => void;
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
  const depthById = new Map<string, number>();
  for (const startId of index.byId.keys()) {
    if (depthById.has(startId)) continue;

    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let cur: string | undefined = startId;
    let baseDepth: number | null = null;
    let cycleStart = -1;

    while (cur) {
      const cached = depthById.get(cur);
      if (cached !== undefined) {
        baseDepth = cached;
        break;
      }
      const seenIndex = pathIndex.get(cur);
      if (seenIndex !== undefined) {
        cycleStart = seenIndex;
        break;
      }
      pathIndex.set(cur, path.length);
      path.push(cur);
      cur = index.byId.get(cur)?.parentId;
    }

    if (cycleStart >= 0) {
      const cycleDepth = path.length - cycleStart;
      for (let i = cycleStart; i < path.length; i++) {
        depthById.set(path[i]!, cycleDepth);
      }
      let nextDepth = cycleDepth;
      for (let i = cycleStart - 1; i >= 0; i--) {
        nextDepth += 1;
        depthById.set(path[i]!, nextDepth);
      }
      continue;
    }

    let nextDepth = baseDepth ?? -1;
    for (let i = path.length - 1; i >= 0; i--) {
      nextDepth += 1;
      depthById.set(path[i]!, nextDepth);
    }
  }
  return depthById;
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
  // 挂上后 child 的深度 = parentDepth + 1；整棵子树最深 = (parentDepth + 1) + childHeight
  // 层数（1-based）= 最深深度 + 1 ≤ MAX_HIERARCHY_DEPTH
  return parentDepth + 1 + childHeight + 1 > MAX_HIERARCHY_DEPTH;
}

function collectSubtreeHeights(index: HierarchyIndex): Map<string, number> {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const childId of index.childIdsByParentId.get(id) ?? []) {
      const height = 1 + walk(childId);
      if (height > best) best = height;
    }
    visiting.delete(id);
    memo.set(id, best);
    return best;
  };

  for (const startId of index.byId.keys()) walk(startId);
  return memo;
}

export function buildHierarchyMetrics(nodes: Task[]): HierarchyMetrics {
  const index = buildHierarchyIndex(nodes);
  const depthById = collectDepths(index);
  const subtreeHeightById = collectSubtreeHeights(index);
  return {
    ...index,
    depthById,
    subtreeHeightById,
  };
}

/** 判断把 childId 的父设为 newParentId 是否会形成父子环。 */
function wouldCreateParentCycle(nodes: Task[], childId: string, newParentId: string): boolean {
  return wouldCreateParentCycleFromIndex(buildHierarchyIndex(nodes), childId, newParentId);
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
export const MAX_HIERARCHY_DEPTH = 3;

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

/**
 * 纯函数：把 parent 下子节点的相对坐标归一化为"最左子节点贴 GROUP_PADDING_X、
 * 最上子节点贴 GROUP_PADDING_Y"。父节点世界坐标同步调整（+delta），
 * 子节点相对坐标同步调整（-delta），保证视觉位置不变。
 *
 * - 若父不存在 / 父没有子，原样返回。
 * - 若无需调整（delta=0）也原样返回同一个数组引用（便于 store 短路）。
 * - 不修改输入，返回新的 nodes 数组。
 *
 * Bug3 修复：老 normalizeGroupBounds 只在 minX<0 时触发，会留出一大片左侧空白。
 * 现在不论方向，都把左内边距吸附到 GROUP_PADDING_X。
 */
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

/**
 * 为避免循环依赖（useTaskStore ↔ useWorkspaceStore），用一个懒引用来拿
 * invalidateAllTasks；初始化时 workspace store 主动把自己的 invalidate
 * 方法挂进来。
 */
let invalidateAllTasks: (() => void) | null = null;
export function registerAllTasksInvalidator(fn: () => void): void {
  invalidateAllTasks = fn;
}

/**
 * 所有写操作都会调用 scheduleSave 进行防抖持久化。
 * 派生信息（ready / recommended）通过 getter 实时计算，避免重复的 state。
 *
 * 保存路径：保存的是"当前 activePageId 对应的 PageData"。
 * 切页时 loadPage 会先 flush 再替换。
 */
export const useTaskStore = create<TaskStore>((set, get) => {
  // 手写防抖：用 timer + pendingPageId，切页 flush 时能立即写出
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPageId: string | null = null;

  // 页面轮询：检测外部修改（MCP/其他设备）后自动刷新
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  };
  const startPolling = (pageId: string) => {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const g = await api.loadPage(pageId);
        const { activePageId, pageVersion } = get();
        // 只在页面未切换且版本变更时刷新
        if (g.version !== pageVersion && activePageId === pageId) {
          set({ nodes: g.nodes, edges: g.edges, pageVersion: g.version ?? 0, backupDirty: false });
          useHistoryStore.getState().clear();
        }
      } catch {
        // 静默：网络波动不打扰用户
      }
    }, 5000);
  };

  const doSave = async (opts?: { propagateError?: boolean }): Promise<void> => {
    if (!pendingPageId) return;
    const pid = pendingPageId;
    pendingPageId = null;
    const { nodes, edges, pageVersion } = get();
    try {
      const { version: newVersion } = await api.savePage(pid, { nodes, edges }, pageVersion);
      set({ pageVersion: newVersion });
      invalidateAllTasks?.();
    } catch (err) {
      const e = err as Error & { conflict?: boolean; serverVersion?: number };
      if (e.conflict) {
        const message = opts?.propagateError
          ? '页面已被其他设备修改，已重新加载最新数据，请重新执行刚才的操作'
          : '页面已被其他设备修改，已重新加载最新数据';
        toast.error('保存冲突', message);
        try {
          const g = await api.loadPage(pid);
          set({
            activePageId: pid,
            nodes: g.nodes,
            edges: g.edges,
            pageVersion: e.serverVersion ?? g.version ?? 0,
            loaded: true,
            backupDirty: false,
          });
          useHistoryStore.getState().clear();
        } catch (_reloadErr) {
          toast.error('重新加载失败', '请刷新页面');
        }
        if (opts?.propagateError) throw e;
        return;
      }
      toast.error('保存失败', String(e.message ?? err));
      if (opts?.propagateError) throw e;
    }
  };

  const scheduleSave = () => {
    const active = get().activePageId;
    if (!active) return;
    pendingPageId = active;
    set({ backupDirty: true });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void doSave();
    }, 250);
  };

  const flush = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (pendingPageId) await doSave({ propagateError: true });
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

  return {
    activePageId: null,
    pageVersion: 0,
    nodes: [],
    edges: [],
    loaded: false,
    viewportCenter: null,
    backupDirty: false,

    setViewportCenter: (p) => set({ viewportCenter: p }),

    loadPage: async (pageId) => {
      // 切页前若有 pending 写出，flush 掉（scheduleSave 用的是切之前的 activePageId）
      await flush();
      try {
        const g = await api.loadPage(pageId);
        set({
          activePageId: pageId,
          pageVersion: g.version ?? 0,
          nodes: g.nodes,
          edges: g.edges,
          loaded: true,
          backupDirty: false,
        });
        // 页面切换 —— 历史栈清空
        useHistoryStore.getState().clear();
        startPolling(pageId);
      } catch (err) {
        toast.error('加载页面失败', String((err as Error).message));
        // 维持 loaded=true 避免卡在加载态
        set({ loaded: true });
        throw err;
      }
    },

    flush,

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
      set((s) => ({ nodes: [...s.nodes, t] }));
      scheduleSave();
      return t;
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
        return changed ? { nodes: next } : s;
      });
      scheduleSave();
    },

    updateTasksBulk: (patches) => {
      if (patches.length === 0) return;
      pushPre();
      const byId = new Map(patches.map((p) => [p.id, p.patch]));
      set((s) => ({
        nodes: s.nodes.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, ...p } : n;
        }),
      }));
      scheduleSave();
    },

    deleteTask: (id) => {
      pushPre();
      set((s) => {
        // 删除节点前：如果它是父节点，要把子节点的相对坐标加回父节点坐标
        const deleted = s.nodes.find((n) => n.id === id);
        const px = deleted?.x ?? 0;
        const py = deleted?.y ?? 0;
        return {
          nodes: s.nodes
            .filter((n) => n.id !== id)
            .map((n) =>
              n.parentId === id
                ? { ...n, parentId: undefined, x: (n.x ?? 0) + px, y: (n.y ?? 0) + py }
                : n,
            ),
          edges: s.edges.filter((e) => e.from !== id && e.to !== id),
        };
      });
      scheduleSave();
    },

    toggleStatus: (id) => {
      const s = get();
      const node = s.nodes.find((n) => n.id === id);
      if (!node) return false;
      // 如果要切换到 done，且该节点有未完成的子节点 → 阻止
      if (node.status !== 'done') {
        const hasUndoneChild = s.nodes.some((n) => n.parentId === id && n.status !== 'done');
        if (hasUndoneChild) return false;
      }
      pushPre();
      set((s2) => ({
        nodes: s2.nodes.map((n) => (n.id === id ? { ...n, status: nextStatus[n.status] } : n)),
      }));
      scheduleSave();
      return true;
    },

    setStatus: (id, status) => {
      pushPre();
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, status } : n)),
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
      set((s) => ({ edges: [...s.edges, { from, to }] }));
      scheduleSave();
      return true;
    },

    removeEdge: (from, to) => {
      pushPre();
      set((s) => ({ edges: s.edges.filter((e) => !(e.from === from && e.to === to)) }));
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

      set({ nodes: [...state.nodes, newTask], edges });
      scheduleSave();
      return newTask;
    },

    setParent: (childId, parentId, positionHint) => {
      const state = get();
      if (parentId && wouldCreateParentCycle(state.nodes, childId, parentId)) {
        toast.error('父子关系会形成循环', '已阻止');
        return false;
      }
      if (wouldExceedMaxDepth(state.nodes, childId, parentId)) {
        toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
        return false;
      }
      const child = state.nodes.find((n) => n.id === childId);
      if (!child) return false;
      pushPre();
      const newParent = parentId ? state.nodes.find((n) => n.id === parentId) : undefined;
      const oldParent = child.parentId
        ? state.nodes.find((n) => n.id === child.parentId)
        : undefined;
      // 父子坐标系转换：store 保存的坐标总是相对 parentId（若有）。
      // 转换规则：先把 child 变成世界坐标，再减去新父的世界坐标得到新的相对坐标。
      // positionHint 会覆盖自动计算——用于拖拽合并时把子节点放到整齐位置。
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
      // 挂入新父后若出现负相对坐标 —— 立刻归一化，确保父框能包围
      if (parentId) {
        get().normalizeGroupBounds(parentId);
      }
      scheduleSave();
      return true;
    },

    ascendOneLevel: (childId) => {
      const state = get();
      const child = state.nodes.find((n) => n.id === childId);
      if (!child || !child.parentId) return false;
      const parent = state.nodes.find((n) => n.id === child.parentId);
      // 父已是顶层 → 直接脱到顶层；否则挂到 grandparent
      const targetParentId = parent?.parentId ?? null;
      return get().setParent(childId, targetParentId);
    },

    groupTasks: (childIds, opts) => {
      if (childIds.length === 0) return null;
      const state = get();
      const index = buildHierarchyIndex(state.nodes);
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const targets = childIds.filter((id) => byId.has(id));
      if (targets.length === 0) return null;

      // 若复用已有父：按 setParent 规则逐个校验（循环 + 深度）
      // 若创建新父：新父是顶层（parentDepth=0），每个 child 挂上后深度 = 1 + childHeight
      //             超出 MAX_HIERARCHY_DEPTH 的直接拒绝整次操作
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
          // 新父是顶层（depth=0），挂上后该子的深度 = 1；子树最深 = 1 + childHeight
          // 层数 = 1 + childHeight + 1 ≤ MAX
          if (1 + subtreeHeightFromIndex(index, cid) + 1 > MAX_HIERARCHY_DEPTH) {
            toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
            return null;
          }
        }
      }

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
      const nextIndex = buildHierarchyIndex(isNewParent ? [...state.nodes, parentTask] : state.nodes);

      pushPre();
      set((s) => {
        let next = s.nodes;
        if (isNewParent) next = [...next, parentTask];
        next = next.map((n) => {
          if (!targetSet.has(n.id)) return n;
          if (!isNewParent && wouldCreateParentCycleFromIndex(nextIndex, n.id, parentId)) return n;
          let worldX = n.x ?? 0;
          let worldY = n.y ?? 0;
          if (n.parentId) {
            const oldParent = next.find((p) => p.id === n.parentId);
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
        return { nodes: next };
      });
      scheduleSave();
      return parentId;
    },

    normalizeGroupBounds: (parentId) => {
      const before = get().nodes;
      const after = pureNormalizeGroupBounds(before, parentId);
      if (after === before) return false;
      set({ nodes: after });
      scheduleSave();
      return true;
    },

    getGraph: () => ({ nodes: get().nodes, edges: get().edges }),

    getReadySet: () => new Set(readyTasks(get().getGraph()).map((n) => n.id)),

    getRecommended: () => recommend(get().getGraph()),

    undo: () => {
      const prev = useHistoryStore.getState().undo();
      if (!prev) return false;
      const current = { nodes: get().nodes, edges: get().edges };
      useHistoryStore.getState().pushToRedo(current);
      set({ nodes: prev.nodes, edges: prev.edges });
      scheduleSave();
      return true;
    },

    redo: () => {
      const next = useHistoryStore.getState().redo();
      if (!next) return false;
      const current = { nodes: get().nodes, edges: get().edges };
      useHistoryStore.getState().pushToUndo(current);
      set({ nodes: next.nodes, edges: next.edges });
      scheduleSave();
      return true;
    },

    markBackupDone: () => set({ backupDirty: false }),
  };
});
