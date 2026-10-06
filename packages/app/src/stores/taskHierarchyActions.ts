import { MAX_HIERARCHY_DEPTH, type Task } from '@todograph/shared';
import { toast } from '@/components/ui/toaster-store';
import { uid } from '@/lib/utils';
import {
  buildHierarchyIndex, worldPositionFromIndex, wouldCreateParentCycleFromIndex,
  wouldExceedMaxDepthFromIndex, subtreeHeightFromIndex,
  type HierarchyIndex,
} from '@/lib/taskHierarchy';
import { repairGeometry } from '@/lib/taskGeometry';
import type { TaskStore, TaskStoreContext } from './taskStoreTypes';

type HierarchyActions = Pick<TaskStore,
  | 'setParent' | 'reorderTask' | 'moveTaskToSibling' | 'ascendOneLevel' | 'groupTasks'>;

export function createTaskHierarchyActions({ set, get, pushPre, scheduleSave }: TaskStoreContext): HierarchyActions {
  const canChangeParent = (index: HierarchyIndex, childId: string, parentId: string | null) => {
    if (parentId && wouldCreateParentCycleFromIndex(index, childId, parentId)) {
      toast.error('父子关系会形成循环', '已阻止');
      return false;
    }
    if (wouldExceedMaxDepthFromIndex(index, childId, parentId)) {
      toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
      return false;
    }
    return true;
  };
  const parentPatch = (index: HierarchyIndex, task: Task, parentId: string | null, position?: { x: number; y: number }): Partial<Task> => {
    if (position) return { parentId: parentId ?? undefined, ...position };
    const world = task.x === undefined || task.y === undefined
      ? (get().viewportCenter ?? { x: 200, y: 100 })
      : worldPositionFromIndex(index, task.id);
    const parentWorld = parentId ? worldPositionFromIndex(index, parentId) : { x: 0, y: 0 };
    return { parentId: parentId ?? undefined, x: world.x - parentWorld.x, y: world.y - parentWorld.y };
  };
  return {
    setParent: (childId, parentId, positionHint) => {
      const state = get();
      const idx = buildHierarchyIndex(state.nodes);
      if (!canChangeParent(idx, childId, parentId)) return false;
      const child = idx.byId.get(childId);
      if (!child) return false;
      const parent = parentId ? idx.byId.get(parentId) : undefined;
      if (parent?.status === 'done' && child.status !== 'done') {
        toast.error('已完成的父任务不能接收未完成的子任务', '已阻止');
        return false;
      }
      pushPre();
      const patch = parentPatch(idx, child, parentId, positionHint);
      set((s) => ({
        nodes: repairGeometry(s.nodes.map(n => n.id === childId ? { ...n, ...patch } : n), [childId]),
        listRevision: s.listRevision + 1,
      }));
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
      if (!canChangeParent(index, taskId, targetParentId)) return false;

      const storagePosition = storageOrder === 'forward'
        ? position
        : position === 'before' ? 'after' : 'before';
      const withoutTask = state.nodes.filter((node) => node.id !== taskId);
      const anchorIndex = withoutTask.findIndex((node) => node.id === anchorId);
      if (anchorIndex < 0) return false;
      const insertionIndex = anchorIndex + (storagePosition === 'after' ? 1 : 0);
      const sameParent = (task.parentId ?? null) === targetParentId;
      const targetParent = targetParentId ? index.byId.get(targetParentId) : undefined;
      if (!sameParent && targetParent?.status === 'done' && task.status !== 'done') {
        toast.error('已完成的父任务不能接收未完成的子任务', '已阻止');
        return false;
      }
      const movedTask = sameParent ? task : { ...task, ...parentPatch(index, task, targetParentId) };
      withoutTask.splice(insertionIndex, 0, movedTask);
      if (state.nodes.every((node, nodeIndex) => node === withoutTask[nodeIndex])) return false;

      pushPre();
      set({
        nodes: sameParent ? withoutTask : repairGeometry(withoutTask, [taskId]),
        listRevision: state.listRevision + 1,
      });
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
          if (!canChangeParent(index, cid, opts.existingParentId)) return null;
        }
      } else {
        for (const cid of targets) {
          if (1 + subtreeHeightFromIndex(index, cid) + 1 > MAX_HIERARCHY_DEPTH) {
            toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`, '已阻止');
            return null;
          }
        }
      }

      const targetWorldById = new Map(targets.map(id => [id, worldPositionFromIndex(index, id)]));
      const existingParent = opts?.existingParentId ? index.byId.get(opts.existingParentId) : undefined;
      let parentTask: Task;
      let isNewParent = false;
      if (existingParent) {
        parentTask = existingParent;
      } else {
        const worlds = [...targetWorldById.values()];
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
      pushPre();
      set((s) => {
        let next = s.nodes;
        if (isNewParent) next = [...next, parentTask];
        next = next.map((n) => {
          if (!targetSet.has(n.id)) return n;
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
  };
}
