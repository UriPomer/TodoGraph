import type { Task } from './schema.js';
import { MAX_HIERARCHY_DEPTH } from './hierarchy.js';
import {
  CHILD_DEFAULT_H,
  CHILD_DEFAULT_W,
  CollisionRectIndex,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  type CollisionRect,
  computeGroupSize,
  capGroupSize,
  rectsOverlap,
} from './graphGeometry.js';

const PAGE_MOVE_GAP = 12;
const PAGE_MOVE_STEP = 24;
const PAGE_MOVE_MAX_RING = 60;
const NODE_OVERLAP_CANDIDATE_BUDGET = 256;

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

export interface NodeGeometry {
  fullSize: { w: number; h: number };
  displayedSize: { w: number; h: number };
  collapsed: boolean;
}

export function computeNodeGeometryMap(nodes: Task[]): Map<string, NodeGeometry> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error('duplicate task id in geometry input');
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    // Partial subtrees intentionally omit ancestors; only index parent links inside this input.
    if (!n.parentId || !byId.has(n.parentId)) continue;
    const arr = childrenOf.get(n.parentId);
    if (arr) arr.push(n.id);
    else childrenOf.set(n.parentId, [n.id]);
  }

  const memo = new Map<string, NodeGeometry>();
  const visiting = new Set<string>();
  const visit = (id: string): NodeGeometry => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) throw new Error(`parent cycle at task ${id}`);
    const node = byId.get(id)!;
    visiting.add(id);
    const childIds = childrenOf.get(id) ?? [];
    if (childIds.length === 0) {
      const size = { w: node.width ?? CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
      const leaf = { fullSize: size, displayedSize: size, collapsed: false };
      memo.set(id, leaf);
      visiting.delete(id);
      return leaf;
    }
    const fullSize = computeGroupSize(
      childIds.map((childId) => {
        const child = byId.get(childId)!;
        const childSize = visit(childId).displayedSize;
        return {
          x: child.x ?? 0,
          y: child.y ?? 0,
          w: childSize.w,
          h: childSize.h,
        };
      }),
    );
    const displayedSize = capGroupSize(fullSize);
    const geometry = { fullSize, displayedSize, collapsed: displayedSize.h < fullSize.h };
    visiting.delete(id);
    memo.set(id, geometry);
    return geometry;
  };

  for (const n of nodes) visit(n.id);
  return memo;
}

export function computeNodeSizeMap(nodes: Task[]): Map<string, { w: number; h: number }> {
  return new Map(
    [...computeNodeGeometryMap(nodes)].map(([id, geometry]) => [id, geometry.displayedSize]),
  );
}

