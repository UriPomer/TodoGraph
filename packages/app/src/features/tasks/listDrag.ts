import { MAX_HIERARCHY_DEPTH, type Task } from '@todograph/shared';
import { isDescendant } from './listModel';

export type StorageOrder = 'forward' | 'reverse';
export type ListDropIntent =
  | { kind: 'none' }
  | { kind: 'nest'; targetId: string }
  | { kind: 'reorder'; anchorId: string; position: 'before' | 'after'; storageOrder: StorageOrder }
  | { kind: 'reparent-reorder'; anchorId: string; position: 'before' | 'after'; storageOrder: StorageOrder }
  | { kind: 'unparent' };
const UNPARENT_DRAG_X = 20;

interface DropIntentInput {
  startX: number;
  clientX: number;
  clientY: number;
  dragged: Task;
  target: Task | null;
  targetRect: Pick<DOMRect, 'top' | 'height'> | null;
  byId: ReadonlyMap<string, Task>;
  depthById: ReadonlyMap<string, number>;
  subtreeHeightById: ReadonlyMap<string, number>;
}

/** Converts a pointer position into one explicit, testable drop operation. */
export function resolveListDropIntent(input: DropIntentInput): ListDropIntent {
  const { dragged, target, targetRect } = input;
  const validTarget = target && targetRect && target.id !== dragged.id
    && !isDescendant(input.byId, target.id, dragged.id);
  if (validTarget) {
    const ratio = targetRect.height > 0 ? (input.clientY - targetRect.top) / targetRect.height : 0.5;
    const inNestZone = ratio >= 0.35 && ratio <= 0.65;
    const sameParent = (dragged.parentId ?? null) === (target.parentId ?? null);
    if (!inNestZone && sameParent) {
      return {
        kind: 'reorder',
        anchorId: target.id,
        position: ratio < 0.5 ? 'before' : 'after',
        storageOrder: dragged.status !== 'done' && !dragged.parentId ? 'reverse' : 'forward',
      };
    }
    if (!inNestZone) {
      const targetDepth = input.depthById.get(target.id) ?? 0;
      const subtreeHeight = input.subtreeHeightById.get(dragged.id) ?? 0;
      if (targetDepth + subtreeHeight + 1 <= MAX_HIERARCHY_DEPTH) {
        return {
          kind: 'reparent-reorder',
          anchorId: target.id,
          position: ratio < 0.5 ? 'before' : 'after',
          storageOrder: dragged.status !== 'done' && !target.parentId ? 'reverse' : 'forward',
        };
      }
    }
    if (dragged.parentId && input.clientX - input.startX <= -UNPARENT_DRAG_X) return { kind: 'unparent' };
    if (inNestZone && dragged.parentId !== target.id) {
      const targetDepth = input.depthById.get(target.id) ?? 0;
      const subtreeHeight = input.subtreeHeightById.get(dragged.id) ?? 0;
      if (targetDepth + subtreeHeight + 2 <= MAX_HIERARCHY_DEPTH) return { kind: 'nest', targetId: target.id };
    }
  }
  if (dragged.parentId && input.clientX - input.startX <= -UNPARENT_DRAG_X) return { kind: 'unparent' };
  return { kind: 'none' };
}

export function dragAutoScrollDelta(
  pointerY: number,
  bounds: Pick<DOMRect, 'top' | 'bottom'>,
  edgeSize = 56,
  maxSpeed = 14,
): number {
  if (pointerY < bounds.top + edgeSize) {
    return -Math.ceil(maxSpeed * Math.min(1, (bounds.top + edgeSize - pointerY) / edgeSize));
  }
  if (pointerY > bounds.bottom - edgeSize) {
    return Math.ceil(maxSpeed * Math.min(1, (pointerY - (bounds.bottom - edgeSize)) / edgeSize));
  }
  return 0;
}
