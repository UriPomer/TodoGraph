import { useEffect, useState, type CSSProperties } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import type { TaskStatus } from '@todograph/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toaster-store';
import { useTaskStore } from '@/stores/useTaskStore';
import { cn } from '@/lib/utils';

const labels: Record<TaskStatus, string> = { todo: '未开始', doing: '进行中', done: '已完成' };

export function TaskStatusControl({ id, status, title, graph = false, touchTarget = false }: {
  id: string; status: TaskStatus; title: string; graph?: boolean; touchTarget?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [id, status]);

  const choose = (next: 'todo' | 'done') => {
    setOpen(false);
    const store = useTaskStore.getState();
    const current = store.nodes.find(node => node.id === id);
    if (current?.status !== 'doing') return;
    if (next === 'done' && !store.completeTask(id)) {
      toast.info('无法完成', '该任务下还有未完成的子任务');
      return;
    }
    if (next === 'todo') store.setStatus(id, 'todo');
    toast.action(next === 'done' ? '已完成' : '已回到未开始', '撤销', () => useTaskStore.getState().undo(), current.title);
  };

  const button = <button
    type="button"
    data-status={status}
    aria-label={`${title}：${labels[status]}`}
    title={status === 'doing' ? '选择任务状态' : status === 'todo' ? '开始任务' : '恢复为未开始'}
    className={cn('task-row__status', graph && 'nodrag nopan nowheel')}
    style={graph ? { '--task-status-size': touchTarget ? '44px' : '14px' } as CSSProperties : undefined}
    onPointerDown={event => { event.stopPropagation(); if (event.shiftKey) event.preventDefault(); }}
    onDoubleClick={event => event.stopPropagation()}
    onClick={event => {
      event.stopPropagation();
      if (event.shiftKey || status === 'doing') return;
      const store = useTaskStore.getState();
      if (store.nodes.find(node => node.id === id)?.status === status) store.toggleStatus(id);
    }}
  >
    <span className="task-row__status-ring" />
    {status === 'doing' && <span className="task-row__status-progress" />}
    {status === 'done' && <Check className="task-row__status-check" strokeWidth={3} />}
  </button>;

  if (status !== 'doing') return button;
  return <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
    <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
    <DropdownMenuContent
      align="start" sideOffset={8} collisionPadding={12}
      className="task-status-menu nodrag nopan nowheel z-[1100] w-44 rounded-2xl p-1.5"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onEscapeKeyDown={event => event.stopPropagation()}
    >
      <DropdownMenuItem className="min-h-11 gap-2.5 rounded-xl px-3 text-[13px] focus:bg-foreground/5" onSelect={() => choose('done')}>
        <Check className="h-4 w-4" aria-hidden="true" />标记完成
      </DropdownMenuItem>
      <DropdownMenuItem className="min-h-11 gap-2.5 rounded-xl px-3 text-[13px] text-muted-foreground focus:bg-foreground/5" onSelect={() => choose('todo')}>
        <RotateCcw className="h-4 w-4" aria-hidden="true" />回到未开始
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
