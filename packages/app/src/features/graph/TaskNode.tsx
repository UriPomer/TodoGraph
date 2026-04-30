import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/useTaskStore';
import type { TaskStatus } from '@todograph/shared';

export interface TaskNodeData extends Record<string, unknown> {
  title: string;
  status: TaskStatus;
  priority?: number;
  ready?: boolean;
  recommended?: boolean;
  description?: string;
  /** 是否是拖拽合并的目标节点 —— ghost overlay 会覆盖在上面 */
  isMergeTarget?: boolean;
  /** 候选态：timer 正在计时 —— 虚线外框预警，未满 500ms 松手不会真正合并 */
  isMergePending?: boolean;
}

function TaskNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as TaskNodeData;
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const updateTask = useTaskStore((s) => s.updateTask);

  return (
    <div
      className={cn(
        'group relative flex h-14 w-[180px] items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm',
        'transition-[border-color,box-shadow,transform] duration-150 ease-out',
        'hover:-translate-y-[1px] hover:shadow-md',
        'border-border',
        d.status === 'doing' && 'border-[hsl(var(--primary))]',
        d.status === 'done' && 'opacity-70',
        d.ready && d.status !== 'done' && 'border-[hsl(var(--success))]',
        d.recommended && 'border-[hsl(var(--success))] shadow-[0_0_10px_hsl(var(--success)/0.4)]',
        selected && 'ring-2 ring-[hsl(var(--ring))]',
        // 合并目标：ghost overlay 自己会发光，节点本体只需略微变淡突出 overlay
        d.isMergeTarget && 'opacity-70',
        // 合并候选（timer 运行中）：虚线外框，500ms 内松手不合并
        d.isMergePending && 'outline outline-2 outline-dashed outline-[hsl(var(--primary))] outline-offset-2',
      )}
      title={d.description || undefined}
      onDoubleClick={(e) => {
        // 标题 span 的 dblclick 会 stopPropagation，所以这里只响应"非标题区域"的双击
        e.stopPropagation();
        const cur = d.description ?? '';
        const next = prompt('编辑描述:', cur);
        if (next !== null && next !== cur) {
          updateTask(id, { description: next === '' ? undefined : next });
        }
      }}
    >
      <Handle type="target" position={Position.Left} />

      <button
        className={cn(
          'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
          'transition-[transform] duration-150 ease-out',
          'hover:scale-110 active:scale-90',
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
          'flex-1 min-w-0 truncate text-sm select-none',
          d.status === 'done' && 'line-through text-muted-foreground',
        )}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const t = prompt('编辑标题:', d.title);
          if (t && t.trim() && t !== d.title) updateTask(id, { title: t.trim() });
        }}
        title="双击编辑标题"
      >
        {d.title}
      </span>

      <button
        className={cn(
          'shrink-0 opacity-0 transition-[opacity,color,transform] duration-150 ease-out',
          'group-hover:opacity-60 hover:!opacity-100 hover:text-destructive hover:scale-110 active:scale-90',
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`删除 "${d.title}"?`)) deleteTask(id);
        }}
        title="删除"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const TaskNode = memo(TaskNodeImpl);
