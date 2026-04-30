import { memo } from 'react';
import { type NodeProps } from '@xyflow/react';

export interface MergeGhostData extends Record<string, unknown> {
  /** 被拖节点的标题（A） */
  dragTitle: string;
  /** 目标节点的标题（B）—— 松手后会成为 A 的父节点 */
  targetTitle: string;
  /** 目标是否已经是 group */
  targetIsGroup: boolean;
}

/**
 * 拖拽合并预览 —— ghost 节点。
 * 效果：虚线框 + 从中心向外「扩张」一次（spring），然后轻微呼吸，
 *       提示"松手即生效"。覆盖在 B 上，B 本体略降亮度。
 */
function MergeGhostImpl({ data }: NodeProps) {
  const d = data as MergeGhostData;
  // 文案精准反映真实语义：B 会成为 A 的父节点
  const hint = d.targetIsGroup
    ? `加入「${d.targetTitle}」`
    : `「${d.targetTitle}」成为父节点`;
  return (
    <div
      className="merge-ghost pointer-events-none h-full w-full rounded-xl border-2 border-dashed border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)] shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
    >
      <div className="absolute -top-3 left-3 rounded-md border border-[hsl(var(--primary))] bg-card px-2 py-0.5 text-xs font-medium text-[hsl(var(--primary))] shadow-sm">
        {hint}
      </div>
    </div>
  );
}

export const MergeGhostNode = memo(MergeGhostImpl);
