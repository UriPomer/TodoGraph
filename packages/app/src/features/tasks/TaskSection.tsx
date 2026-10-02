import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Task } from '@todograph/shared';
import { TaskItem, type TaskDragPoint, type TaskDragStart } from './TaskItem';
import type { DepInfo, FlatItem } from './listModel';

interface TaskSectionProps {
  title: string;
  mobileKey: 'ready' | 'blocked' | 'done';
  hint?: string;
  items: FlatItem[];
  depInfo: Map<string, DepInfo>;
  childMap: Map<string, Task[]>;
  collapsed: Record<string, boolean>;
  onToggleCollapse: (id: string) => void;
  drag: { taskId: string | null; start: (event: TaskDragStart, task: Task) => void; move: (event: TaskDragPoint) => void; end: (pointerId: number) => void; cancel: (pointerId: number) => void };
  onAddChild?: (parentId: string, title: string) => boolean;
  empty?: string;
  sectionCollapsed?: boolean;
  onToggleSection?: () => void;
}

export function TaskSection({ title, mobileKey, hint, items, depInfo, childMap, collapsed, onToggleCollapse, drag, onAddChild, empty, sectionCollapsed = false, onToggleSection }: TaskSectionProps) {
  const visibleIds = new Set(items.map(({ task }) => task.id));
  const heading = <><span>{title}</span><span className="inline-flex px-1 text-[10px] font-medium leading-none text-[hsl(var(--success))] lg:hidden">{items.length}</span>{hint && <span className="text-[10px] normal-case tracking-normal text-muted-foreground/70 max-lg:ml-auto">{hint}</span>}</>;

  return (
    <section data-mobile-task-section={mobileKey} className="mt-5 first:mt-6 max-lg:mt-4 max-lg:pt-1">
      <h3 className="mb-1 flex items-baseline gap-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/75 max-lg:mb-1 max-lg:h-7 max-lg:items-center max-lg:px-1 max-lg:tracking-[0.08em]">
        {onToggleSection ? <button type="button" className="flex w-full items-center gap-2 text-left" aria-expanded={!sectionCollapsed} aria-label={sectionCollapsed ? '展开已完成任务' : '折叠已完成任务'} onClick={onToggleSection}>
          {sectionCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}{heading}
        </button> : heading}
      </h3>
      {!sectionCollapsed && (items.length === 0 ? <p className="px-3 py-1.5 text-xs italic text-muted-foreground/55 max-lg:px-1">{empty ?? '空'}</p> : (
        <ul className="flex flex-col gap-y-1">{items.map(({ task, depth }) => <TaskItem
          key={task.id}
          task={task}
          dependencyInfo={depInfo.get(task.id)}
          depth={depth}
          hasChildren={childMap.get(task.id)?.some(({ id }) => visibleIds.has(id)) ?? false}
          isCollapsed={collapsed[task.id]}
          onToggleCollapse={onToggleCollapse}
          isDragging={task.id === drag.taskId}
          onDragStart={drag.start}
          onDragMove={drag.move}
          onDragEnd={drag.end}
          onDragCancel={drag.cancel}
          onAddChild={onAddChild}
        />)}</ul>
      ))}
    </section>
  );
}
