import { create } from 'zustand';
import { wouldCreateCycle, readyTasks, recommend } from '@todograph/core';
import type { Edge, PageData, Task, TaskStatus } from '@todograph/shared';
import { api } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { uid } from '@/lib/utils';

interface TaskStore {
  /** 当前页的 pageId —— 供 scheduleSave/flush 使用。null 表示未加载任何页。 */
  activePageId: string | null;
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
    priority?: number;
    x?: number;
    y?: number;
    parentId?: string;
  }) => Task;
  updateTask: (id: string, patch: Partial<Omit<Task, 'id'>>) => void;
  deleteTask: (id: string) => void;
  /** 批量更新坐标等，避免每次 set 都触发订阅者重渲染。 */
  updateTasksBulk: (patches: Array<{ id: string; patch: Partial<Omit<Task, 'id'>> }>) => void;
  toggleStatus: (id: string) => void;
  setStatus: (id: string, status: TaskStatus) => void;

  addEdge: (from: string, to: string) => boolean;
  removeEdge: (from: string, to: string) => void;

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
}

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'done',
  done: 'todo',
};

/** 判断把 childId 的父设为 newParentId 是否会形成父子环。 */
function wouldCreateParentCycle(nodes: Task[], childId: string, newParentId: string): boolean {
  if (childId === newParentId) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur: string | undefined = newParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === childId) return true;
    if (seen.has(cur)) return true; // 防御已有环
    seen.add(cur);
    cur = byId.get(cur)?.parentId;
  }
  return false;
}

/** 树的最大深度（根 → 子 → 孙 = 3 层；叶子算一层）。 */
export const MAX_HIERARCHY_DEPTH = 3;

/** 节点到根的距离（根 = 0；其父 = 1；祖父 = 2）。 */
export function depthOf(nodes: Task[], id: string): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let d = 0;
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur?.parentId) {
    if (seen.has(cur.id)) break; // 防御环
    seen.add(cur.id);
    cur = byId.get(cur.parentId);
    d++;
  }
  return d;
}

