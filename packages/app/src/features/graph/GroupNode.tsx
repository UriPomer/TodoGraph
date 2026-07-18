import { memo, useCallback, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/LinkifiedText';
import { useTaskStore } from '@/stores/useTaskStore';
import { dialog } from '@/components/ui/dialog-store';
import type { TaskStatus } from '@todograph/shared';
import { GroupContentsDialog, type GroupDescendant } from './GroupContentsDialog';

export interface GroupNodeData extends Record<string, unknown> {
  title: string;
  status: TaskStatus;
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
  isHeightCollapsed?: boolean;
  descendants?: GroupDescendant[];
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
  const [showAll, setShowAll] = useState(false);
  const descendants = d.descendants ?? [];
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const closeAll = useCallback(() => setShowAll(false), []);

  const expandButton = (position: 'top' | 'bottom') => (
    <button
      type="button"
      className={cn(
        'nodrag nopan nowheel absolute left-2 right-2 z-10 flex h-11 items-center justify-center gap-1',
        'rounded-xl bg-foreground/5 text-xs text-muted-foreground transition-colors duration-200',
        'hover:bg-foreground/5 hover:text-foreground active:bg-foreground/10',
        position === 'top' ? 'top-11' : 'bottom-1',
      )}
      onClick={(event) => {
        event.stopPropagation();
        returnFocusRef.current = event.currentTarget;
        setShowAll(true);
      }}
    >
      {position === 'top' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      展开全部 {descendants.length} 个节点
    </button>
  );

  return (
    <div
      data-lens
      className={cn(
        'relative h-full w-full rounded-xl bg-card',
        'transition-colors duration-200',
        'hover:bg-foreground/3',
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
      onDoubleClick={async (e) => {
        e.stopPropagation();
        const cur = d.description ?? '';
        const next = await dialog.prompt('编辑分组描述', { defaultValue: cur, placeholder: '分组描述...' });
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
          'rounded-t-xl bg-card shadow-sm cursor-move',
          d.status === 'doing' && 'shadow-[inset_0_-1px_0_hsl(var(--primary)/0.4)]',
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
            'flex-1 min-w-0 overflow-hidden text-sm font-medium select-none cursor-text',
            d.status === 'done' && 'line-through text-muted-foreground',
          )}
          onDoubleClick={async (e) => {
            e.stopPropagation();
            const t = await dialog.prompt('编辑分组标题', { defaultValue: d.title });
            if (t !== null && t.trim() && t !== d.title) updateTask(id, { title: t.trim() });
          }}
          title="双击编辑标题"
        >
          <LinkifiedText text={d.title} className="truncate" />
        </span>

        <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/80">
          {d.childrenCount}
        </span>
      </div>

      {d.isHeightCollapsed && (
        <>
          {expandButton('top')}
          <div className="group-scroll-viewport nodrag nopan nowheel absolute inset-x-2 bottom-12 top-[92px] touch-pan-y overflow-y-auto overscroll-contain rounded-xl px-1 py-2">
            <div className="grid grid-cols-2 gap-2">
              {descendants.map((child) => (
                <div
                  key={child.id}
                  className="min-w-0 rounded-lg border border-border/70 bg-background/55 px-2.5 py-2 shadow-sm"
                  title={child.description || child.title}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      child.status === 'todo' && 'border border-muted-foreground/70',
                      child.status === 'doing' && 'bg-[hsl(var(--primary))]',
                      child.status === 'done' && 'bg-muted-foreground/60',
                    )} />
                    <span className={cn('truncate text-xs', child.status === 'done' && 'line-through text-muted-foreground')}>
                      {child.depth > 1 ? `${'·'.repeat(child.depth - 1)} ` : ''}{child.title}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {expandButton('bottom')}
        </>
      )}

      {showAll && (
        <GroupContentsDialog
          title={d.title}
          descendants={descendants}
          returnFocus={returnFocusRef.current}
          onClose={closeAll}
        />
      )}
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