export function buildTopLevelCollisionRects(nodes: Task[]): CollisionRect[] {
  const sizeMap = computeNodeSizeMap(nodes);
  return nodes
    .filter((n) => !n.parentId)
    .map((n) => {
      const size = sizeMap.get(n.id)!;
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
    const size = sizeMap.get(n.id)!;
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

/** Backward-compatible full-page repair entrypoint. */
export function separateSiblingNodeOverlaps(nodes: Task[], gap = PAGE_MOVE_GAP): Task[] {
  return resolveNodeOverlaps(nodes, { gap }).nodes;
}

export interface ResolveNodeOverlapsOptions {
  /** Only these nodes' sibling scopes and ancestor scopes need recomputing. */
  changedIds?: readonly string[];
  /** Higher-priority nodes are placed first and therefore keep their requested position. */
  pinnedIds?: readonly string[];
  gap?: number;
  /** Shared deterministic budget for two-dimensional nearest-position candidates. */
  candidateBudget?: number;
}

export interface ResolveNodeOverlapsResult {
  nodes: Task[];
  movedIds: string[];
  fallbackUsed: boolean;
}

export interface NodeOverlapConflict {
  firstId: string;
  secondId: string;
  parentId?: string;
}

export type NodeOverlapValidation =
  | { valid: true }
  | { valid: false; conflicts: NodeOverlapConflict[] };

interface PlacementCandidate {
  x: number;
  y: number;
  d2: number;
}

interface CandidateBudget {
  remaining: number;
}

/**
 * Repairs overlap inside sibling coordinate systems. Changed scopes are handled
 * from the deepest group outward so child movement is reflected in ancestor size.
 */
export function resolveNodeOverlaps(
  nodes: Task[],
  options: ResolveNodeOverlapsOptions = {},
): ResolveNodeOverlapsResult {
  if (nodes.length < 2) return { nodes, movedIds: [], fallbackUsed: false };
  const gap = options.gap ?? PAGE_MOVE_GAP;
  const normalized = normalizeAffectedGroupBounds(nodes, options.changedIds);
  let current = normalized.nodes;
  const byId = new Map(current.map((node) => [node.id, node]));
  const scopes = new Map<string, Task[]>();
  for (const node of current) {
    const key = node.parentId ?? '';
    const siblings = scopes.get(key);
    if (siblings) siblings.push(node);
    else scopes.set(key, [node]);
  }

  const selectedScopes = collectAffectedScopes(options.changedIds, byId, scopes);
  const pinOrder = collectPinnedAncestors(options.pinnedIds ?? options.changedIds ?? [], byId);
  const pinRank = new Map(pinOrder.map((id, index) => [id, index]));
  const scopesByDepth = new Map<number, string[]>();
  for (const key of selectedScopes) {
    const depth = key === '' ? -1 : nodeDepth(key, byId);
    const keys = scopesByDepth.get(depth);
    if (keys) keys.push(key);
    else scopesByDepth.set(depth, [key]);
  }

  const movedIds = new Set<string>(normalized.movedIds);
  const budget: CandidateBudget = {
    remaining: Math.max(0, options.candidateBudget ?? NODE_OVERLAP_CANDIDATE_BUDGET),
  };
  let fallbackUsed = false;
  const depths = [...scopesByDepth.keys()].sort((a, b) => b - a);
  for (const depth of depths) {
    const sizeMap = computeNodeSizeMap(current);
    const currentById = new Map(current.map((node) => [node.id, node]));
    const patches = new Map<string, { x: number; y: number }>();
    for (const key of scopesByDepth.get(depth) ?? []) {
      const siblings = (scopes.get(key) ?? [])
        .map((node) => currentById.get(node.id) ?? node);
      const result = resolveScope(siblings, sizeMap, pinRank, budget, gap);
      fallbackUsed ||= result.fallbackUsed;
      for (const [id, position] of result.patches) {
        patches.set(id, position);
        movedIds.add(id);
      }
    }
    if (patches.size > 0) {
      current = current.map((node) => {
        const position = patches.get(node.id);
        return position ? { ...node, ...position } : node;
      });
    }
  }

  return { nodes: current, movedIds: [...movedIds], fallbackUsed };
}

function normalizeAffectedGroupBounds(
  nodes: Task[],
  changedIds: readonly string[] | undefined,
): { nodes: Task[]; movedIds: string[] } {
  const initialById = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenOf.get(node.parentId);
    if (children) children.push(node.id);
    else childrenOf.set(node.parentId, [node.id]);
  }
  const groupIds = new Set<string>();
  if (!changedIds || changedIds.length === 0) {
    for (const id of childrenOf.keys()) groupIds.add(id);
  } else {
    for (const id of changedIds) {
      let node = initialById.get(id);
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        seen.add(node.id);
        if (childrenOf.has(node.id)) groupIds.add(node.id);
        if (!node.parentId) break;
        groupIds.add(node.parentId);
        node = initialById.get(node.parentId);
      }
    }
  }
  if (groupIds.size === 0) return { nodes, movedIds: [] };

  const groupsByDepth = new Map<number, string[]>();
  for (const id of groupIds) {
    const depth = nodeDepth(id, initialById);
    const atDepth = groupsByDepth.get(depth);
    if (atDepth) atDepth.push(id);
    else groupsByDepth.set(depth, [id]);
  }
  let current = nodes;
  const movedIds = new Set<string>();
  for (const depth of [...groupsByDepth.keys()].sort((a, b) => b - a)) {
    const byId = new Map(current.map((node) => [node.id, node]));
    const patches = new Map<string, { x: number; y: number }>();
    for (const parentId of groupsByDepth.get(depth) ?? []) {
      const parent = byId.get(parentId);
      const children = (childrenOf.get(parentId) ?? [])
        .map((id) => byId.get(id))
        .filter((node): node is Task => Boolean(node));
      if (!parent || children.length === 0) continue;
      let minX = Infinity;
      let minY = Infinity;
      for (const child of children) {
        minX = Math.min(minX, child.x ?? 0);
        minY = Math.min(minY, child.y ?? 0);
      }
      const dx = minX - GROUP_PADDING_X;
      const dy = minY - GROUP_PADDING_Y;
      if (dx === 0 && dy === 0) continue;
      patches.set(parentId, { x: (parent.x ?? 0) + dx, y: (parent.y ?? 0) + dy });
      movedIds.add(parentId);
      for (const child of children) {
        patches.set(child.id, { x: (child.x ?? 0) - dx, y: (child.y ?? 0) - dy });
        movedIds.add(child.id);
      }
    }
    if (patches.size > 0) {
      current = current.map((node) => {
        const position = patches.get(node.id);
        return position ? { ...node, ...position } : node;
      });
    }
  }
  return { nodes: current, movedIds: [...movedIds] };
}

/** Returns the first conflicts up to `limit`; parent-child containment is ignored. */
export function validateNoSiblingOverlaps(
  nodes: Task[],
  gap = PAGE_MOVE_GAP,
  limit = 20,
): NodeOverlapValidation {
  const sizeMap = computeNodeSizeMap(nodes);
  const scopes = new Map<string, Task[]>();
  for (const node of nodes) {
    const key = node.parentId ?? '';
    const siblings = scopes.get(key);
    if (siblings) siblings.push(node);
    else scopes.set(key, [node]);
  }
  const conflicts: NodeOverlapConflict[] = [];
  for (const [parentId, siblings] of scopes) {
    const index = new CollisionRectIndex();
    for (const node of siblings) {
      const rect = rectForNode(node, sizeMap);
      for (const other of index.query(rect, gap)) {
        if (!rectsOverlap(rect, other, gap)) continue;
        conflicts.push({
          firstId: other.id,
          secondId: node.id,
          ...(parentId ? { parentId } : {}),
        });
        if (conflicts.length >= limit) return { valid: false, conflicts };
      }
      index.add(rect);
    }
  }
  return conflicts.length > 0 ? { valid: false, conflicts } : { valid: true };
}

function collectAffectedScopes(
  changedIds: readonly string[] | undefined,
  byId: Map<string, Task>,
  scopes: Map<string, Task[]>,
): Set<string> {
  if (!changedIds || changedIds.length === 0) return new Set(scopes.keys());
  const result = new Set<string>();
  for (const id of changedIds) {
    let node = byId.get(id);
    const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      result.add(node.parentId ?? '');
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  }
  return result;
}

function collectPinnedAncestors(ids: readonly string[], byId: Map<string, Task>): string[] {
  const result: string[] = [];
  const added = new Set<string>();
  for (const id of ids) {
    let node = byId.get(id);
    const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      if (!added.has(node.id)) {
        added.add(node.id);
        result.push(node.id);
      }
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  }
  return result;
}

function nodeDepth(id: string, byId: Map<string, Task>): number {
  let depth = 0;
  let node = byId.get(id);
  const seen = new Set<string>();
  while (node?.parentId && !seen.has(node.id) && depth < MAX_HIERARCHY_DEPTH) {
    seen.add(node.id);
    depth += 1;
    node = byId.get(node.parentId);
  }
  return depth;
}

function resolveScope(
  siblings: Task[],
  sizeMap: Map<string, { w: number; h: number }>,
  pinRank: Map<string, number>,
  budget: CandidateBudget,
  gap: number,
): { patches: Map<string, { x: number; y: number }>; fallbackUsed: boolean } {
  if (siblings.length < 2) return { patches: new Map(), fallbackUsed: false };
  const originalOrder = new Map(siblings.map((node, index) => [node.id, index]));
  const ordered = [...siblings].sort((a, b) => {
    const ar = pinRank.get(a.id);
    const br = pinRank.get(b.id);
    if (ar !== undefined || br !== undefined) {
      if (ar === undefined) return 1;
      if (br === undefined) return -1;
      return ar - br;
    }
    return (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0);
  });
  const index = new CollisionRectIndex();
  const patches = new Map<string, { x: number; y: number }>();
  const initialRight = Math.max(...siblings.map((node) => {
    const size = sizeMap.get(node.id)!;
    return (node.x ?? 0) + size.w;
  }));
  let fallbackX: number | null = null;
  let fallbackY = Math.min(...siblings.map((node) => node.y ?? 0));
  let maxPlacedRight = initialRight;
  let fallbackUsed = false;

  for (const node of ordered) {
    const original = rectForNode(node, sizeMap);
    let placed = original;
    const collisions = exactCollisions(original, index, gap);
    if (collisions.length > 0) {
      const nearest = findNearestFree(original, collisions, index, budget, gap);
      if (nearest) {
        placed = nearest;
      } else {
        fallbackUsed = true;
        fallbackX ??= maxPlacedRight + gap;
        placed = {
          ...original,
          x: fallbackX,
          y: Math.max(original.y, fallbackY),
        };
        fallbackY = placed.y + placed.h + gap;
      }
      patches.set(node.id, { x: placed.x, y: placed.y });
    }
    maxPlacedRight = Math.max(maxPlacedRight, placed.x + placed.w);
    index.add(placed);
  }
  return { patches, fallbackUsed };
}

function rectForNode(
  node: Task,
  sizeMap: Map<string, { w: number; h: number }>,
): CollisionRect {
  const size = sizeMap.get(node.id)!;
  return { id: node.id, x: node.x ?? 0, y: node.y ?? 0, w: size.w, h: size.h };
}

function exactCollisions(
  rect: CollisionRect,
  index: CollisionRectIndex,
  gap: number,
): CollisionRect[] {
  return index.query(rect, gap).filter((other) => rectsOverlap(rect, other, gap));
}

function findNearestFree(
  original: CollisionRect,
  initialCollisions: CollisionRect[],
  index: CollisionRectIndex,
  budget: CandidateBudget,
  gap: number,
): CollisionRect | null {
  const queue: PlacementCandidate[] = [];
  const seen = new Set<string>([`${original.x}:${original.y}`]);
  enqueueObstacleBoundaries(queue, seen, original, original, initialCollisions, gap);
  while (queue.length > 0 && budget.remaining > 0) {
    budget.remaining -= 1;
    const candidate = queue.shift()!;
    const rect = { ...original, x: candidate.x, y: candidate.y };
    const collisions = exactCollisions(rect, index, gap);
    if (collisions.length === 0) return rect;
    enqueueObstacleBoundaries(queue, seen, original, rect, collisions, gap);
  }
  return null;
}

function enqueueObstacleBoundaries(
  queue: PlacementCandidate[],
  seen: Set<string>,
  original: CollisionRect,
  current: CollisionRect,
  obstacles: CollisionRect[],
  gap: number,
): void {
  for (const obstacle of obstacles) {
    enqueueCandidate(queue, seen, original, obstacle.x - original.w - gap, current.y);
    enqueueCandidate(queue, seen, original, obstacle.x + obstacle.w + gap, current.y);
    enqueueCandidate(queue, seen, original, current.x, obstacle.y - original.h - gap);
    enqueueCandidate(queue, seen, original, current.x, obstacle.y + obstacle.h + gap);
  }
}

function enqueueCandidate(
  queue: PlacementCandidate[],
  seen: Set<string>,
  original: CollisionRect,
  x: number,
  y: number,
): void {
  const key = `${x}:${y}`;
  if (seen.has(key)) return;
  seen.add(key);
  const dx = x - original.x;
  const dy = y - original.y;
  const candidate = { x, y, d2: dx * dx + dy * dy };
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const other = queue[mid]!;
    if (other.d2 < candidate.d2 ||
      (other.d2 === candidate.d2 && (other.y < candidate.y ||
        (other.y === candidate.y && other.x <= candidate.x)))) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  queue.splice(low, 0, candidate);
}
