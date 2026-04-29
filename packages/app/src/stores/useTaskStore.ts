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

  // ---- lifecycle ----
  load: () => Promise<void>;

  // ---- mutators ----
  addTask: (input: { title: string; priority?: number; x?: number; y?: number }) => Task;
  updateTask: (id: string, patch: Partial<Omit<Task, 'id'>>) => void;
  deleteTask: (id: string) => void;
  toggleStatus: (id: string) => void;
  setStatus: (id: string, status: TaskStatus) => void;

  addEdge: (from: string, to: string) => boolean;
  removeEdge: (from: string, to: string) => void;

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

    load: async () => {
      try {
        const g = await api.loadGraph();
        set({ nodes: g.nodes, edges: g.edges, loaded: true });
      } catch (err) {
        toast.error('加载失败', String((err as Error).message));
        set({ loaded: true });
      }
    },

    addTask: ({ title, priority = 2, x, y }) => {
      const t: Task = { id: uid(), title: title || '未命名', status: 'todo', priority, x, y };
      set((s) => ({ nodes: [...s.nodes, t] }));
      scheduleSave();
      return t;
    },

    updateTask: (id, patch) => {
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      }));
      scheduleSave();
    },

    deleteTask: (id) => {
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.from !== id && e.to !== id),
      }));
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

    getGraph: () => ({ nodes: get().nodes, edges: get().edges }),

    getReadySet: () => new Set(readyTasks(get().getGraph()).map((n) => n.id)),

    getRecommended: () => recommend(get().getGraph()),
  };
});
