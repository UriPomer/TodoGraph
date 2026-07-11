import type { Task } from './schema.js';
import { MAX_HIERARCHY_DEPTH } from './hierarchy.js';
import {
  CHILD_DEFAULT_H,
  CHILD_DEFAULT_W,
  CollisionRectIndex,
  type CollisionRect,
  computeGroupSize,
  rectsOverlap,
} from './graphGeometry.js';

const PAGE_MOVE_GAP = 12;
const PAGE_MOVE_STEP = 24;
const PAGE_MOVE_MAX_RING = 60;

const PAGE_MOVE_OFFSETS = (() => {
  const offsets: Array<{ dx: number; dy: number }> = [];
  for (let ring = 1; ring <= PAGE_MOVE_MAX_RING; ring++) {
    const candidates: Array<{ dx: number; dy: number; d2: number }> = [];
    for (let x = -ring; x <= ring; x++) {
      for (let y = -ring; y <= ring; y++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
        candidates.push({
          dx: x * PAGE_MOVE_STEP,
          dy: y * PAGE_MOVE_STEP,
          d2: x * x + y * y,
        });
      }
    }
    candidates.sort((a, b) => a.d2 - b.d2 || a.dy - b.dy || a.dx - b.dx);
    offsets.push(...candidates);
  }
  return offsets;
})();

export function computeNodeSizeMap(nodes: Task[]): Map<string, { w: number; h: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const arr = childrenOf.get(n.parentId);
    if (arr) arr.push(n.id);
    else childrenOf.set(n.parentId, [n.id]);
  }

  const memo = new Map<string, { w: number; h: number }>();
  const visiting = new Set<string>();
  const visit = (id: string): { w: number; h: number } => {
    const cached = memo.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node || visiting.has(id)) {
      return { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
    }
    visiting.add(id);
    const childIds = childrenOf.get(id) ?? [];
    if (childIds.length === 0) {
      const leaf = { w: node.width ?? CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
      memo.set(id, leaf);
      visiting.delete(id);
      return leaf;
    }
    const size = computeGroupSize(
      childIds.map((childId) => {
        const child = byId.get(childId)!;
        const childSize = visit(childId);
        return {
          x: child.x ?? 0,
          y: child.y ?? 0,
          w: childSize.w,
          h: childSize.h,
        };
      }),
    );
    visiting.delete(id);
    memo.set(id, size);
    return size;
  };

  for (const n of nodes) visit(n.id);
  return memo;
}

