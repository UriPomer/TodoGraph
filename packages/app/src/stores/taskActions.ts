import { wouldCreateCycle } from '@todograph/core';
import { hasIncompleteDirectChild, normalizeTaskDescription, type Task, type TaskStatus } from '@todograph/shared';
import { toast } from '@/components/ui/toaster-store';
import { uid } from '@/lib/utils';
import { measureTextWidth, MAX_TITLE_LENGTH } from '@/lib/measureText';
import { buildHierarchyIndex, worldPositionFromIndex } from '@/lib/taskHierarchy';
import { repairGeometry } from '@/lib/taskGeometry';
import { useHistoryStore } from './useHistoryStore';
import type { TaskStore, TaskStoreContext } from './taskStoreTypes';

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'done',
  done: 'todo',
};
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
    Object.prototype.hasOwnProperty.call(patch, 'description') ||
    Object.prototype.hasOwnProperty.call(patch, 'parentId');
}

type TaskActions = Pick<TaskStore,
  | 'addTask' | 'updateTask' | 'updateTasksBulk' | 'syncMeasuredSizes'
  | 'deleteTask' | 'deleteTasks' | 'detachTasks' | 'toggleStatus' | 'completeTask' | 'setStatus'
  | 'addEdge' | 'removeEdge' | 'insertBetween' | 'undo' | 'redo'>;

export function createTaskActions({ set, get, pushPre, scheduleSave }: TaskStoreContext): TaskActions {
  const changeStatus = (id: string, status: TaskStatus): boolean => {
    const state = get();
    if (status === 'done' && hasIncompleteDirectChild(state.nodes, id)) return false;
    pushPre();
    set({
      nodes: state.nodes.map(node => node.id === id ? { ...node, status } : node),
      recommendationRevision: state.recommendationRevision + 1,
      listRevision: state.listRevision + 1,
    });
    scheduleSave();
    return true;
  };
  const restoreHistory = (direction: 'undo' | 'redo') => {
    const { nodes, edges } = get();
    const snapshot = useHistoryStore.getState()[direction]({ nodes, edges });
    if (!snapshot) return false;
    set(state => ({
      nodes: repairGeometry(snapshot.nodes),
      edges: snapshot.edges,
      recommendationRevision: state.recommendationRevision + 1,
      listRevision: state.listRevision + 1,
    }));
    scheduleSave();
    return true;
  };
  return {
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
      const nextPatch = Object.prototype.hasOwnProperty.call(patch, 'description')
        ? { ...patch, description: normalizeTaskDescription(patch.description) }
        : patch;
      pushPre();
      set((s) => {
        let changed = false;
        const next = s.nodes.map((n) => {
          if (n.id !== id) return n;
          changed = true;
          const updated = { ...n, ...nextPatch };
          if (nextPatch.title !== undefined) {
            updated.title = nextPatch.title.slice(0, MAX_TITLE_LENGTH);
            updated.width = measureTextWidth(updated.title);
            updated.height = undefined;
          }
          return updated;
        });
        return changed
          ? {
              nodes: patchAffectsGeometry(nextPatch) ? repairGeometry(next, [id]) : next,
              recommendationRevision:
                nextPatch.status === undefined
                  ? s.recommendationRevision
                  : s.recommendationRevision + 1,
              listRevision: patchAffectsList(nextPatch) ? s.listRevision + 1 : s.listRevision,
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
      const node = get().nodes.find(candidate => candidate.id === id);
      return node ? changeStatus(id, nextStatus[node.status]) : false;
    },
    completeTask: (id) => {
      const node = get().nodes.find(candidate => candidate.id === id);
      return node && node.status !== 'done' ? changeStatus(id, 'done') : false;
    },
    setStatus: (id, status) => { changeStatus(id, status); },
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
      const forward = abEdge || (!baEdge && (nodeA.x ?? 0) <= (nodeB.x ?? 0));
      const from = forward ? aId : bId;
      const to = forward ? bId : aId;
      edges.push({ from, to: newTask.id }, { from: newTask.id, to });

      set({
        nodes: repairGeometry([...state.nodes, newTask], [newTask.id]),
        edges,
        recommendationRevision: state.recommendationRevision + 1,
        listRevision: state.listRevision + 1,
      });
      scheduleSave();
      return get().nodes.find((node) => node.id === newTask.id) ?? newTask;
    },
    undo: () => restoreHistory('undo'),
    redo: () => restoreHistory('redo'),
  };
}
