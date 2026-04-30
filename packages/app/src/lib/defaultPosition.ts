import type { Task } from '@todograph/shared';
import {
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_H,
} from '@/features/graph/computeGroupSize';

/**
 * 新任务的默认落位策略。
 *
 * - 带 parentId：在父框内，叠在已有兄弟节点下方（最底的 maxY + 间距）。
 *   x 固定为 GROUP_PADDING_X（左对齐），y 累加。
 * - 无 parentId：以视口中心为锚，偏半个节点使视觉居中。
 * - 无视口信息：回落到 (200, 120)，避免扎堆 (0,0)。
 */
export function defaultPositionFor(params: {
  parentId?: string;
  nodes: Task[];
  viewportCenter: { x: number; y: number } | null;
}): { x: number; y: number } {
  if (params.parentId) {
    const siblings = params.nodes.filter((n) => n.parentId === params.parentId);
    // 底部兄弟的底边 —— 或初始 GROUP_PADDING_Y
    let maxBottom = GROUP_PADDING_Y;
    for (const s of siblings) {
      const b = (s.y ?? 0) + CHILD_DEFAULT_H;
      if (b > maxBottom) maxBottom = b;
    }
    return { x: GROUP_PADDING_X, y: maxBottom + 12 };
  }
  if (params.viewportCenter) {
    // 90x28 = 半个 180x56 节点
    return { x: params.viewportCenter.x - 90, y: params.viewportCenter.y - 28 };
  }
  return { x: 200, y: 120 };
}
