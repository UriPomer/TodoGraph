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

  for (let ring = 1; ring <= maxRing; ring++) {
    const candidates: Array<{ x: number; y: number; d2: number }> = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({
          x: x + dx * step,
          y: y + dy * step,
          d2: dx * dx + dy * dy,
        });
      }
    }
    candidates.sort((a, b) => a.d2 - b.d2 || a.y - b.y || a.x - b.x);
    for (const candidate of candidates) {
      const box = { x: candidate.x, y: candidate.y, w, h };
      if (occupied.every((rect) => !rectsOverlap(box, rect, gap))) {
        return { x: candidate.x, y: candidate.y };
      }
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
  const impacted = occupied.filter((rect) => rectsOverlap(pinned, rect, gap));
  if (impacted.length === 0) return [];

  const impactedIds = new Set(impacted.map((rect) => rect.id));
  const staticRects = occupied.filter((rect) => !impactedIds.has(rect.id));
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
