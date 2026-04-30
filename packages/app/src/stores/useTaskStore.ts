import { create } from 'zustand';
import { wouldCreateCycle, readyTasks, recommend } from '@todograph/core';
import type { Edge, Graph, Task, TaskStatus } from '@todograph/shared';
import { api } from '@/api/client';
import { toast } from '@/components/ui/toaster-store';
import { debounce, uid } from '@/lib/utils';

interface TaskStore {
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
  load: () => Promise<void>;

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
   * 把 childId 归入 parentId 下（parentId === null 表示解除归属）。
   * positionHint 提供时，直接用作 child 在新父下的相对坐标，跳过 world→local 转换。
   * 用于「拖拽合并」时希望新子节点落在整洁位置而不是保留拖拽终点。
   */
  setParent: (childId: string, parentId: string | null, positionHint?: { x: number; y: number }) => boolean;
  /** 把一批子任务合并到一个新父任务下；若 existingParentId 给出则复用它，否则创建新父。 */
  groupTasks: (childIds: string[], opts?: { title?: string; existingParentId?: string }) => string | null;
  /**
   * 归一化某个父节点下的子坐标：若有子节点出现负相对坐标，
   * 把父节点左/上移 |min|，所有子节点同步右/下移 |min|，
   * 视觉上保持不变但消除负值（便于父框正确包围）。
   * 无副作用时（所有子都 ≥ 0）直接返回 false。
   */
  normalizeGroupBounds: (parentId: string) => boolean;

  // ---- derived ----
  getGraph: () => Graph;
  getReadySet: () => Set<string>;
  getRecommended: () => Task | null;
}

/**
 * 所有写操作都会调用 scheduleSave 进行防抖持久化。
 * 派生信息（ready / recommended）通过 getter 实时计算，避免重复的 state。
 */
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

export const useTaskStore = create<TaskStore>((set, get) => {
  const scheduleSave = debounce(() => {
    const graph = get().getGraph();
    api.saveGraph(graph).catch((err) => {
      toast.error('保存失败', String(err?.message ?? err));
    });
  }, 250);

  return {
    nodes: [],
    edges: [],
    loaded: false,
    viewportCenter: null,

    setViewportCenter: (p) => set({ viewportCenter: p }),

    load: async () => {
      try {
        const g = await api.loadGraph();
        set({ nodes: g.nodes, edges: g.edges, loaded: true });
      } catch (err) {
        toast.error('加载失败', String((err as Error).message));
        set({ loaded: true });
      }
    },

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

    groupTasks: (childIds, opts) => {
      if (childIds.length === 0) return null;
      const state = get();
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const targets = childIds.filter((id) => byId.has(id));
      if (targets.length === 0) return null;

      // 收集将作为 children 的节点"世界坐标"（考虑已有 parent 的情况）
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
        // 新父节点位置：包围盒左上角 − 内边距，确保所有子节点有正的相对坐标
        const worlds = targets.map(worldPosOf);
        const minX = Math.min(...worlds.map((p) => p.x));
        const minY = Math.min(...worlds.map((p) => p.y));
        const GROUP_PAD_X = 28;
        const GROUP_PAD_Y = 44; // 上方留出 header 空间
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

      // 把 add parent 和 reparent children 合并成单次 set，避免"闪烁"中间态
      set((s) => {
        let next = s.nodes;
        if (isNewParent) next = [...next, parentTask];
        next = next.map((n) => {
          if (!targetSet.has(n.id)) return n;
          if (wouldCreateParentCycle(next, n.id, parentId)) return n;
          // 子节点坐标：世界坐标 − 父节点世界坐标
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
      // 只有出现负值才需要归一化 —— 正常场景跳过，避免无意义扰动
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
