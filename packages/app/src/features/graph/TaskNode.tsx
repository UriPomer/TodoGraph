import { memo, useState, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Trash2, Pencil } from 'lucide-react';
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
  isMergeTarget?: boolean;
  isMergePending?: boolean;
}

function TaskNodeImpl({ id, data, selected }: NodeProps) {
  const d = data as TaskNodeData;
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const updateTask = useTaskStore((s) => s.updateTask);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const t = draft.trim();
    if (t && t !== d.title) updateTask(id, { title: t });
    else setDraft(d.title);
    setEditing(false);
  };

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
        d.isMergeTarget && 'opacity-70',
        d.isMergePending && 'outline outline-2 outline-dashed outline-[hsl(var(--primary))] outline-offset-2',
      )}
    >
      <Handle type="target" position={Position.Left} />

      <button
        className={cn(
          'relative flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full',
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
          <span className="relative h-[5px] w-[5px] rounded-full bg-[hsl(var(--primary))]" />
        )}
        {d.status === 'done' && (
          <Check className="relative h-3 w-3 text-[hsl(var(--card))]" strokeWidth={3} />
        )}
      </button>

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(d.title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-xs outline-none"
        />
      ) : (
        <span
          onDoubleClick={() => {
            setDraft(d.title);
            setEditing(true);
          }}
          className={cn(
            'flex-1 min-w-0 truncate text-xs select-none cursor-text',
            d.status === 'done' && 'line-through text-muted-foreground',
          )}
          title="双击编辑标题"
        >
          {d.title}
        </span>
      )}

      {!editing && (
        <button
          className={cn(
            'shrink-0 opacity-0 transition-[opacity,color,transform] duration-150 ease-out',
            'group-hover:opacity-60 hover:!opacity-100 hover:text-destructive hover:scale-110 active:scale-90',
          )}
          onClick={(e) => {
            e.stopPropagation();
            const cur = d.description ?? '';
            const next = prompt('编辑描述:', cur);
            if (next !== null && next !== cur) {
              updateTask(id, { description: next === '' ? undefined : next });
            }
          }}
          title={d.description ? '编辑描述' : '添加描述'}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}

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