/** 以 id 为根的子树高度（叶 = 0；有直接子 = 1）。 */
export function subtreeHeight(nodes: Task[], id: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId) {
      const arr = childrenOf.get(n.parentId);
      if (arr) arr.push(n.id);
      else childrenOf.set(n.parentId, [n.id]);
    }
  }
  const walk = (root: string, seen = new Set<string>()): number => {
    if (seen.has(root)) return 0;
    seen.add(root);
    const cs = childrenOf.get(root);
    if (!cs || cs.length === 0) return 0;
    let best = 0;
    for (const c of cs) {
      const h = 1 + walk(c, seen);
      if (h > best) best = h;
    }
    return best;
  };
  return walk(id);
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
  if (!newParentId) return false;
  const parentDepth = depthOf(nodes, newParentId); // 根=0 ...
  const childHeight = subtreeHeight(nodes, childId); // 叶=0 ...
  // 挂上后 child 的深度 = parentDepth + 1；整棵子树最深 = (parentDepth + 1) + childHeight
  // 层数（1-based）= 最深深度 + 1 ≤ MAX_HIERARCHY_DEPTH
  return parentDepth + 1 + childHeight + 1 > MAX_HIERARCHY_DEPTH;
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

  const doSave = async (): Promise<void> => {
    if (!pendingPageId) return;
    const pid = pendingPageId;
    pendingPageId = null;
    const { nodes, edges } = get();
    try {
      await api.savePage(pid, { nodes, edges });
      invalidateAllTasks?.();
    } catch (err) {
      toast.error('保存失败', String((err as Error).message ?? err));
    }
  };

  const scheduleSave = () => {
    const active = get().activePageId;
    if (!active) return;
    pendingPageId = active;
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
    if (pendingPageId) await doSave();
  };

  return {
    activePageId: null,
    nodes: [],
    edges: [],
    loaded: false,
    viewportCenter: null,

    setViewportCenter: (p) => set({ viewportCenter: p }),

    loadPage: async (pageId) => {
      // 切页前若有 pending 写出，flush 掉（scheduleSave 用的是切之前的 activePageId）
      await flush();
      try {
        const g = await api.loadPage(pageId);
        set({
          activePageId: pageId,
          nodes: g.nodes,
          edges: g.edges,
          loaded: true,
        });
      } catch (err) {
        toast.error('加载页面失败', String((err as Error).message));
        // 维持 loaded=true 避免卡在加载态
        set({ loaded: true });
        throw err;
      }
    },

    flush,

    addTask: ({ title, priority = 2, x, y, parentId }) => {
      const t: Task = {
        id: uid(),
        title: title || '未命名',
        status: 'todo',
        priority,
        x,
        y,
        ...(parentId ? { parentId } : {}),
      };
      set((s) => ({ nodes: [...s.nodes, t] }));
      scheduleSave();
      return t;
    },

    updateTask: (id, patch) => {
      set((s) => {
        let changed = false;
        const next = s.nodes.map((n) => {
          if (n.id !== id) return n;
          changed = true;
          return { ...n, ...patch };
        });
        return changed ? { nodes: next } : s;
      });
      scheduleSave();
    },

    updateTasksBulk: (patches) => {
      if (patches.length === 0) return;
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
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, status: nextStatus[n.status] } : n)),
      }));
      scheduleSave();
    },

    setStatus: (id, status) => {
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
      set((s) => ({ edges: [...s.edges, { from, to }] }));
      scheduleSave();
      return true;
    },

    removeEdge: (from, to) => {
      set((s) => ({ edges: s.edges.filter((e) => !(e.from === from && e.to === to)) }));
      scheduleSave();
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
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const targets = childIds.filter((id) => byId.has(id));
      if (targets.length === 0) return null;

      // 若复用已有父：按 setParent 规则逐个校验（循环 + 深度）
      // 若创建新父：新父是顶层（parentDepth=0），每个 child 挂上后深度 = 1 + childHeight
      //             超出 MAX_HIERARCHY_DEPTH 的直接拒绝整次操作
      if (opts?.existingParentId) {
        for (const cid of targets) {
          if (wouldCreateParentCycle(state.nodes, cid, opts.existingParentId)) {
            toast.error('父子关系会形成循环', '已阻止');
            return null;
          }
          if (wouldExceedMaxDepth(state.nodes, cid, opts.existingParentId)) {
            toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
            return null;
          }
        }
      } else {
        for (const cid of targets) {
          // 新父是顶层（depth=0），挂上后该子的深度 = 1；子树最深 = 1 + childHeight
          // 层数 = 1 + childHeight + 1 ≤ MAX
          if (1 + subtreeHeight(state.nodes, cid) + 1 > MAX_HIERARCHY_DEPTH) {
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
          priority: 2,
          x: minX - GROUP_PAD_X,
          y: minY - GROUP_PAD_Y,
        };
        isNewParent = true;
      }

      const parentId = parentTask.id;
      const parentX = parentTask.x ?? 0;
      const parentY = parentTask.y ?? 0;
      const targetSet = new Set(targets);

      set((s) => {
        let next = s.nodes;
        if (isNewParent) next = [...next, parentTask];
        next = next.map((n) => {
          if (!targetSet.has(n.id)) return n;
          if (wouldCreateParentCycle(next, n.id, parentId)) return n;
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
      const state = get();
      const parent = state.nodes.find((n) => n.id === parentId);
      if (!parent) return false;
      const children = state.nodes.filter((n) => n.parentId === parentId);
      if (children.length === 0) return false;

      let minX = Infinity;
      let minY = Infinity;
      for (const c of children) {
        if ((c.x ?? 0) < minX) minX = c.x ?? 0;
        if ((c.y ?? 0) < minY) minY = c.y ?? 0;
      }
      const dx = minX < 0 ? minX : 0;
      const dy = minY < 0 ? minY : 0;
      if (dx === 0 && dy === 0) return false;

      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id === parentId) {
            return { ...n, x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy };
          }
          if (n.parentId === parentId) {
            return { ...n, x: (n.x ?? 0) - dx, y: (n.y ?? 0) - dy };
          }
          return n;
        }),
      }));
      scheduleSave();
      return true;
    },

    getGraph: () => ({ nodes: get().nodes, edges: get().edges }),

    getReadySet: () => new Set(readyTasks(get().getGraph()).map((n) => n.id)),

    getRecommended: () => recommend(get().getGraph()),
  };
});
