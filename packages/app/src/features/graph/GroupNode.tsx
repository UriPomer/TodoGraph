import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/useTaskStore';
import type { TaskStatus } from '@todograph/shared';

export interface GroupNodeData extends Record<string, unknown> {
  title: string;
  status: TaskStatus;
  priority?: number;
  ready?: boolean;
  recommended?: boolean;
  description?: string;
  /** 子节点个数，用于标题徽标显示。 */
  childrenCount: number;
  /** 是否是拖拽合并的目标节点（ghost overlay 覆盖中） */
  isMergeTarget?: boolean;
  /** 合并候选（timer 计时中）：虚线外框预警 */
  isMergePending?: boolean;
  /** 子节点拖离父框超过阈值 —— 即将 ungroup 的警告态 */
  isUngroupWarn?: boolean;
}

/**
 * 父任务节点（compound 容器）。
 *
 * 布局约定（与 GraphView 的 GROUP_PADDING_Y = 60 对齐）：
 *   ┌────────────────────────────┐
 *   │ ●  Title            3 child │  ← 顶部 header card（实心，40px 高）
 *   ├────────────────────────────┤
 *   │                            │
 *   │   [child 1]   [child 2]    │  ← 子节点相对坐标从 (24, 60) 起
 *   │                            │
 *   └────────────────────────────┘
 */
function GroupNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as GroupNodeData;
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const updateTask = useTaskStore((s) => s.updateTask);

  return (
    <div
      className={cn(
        'relative h-full w-full rounded-xl border bg-[hsl(var(--card)/0.55)]',
        'transition-[border-color,box-shadow,opacity] duration-150',
        'border-[hsl(var(--border))]',
        d.status === 'doing' && 'border-[hsl(var(--primary)/0.75)]',
        d.status === 'done' && 'opacity-60',
        d.recommended && 'shadow-[0_0_12px_hsl(var(--success)/0.3)]',
        selected && 'ring-2 ring-[hsl(var(--ring))]',
        // 合并目标：ghost overlay 负责发光，自己只需略降亮度
        d.isMergeTarget && 'opacity-70',
        // 合并候选（timer 运行中）：虚线外框预警
        d.isMergePending && 'outline outline-2 outline-dashed outline-[hsl(var(--primary))] outline-offset-2',
        // ungroup 警告：红色边框 + 抖动（class 在 globals.css）
        d.isUngroupWarn && 'border-[hsl(var(--destructive))] group-ungroup-warn',
      )}
      title={d.description || undefined}
      onDoubleClick={(e) => {
        // 双击 group 的 body 区域编辑描述；header 的 dblclick 会 stopPropagation 走标题编辑
        e.stopPropagation();
        const cur = d.description ?? '';
        const next = prompt('编辑分组描述:', cur);
        if (next !== null && next !== cur) {
          updateTask(id, { description: next === '' ? undefined : next });
        }
      }}
    >
      {/* Handle：复用父节点身份参与依赖连线 */}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* 顶部 Header Card —— 40px 高，占满整行，显示父任务本身的标题/状态 */}
      {/* class group-drag-handle + react-flow 的 dragHandle 机制：只有 header 能拖动 group。
          body 区域拖拽时交给底层的 panOnDrag，避免"拖整个 group 误入他人怀里"。 */}
      <div
        className={cn(
          'group-drag-handle',
          'absolute left-0 right-0 top-0 flex h-10 items-center gap-2 px-3',
          'rounded-t-xl border-b bg-[hsl(var(--card))] shadow-sm cursor-move',
          'border-[hsl(var(--border))]',
          d.status === 'doing' && 'border-b-[hsl(var(--primary)/0.5)]',
        )}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          className={cn(
            'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
            'transition-transform duration-150 hover:scale-110 active:scale-90',
          )}
          onClick={(e) => {
            e.stopPropagation();
            toggleStatus(id);
          }}
          title="切换状态"
        >
          <span
            className={cn(
              'absolute inset-0 rounded-full border',
              d.status === 'todo' && 'border-muted-foreground/60',
              d.status === 'doing' && 'border-[hsl(var(--primary))]',
              d.status === 'done' && 'border-transparent bg-muted-foreground/70',
            )}
          />
          {d.status === 'doing' && (
            <span className="relative h-[7px] w-[7px] rounded-full bg-[hsl(var(--primary))]" />
          )}
          {d.status === 'done' && (
            <Check className="relative h-3 w-3 text-[hsl(var(--card))]" strokeWidth={3} />
          )}
        </button>

        <span
          className={cn(
            'flex-1 min-w-0 truncate text-sm font-medium select-none cursor-text',
            d.status === 'done' && 'line-through text-muted-foreground',
          )}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const t = prompt('编辑分组标题:', d.title);
            if (t && t.trim() && t !== d.title) updateTask(id, { title: t.trim() });
          }}
          title="双击编辑标题"
        >
          {d.title}
        </span>

        <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/80">
          {d.childrenCount}
        </span>
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
