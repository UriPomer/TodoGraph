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
