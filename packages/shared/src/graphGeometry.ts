/**
 * 图节点几何常量、碰撞检测、group 尺寸计算。
 *
 * 服务端跨页搬运时也需要知道 group frame 的占位尺寸，
 * 所以保留一份与前端一致的纯函数实现。
 */

export interface CollisionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Uniform-grid broad phase. Query results are candidates only; callers must
 * still use rectsOverlap for the exact check. */
export class CollisionRectIndex {
  private readonly cells = new Map<string, CollisionRect[]>();

  constructor(
    rects: readonly CollisionRect[] = [],
    private readonly cellSize = 256,
  ) {
    for (const rect of rects) this.add(rect);
  }

  add(rect: CollisionRect): void {
    for (const key of this.keysFor(rect)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(rect);
      else this.cells.set(key, [rect]);
    }
  }

  query(rect: Pick<CollisionRect, 'x' | 'y' | 'w' | 'h'>, gap = 0): CollisionRect[] {
    const expanded = {
      x: rect.x - gap,
      y: rect.y - gap,
      w: rect.w + gap * 2,
      h: rect.h + gap * 2,
    };
    const found = new Map<string, CollisionRect>();
    for (const key of this.keysFor(expanded)) {
      for (const candidate of this.cells.get(key) ?? []) found.set(candidate.id, candidate);
    }
    return [...found.values()];
  }

  private keysFor(rect: Pick<CollisionRect, 'x' | 'y' | 'w' | 'h'>): string[] {
    const minX = Math.floor(rect.x / this.cellSize);
    const minY = Math.floor(rect.y / this.cellSize);
    const maxX = Math.floor((rect.x + Math.max(0, rect.w)) / this.cellSize);
    const maxY = Math.floor((rect.y + Math.max(0, rect.h)) / this.cellSize);
    const keys: string[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) keys.push(`${x}:${y}`);
    }
    return keys;
  }
}

export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  gap = 0,
): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

export const GROUP_PADDING_X = 24;
export const GROUP_PADDING_Y = 60;
export const CHILD_DEFAULT_W = 180;
export const CHILD_DEFAULT_H = 56;
export const GROUP_MIN_W = 220;
export const GROUP_MIN_H = 140;

export function computeGroupSize(
  childPositions: Array<{ x: number; y: number; w: number; h: number }>,
): { w: number; h: number } {
  if (childPositions.length === 0) return { w: GROUP_MIN_W, h: GROUP_MIN_H };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of childPositions) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x + c.w > maxX) maxX = c.x + c.w;
    if (c.y + c.h > maxY) maxY = c.y + c.h;
  }
  const left = Math.min(0, minX);
  const top = Math.min(0, minY);
  return {
    w: Math.max(GROUP_MIN_W, maxX - left + GROUP_PADDING_X),
    h: Math.max(GROUP_MIN_H, maxY - top + GROUP_PADDING_Y),
  };
}
