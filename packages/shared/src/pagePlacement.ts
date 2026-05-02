import type { Task } from './schema.js';
import {
  CHILD_DEFAULT_H,
  CHILD_DEFAULT_W,
  type CollisionRect,
  computeGroupSize,
  rectsOverlap,
} from './graphGeometry.js';

const PAGE_MOVE_GAP = 12;
const PAGE_MOVE_STEP = 24;
const PAGE_MOVE_MAX_RING = 60;

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
  const visit = (id: string, seen = new Set<string>()): { w: number; h: number } => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (seen.has(id) || !byId.has(id)) {
      return { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
    }
    seen.add(id);
    const childIds = childrenOf.get(id) ?? [];
    if (childIds.length === 0) {
      const leaf = { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
      memo.set(id, leaf);
      return leaf;
    }
    const size = computeGroupSize(
      childIds.map((childId) => {
        const child = byId.get(childId)!;
        const childSize = visit(childId, new Set(seen));
        return {
          x: child.x ?? 0,
          y: child.y ?? 0,
          w: childSize.w,
          h: childSize.h,
        };
      }),
    );
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

  const movedIdSet = new Set(movedNodes.map((n) => n.id));
  const movedRoots = movedNodes.filter((n) => !n.parentId || !movedIdSet.has(n.parentId));
  if (movedRoots.length === 0) return movedNodes;

  const sizeMap = computeNodeSizeMap(movedNodes);
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
  const { dx, dy } = resolveClusterTranslation(movingRects, occupied);
  if (dx === 0 && dy === 0) return movedNodes;

  const rootIds = new Set(movedRoots.map((n) => n.id));
  return movedNodes.map((n) =>
    rootIds.has(n.id)
      ? { ...n, x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy }
      : n,
  );
}

function resolveClusterTranslation(
  moving: CollisionRect[],
  occupied: CollisionRect[],
): { dx: number; dy: number } {
  if (clusterFits(moving, occupied, 0, 0)) {
    return { dx: 0, dy: 0 };
  }

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
    for (const candidate of candidates) {
      if (clusterFits(moving, occupied, candidate.dx, candidate.dy)) {
        return { dx: candidate.dx, dy: candidate.dy };
      }
    }
  }

  return { dx: 0, dy: 0 };
}

function clusterFits(
  moving: CollisionRect[],
  occupied: CollisionRect[],
  dx: number,
  dy: number,
): boolean {
  const shifted = moving.map((rect) => ({
    ...rect,
    x: rect.x + dx,
    y: rect.y + dy,
  }));
  for (const rect of shifted) {
    for (const other of occupied) {
      if (rectsOverlap(rect, other, PAGE_MOVE_GAP)) return false;
    }
  }
  for (let i = 0; i < shifted.length; i++) {
    for (let j = i + 1; j < shifted.length; j++) {
      if (rectsOverlap(shifted[i]!, shifted[j]!, PAGE_MOVE_GAP)) return false;
    }
  }
  return true;
}
