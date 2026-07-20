import { memo, useState, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Trash2, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/LinkifiedText';
import { useTaskStore } from '@/stores/useTaskStore';
import { dialog } from '@/components/ui/dialog-store';
import { toast } from '@/components/ui/toaster-store';
import { MAX_TITLE_LENGTH } from '@/lib/measureText';
import type { TaskStatus } from '@todograph/shared';
import { TaskStatusButton } from './TaskStatusButton';

export interface TaskNodeData extends Record<string, unknown> {
  title: string;
  status: TaskStatus;
  ready?: boolean;
  recommended?: boolean;
  description?: string;
  nodeWidth?: number;
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
      data-lens
      className={cn(
        'group relative flex items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-sm',
        'min-h-[56px] min-w-[180px]',
        'transition-colors duration-200',
        'hover:bg-foreground/5',
        'border-border',
        d.status === 'doing' && 'border-[hsl(var(--primary))]',
        d.status === 'done' && 'opacity-70',
        d.ready && d.status !== 'done' && 'border-[hsl(var(--success))]',
        d.recommended && 'border-[hsl(var(--success))] shadow-[0_0_10px_hsl(var(--success)/0.4)]',
        selected && 'ring-2 ring-[hsl(var(--ring))]',
      )}
      style={{ width: d.nodeWidth ?? 180 }}
    >
      <Handle type="target" position={Position.Left} />

      <TaskStatusButton
        status={d.status}
        onClick={(e) => {
          if (e.shiftKey) return;
          e.stopPropagation();
          if (toggleStatus(id) && d.status === 'doing') {
            toast.action('已完成', '撤销', () => useTaskStore.getState().undo(), d.title);
          }
        }}
      />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          maxLength={MAX_TITLE_LENGTH}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(d.title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-sm outline-none"
        />
      ) : (
        <div
          onDoubleClick={(e) => {
            if (e.shiftKey) return;
            setDraft(d.title);
            setEditing(true);
          }}
          onMouseDown={(e) => {
            if (e.shiftKey) e.preventDefault();
          }}
          className={cn(
            'flex-1 min-w-0 text-sm cursor-text select-none',
            d.status === 'done' && 'line-through text-muted-foreground',
          )}
          title="双击编辑标题"
        >
          <LinkifiedText text={d.title} className="whitespace-normal break-words" compactUrls />
        </div>
      )}

      {!editing && (
        <button
          className={cn(
            'shrink-0 opacity-0 transition-[opacity,color,transform] duration-150 ease-out',
            'group-hover:opacity-60 hover:!opacity-100 hover:text-[hsl(var(--primary))] hover:scale-110 active:scale-90',
          )}
          onClick={async (e) => {
            if (e.shiftKey) return;
            e.stopPropagation();
            const next = await dialog.prompt('编辑标题', { defaultValue: d.title });
            if (next !== null && next.trim() && next !== d.title) {
              updateTask(id, { title: next.trim() });
            }
          }}
          title="编辑标题"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}

      <button
        className={cn(
          'shrink-0 opacity-0 transition-[opacity,color,transform] duration-150 ease-out',
          'group-hover:opacity-60 hover:!opacity-100 hover:text-destructive hover:scale-110 active:scale-90',
        )}
        onClick={async (e) => {
          if (e.shiftKey) return;
          e.stopPropagation();
          const ok = await dialog.confirm(`删除「${d.title}」`, { danger: true });
          if (ok) {
            deleteTask(id);
            toast.action('已删除', '撤销', () => useTaskStore.getState().undo(), d.title);
          }
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
