import { type CollisionRect, rectsOverlap } from '@todograph/shared';

export { type CollisionRect, rectsOverlap };

export interface ResolveDropCollisionInput {
  x: number;
  y: number;
  w: number;
  h: number;
  occupied: CollisionRect[];
  gap?: number;
  step?: number;
  maxRing?: number;
}

export interface ResolvePinnedDropPushAwayInput {
  pinned: CollisionRect;
  occupied: CollisionRect[];
  gap?: number;
  step?: number;
  maxRing?: number;
}

export const DROP_COLLISION_GAP = 12;
const DROP_COLLISION_STEP = 24;
const DROP_COLLISION_MAX_RING = 30;

// 预计算螺旋偏移量，按环 × 欧几里得距离排序，消除每次调用的构建+排序开销
interface SpiralOffset {
  dx: number;
  dy: number;
  d2: number;
}
const SPIRAL_OFFSETS: SpiralOffset[] = (() => {
  const offsets: SpiralOffset[] = [];
  for (let r = 1; r <= DROP_COLLISION_MAX_RING; r++) {
    const ring: SpiralOffset[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        ring.push({ dx, dy, d2: dx * dx + dy * dy });
      }
    }
    ring.sort((a, b) => a.d2 - b.d2 || a.dy - b.dy || a.dx - b.dx);
    for (const off of ring) offsets.push(off);
  }
  return offsets;
})();

export function resolveDropCollision({
  x,
  y,
  w,
  h,
  occupied,
  gap = DROP_COLLISION_GAP,
  step = DROP_COLLISION_STEP,
  maxRing = DROP_COLLISION_MAX_RING,
}: ResolveDropCollisionInput): { x: number; y: number } {
  const origin = { x, y, w, h };
  if (occupied.every((rect) => !rectsOverlap(origin, rect, gap))) {
    return { x, y };
  }

  const actualMaxRing = Math.min(maxRing, DROP_COLLISION_MAX_RING);
  for (const off of SPIRAL_OFFSETS) {
    if (Math.max(Math.abs(off.dx), Math.abs(off.dy)) > actualMaxRing) continue;
    const box = { x: x + off.dx * step, y: y + off.dy * step, w, h };
    if (occupied.every((rect) => !rectsOverlap(box, rect, gap))) {
      return { x: box.x, y: box.y };
    }
  }

  return { x, y };
}

export function resolvePinnedDropPushAway({
  pinned,
  occupied,
  gap = DROP_COLLISION_GAP,
  step = DROP_COLLISION_STEP,
  maxRing = DROP_COLLISION_MAX_RING,
}: ResolvePinnedDropPushAwayInput): Array<{ id: string; x: number; y: number }> {
  const impacted: CollisionRect[] = [];
  const staticRects: CollisionRect[] = [];
  for (const rect of occupied) {
    if (rectsOverlap(pinned, rect, gap)) {
      impacted.push(rect);
    } else {
      staticRects.push(rect);
    }
  }
  if (impacted.length === 0) return [];
  const placed: CollisionRect[] = [pinned, ...staticRects];

  impacted.sort((a, b) => {
    const adx = a.x - pinned.x;
    const ady = a.y - pinned.y;
    const bdx = b.x - pinned.x;
    const bdy = b.y - pinned.y;
    return adx * adx + ady * ady - (bdx * bdx + bdy * bdy) || a.y - b.y || a.x - b.x;
  });

  const moved: Array<{ id: string; x: number; y: number }> = [];
  for (const rect of impacted) {
    const next = resolveDropCollision({
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      occupied: placed,
      gap,
      step,
      maxRing,
    });
    placed.push({ ...rect, x: next.x, y: next.y });
    moved.push({ id: rect.id, x: next.x, y: next.y });
  }

  return moved;
}
