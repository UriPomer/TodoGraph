import { useEffect, useRef, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import type { Task } from '@todograph/shared';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTaskStore } from '@/stores/useTaskStore';

interface Props {
  task: Task;
  recommended?: boolean;
  dependencyInfo?: { undone: number; total: number; parentTitles: string[] };
}

/**
 * 极简任务行（参考 ref.PNG）：
 * - 无卡片边框/背景，仅靠空白与分组呈现
 * - 左侧单个状态圆点：todo=空心 / doing=中心点 / done=实心 + 勾
 * - done 状态整行灰化 + 标题 line-through
 * - 优先级/删除按钮只在 hover 时浮现
 */
export function TaskItem({ task, recommended, dependencyInfo }: Props) {
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const updateTask = useTaskStore((s) => s.updateTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const t = draft.trim();
    if (t && t !== task.title) updateTask(task.id, { title: t });
    else setDraft(task.title);
    setEditing(false);
  };

  return (
    <li
      data-task-id={task.id}
      className={cn(
        'group flex items-center gap-3 rounded-md px-2 py-1.5',
        'transition-colors duration-150',
        'hover:bg-accent/40',
        task.status === 'done' && 'text-muted-foreground',
      )}
    >
      <StatusDot
        status={task.status}
        recommended={recommended}
        onClick={() => toggleStatus(task.id)}
      />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(task.title);
              setEditing(false);
            }
          }}
          className="flex-1 min-w-0 bg-transparent text-sm outline-none"
        />
      ) : (
        <span
          onDoubleClick={() => setEditing(true)}
          className={cn(
            'flex-1 min-w-0 truncate text-sm cursor-text',
            task.status === 'done' && 'line-through',
          )}
          title="双击编辑"
        >
          {task.title}
        </span>
      )}

      {dependencyInfo && dependencyInfo.total > 0 && (
        <span
          className="text-[11px] text-muted-foreground/80 whitespace-nowrap"
          title={dependencyInfo.parentTitles.map((t) => '• ' + t).join('\n')}
        >
          {dependencyInfo.undone > 0
            ? `${dependencyInfo.undone}/${dependencyInfo.total}`
            : `✓${dependencyInfo.total}`}
        </span>
      )}

      {/* 优先级 & 删除：hover 或 focus 时浮现，保持视觉纯净 */}
      <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <Select
          value={String(task.priority ?? 2)}
          onValueChange={(v) => updateTask(task.id, { priority: Number(v) })}
        >
          <SelectTrigger className="h-6 w-[56px] text-[11px] border-transparent bg-transparent hover:bg-accent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="3">高</SelectItem>
            <SelectItem value="2">中</SelectItem>
            <SelectItem value="1">低</SelectItem>
          </SelectContent>
        </Select>

        <button
          onClick={() => {
            if (confirm(`删除任务 "${task.title}"?`)) deleteTask(task.id);
          }}
          className={cn(
            'shrink-0 text-muted-foreground rounded p-1',
            'transition-[color,transform,background-color] duration-150 ease-out',
            'hover:text-destructive hover:bg-destructive/10 active:scale-90',
          )}
          title="删除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

/** 状态圆点：三态极简视觉。 */
function StatusDot({
  status,
  recommended,
  onClick,
}: {
  status: Task['status'];
  recommended?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
        'transition-[transform,box-shadow] duration-150 ease-out',
        'hover:scale-110 active:scale-90',
        // 推荐项：细微的成功色光晕
        recommended && 'shadow-[0_0_0_2px_hsl(var(--success)/0.25)]',
      )}
      title="点击切换状态 todo → doing → done"
    >
      {/* 外圈 */}
      <span
        className={cn(
          'absolute inset-0 rounded-full border',
          status === 'todo' && 'border-muted-foreground/55',
          status === 'doing' && 'border-[hsl(var(--primary))]',
          status === 'done' && 'border-transparent bg-muted-foreground/70',
        )}
      />
      {/* doing：中心实点 */}
      {status === 'doing' && (
        <span className="relative h-[7px] w-[7px] rounded-full bg-[hsl(var(--primary))]" />
      )}
      {/* done：白色勾 */}
      {status === 'done' && (
        <Check className="relative h-3 w-3 text-[hsl(var(--card))]" strokeWidth={3} />
      )}
    </button>
  );
}
