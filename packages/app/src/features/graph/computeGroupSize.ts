/**
 * 父节点（group）几何常量与尺寸计算。
 *
 * 这些常量从 GraphView 中抽离，便于在多个组件共享，
 * 并让 computeGroupSize 成为一个可单独测试的纯函数。
 */

/** group 内左/右内边距（也用于 pureNormalizeGroupBounds 的左顶对齐目标） */
export const GROUP_PADDING_X = 24;
/** group 内上内边距（顶部要留给 header card） */
export const GROUP_PADDING_Y = 60;
/** 普通子任务节点的默认宽高 —— react-flow 不会主动测量 */
export const CHILD_DEFAULT_W = 180;
export const CHILD_DEFAULT_H = 56;
/** group 的最小宽高（保证空组也能看到 header） */
export const GROUP_MIN_W = 220;
export const GROUP_MIN_H = 140;

/**
 * 计算父节点的理想尺寸：包围所有子节点 + padding。
 * 子节点相对坐标可能为负 —— 同时考虑 min/max 才能算对。
 * 只读 —— 返回尺寸不修改输入。
 */
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
  // 注意：min 为负时，需要把 -min 也纳入宽度；header 顶部需要额外留白
  const left = Math.min(0, minX);
  const top = Math.min(0, minY);
  return {
    w: Math.max(GROUP_MIN_W, maxX - left + GROUP_PADDING_X),
    h: Math.max(GROUP_MIN_H, maxY - top + GROUP_PADDING_Y),
  };
}