export function buildTopLevelCollisionRects(nodes: Task[]): CollisionRect[] {
  const sizeMap = computeNodeSizeMap(nodes);
  return nodes
    .filter((n) => !n.parentId)
    .map((n) => {
      const size = sizeMap.get(n.id) ?? { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
      return {
        id: n.id,
        x: n.x ?? 0,
        y: n.y ?? 0,
        w: size.w,
        h: size.h,
      };
    });
}

export function placeMovedNodesOnTarget(targetNodes: Task[], movedNodes: Task[]): Task[] {
  if (movedNodes.length === 0) return movedNodes;

  const safeMovedNodes = separateSiblingNodeOverlaps(movedNodes);

  const movedIdSet = new Set(safeMovedNodes.map((n) => n.id));
  const movedRoots = safeMovedNodes.filter((n) => !n.parentId || !movedIdSet.has(n.parentId));
  if (movedRoots.length === 0) return safeMovedNodes;

  const sizeMap = computeNodeSizeMap(safeMovedNodes);
  const movingRects = movedRoots.map((n) => {
    const size = sizeMap.get(n.id) ?? { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
    return {
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      w: size.w,
      h: size.h,
    };
  });
  const occupied = buildTopLevelCollisionRects(targetNodes);
  const { dx, dy } = resolveClusterTranslationAvoidingOccupied(movingRects, occupied);
  if (dx === 0 && dy === 0) return safeMovedNodes;

  const rootIds = new Set(movedRoots.map((n) => n.id));
  return safeMovedNodes.map((n) =>
    rootIds.has(n.id) ? { ...n, x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy } : n,
  );
}

/** Finds one translation for the whole cluster that avoids occupied rects.
 * Relative positions inside `moving` are preserved and are not repaired. */
export function resolveClusterTranslationAvoidingOccupied(
  moving: CollisionRect[],
  occupied: CollisionRect[],
  options: { gap?: number; step?: number; maxRing?: number } = {},
): { dx: number; dy: number } {
  if (moving.length === 0) return { dx: 0, dy: 0 };
  const gap = options.gap ?? PAGE_MOVE_GAP;
  const step = options.step ?? PAGE_MOVE_STEP;
  const maxRing = Math.min(options.maxRing ?? PAGE_MOVE_MAX_RING, PAGE_MOVE_MAX_RING);
  const occupiedIndex = new CollisionRectIndex(occupied);
  if (clusterFits(moving, occupiedIndex, 0, 0, gap)) {
    return { dx: 0, dy: 0 };
  }

  for (const candidate of PAGE_MOVE_OFFSETS) {
    const ring = Math.max(
      Math.abs(candidate.dx / PAGE_MOVE_STEP),
      Math.abs(candidate.dy / PAGE_MOVE_STEP),
    );
    if (ring > maxRing) continue;
    const dx = (candidate.dx / PAGE_MOVE_STEP) * step;
    const dy = (candidate.dy / PAGE_MOVE_STEP) * step;
    if (clusterFits(moving, occupiedIndex, dx, dy, gap)) {
      return { dx, dy };
    }
  }

  const minMovingX = Math.min(...moving.map((rect) => rect.x));
  const minMovingY = Math.min(...moving.map((rect) => rect.y));
  const occupiedRight = Math.max(...occupied.map((rect) => rect.x + rect.w), minMovingX);
  return {
    dx: occupiedRight + gap - minMovingX,
    dy: Math.max(0, -minMovingY),
  };
}

function clusterFits(
  moving: CollisionRect[],
  occupied: CollisionRectIndex,
  dx: number,
  dy: number,
  gap: number,
): boolean {
  for (const rect of moving) {
    const sy = rect.y + dy;
    if (sy < 0) return false;
    const shifted = { ...rect, x: rect.x + dx, y: sy };
    if (
      occupied
        .query(shifted, gap)
        .some((other) => rectsOverlap(shifted, other, gap))
    )
      return false;
  }
  return true;
}

/**
 * Separates rectangles that share a coordinate system. Later nodes move to the
 * right, so existing placement remains stable when a node is appended. Repeated
 * passes propagate child movement into expanded ancestor bounds.
 */
export function separateSiblingNodeOverlaps(nodes: Task[], gap = PAGE_MOVE_GAP): Task[] {
  let current = nodes;
  for (let pass = 0; pass <= MAX_HIERARCHY_DEPTH; pass++) {
    const sizeMap = computeNodeSizeMap(current);
    const scopes = new Map<string, Task[]>();
    for (const node of current) {
      const key = node.parentId ?? '';
      const siblings = scopes.get(key);
      if (siblings) siblings.push(node);
      else scopes.set(key, [node]);
    }

    const patches = new Map<string, number>();
    for (const siblings of scopes.values()) {
      const index = new CollisionRectIndex();
      for (const node of siblings) {
        const size = sizeMap.get(node.id) ?? { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
        let rect: CollisionRect = {
          id: node.id,
          x: node.x ?? 0,
          y: node.y ?? 0,
          w: size.w,
          h: size.h,
        };
        let collisions = index.query(rect, gap).filter((other) => rectsOverlap(rect, other, gap));
        if (collisions.length > 0) {
          rect = {
            ...rect,
            x: Math.max(...collisions.map((other) => other.x + other.w + gap)),
          };
          collisions = index.query(rect, gap).filter((other) => rectsOverlap(rect, other, gap));
          while (collisions.length > 0) {
            rect = {
              ...rect,
              x: Math.max(...collisions.map((other) => other.x + other.w + gap)),
            };
            collisions = index.query(rect, gap).filter((other) => rectsOverlap(rect, other, gap));
          }
          patches.set(node.id, rect.x);
        }
        index.add(rect);
      }
    }
    if (patches.size === 0) return current;
    current = current.map((node) => {
      const x = patches.get(node.id);
      return x === undefined ? node : { ...node, x };
    });
  }
  return current;
}
