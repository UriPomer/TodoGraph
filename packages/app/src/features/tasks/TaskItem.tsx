import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ChevronDown, FileText, Play, Plus, Trash2 } from 'lucide-react';
import { MAX_HIERARCHY_DEPTH, normalizeTaskDescription, type Task } from '@todograph/shared';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/LinkifiedText';
import { MAX_TITLE_LENGTH } from '@/lib/measureText';
import { useTaskStore } from '@/stores/useTaskStore';
import { toast } from '@/components/ui/toaster-store';
import { dialog } from '@/components/ui/dialog-store';
import { useTaskItemGestures, type TaskDragPoint, type TaskDragStart } from './useTaskItemGestures';
import { TaskStatusControl } from './TaskStatusControl';

export type { TaskDragPoint, TaskDragStart } from './useTaskItemGestures';
type DescriptionMode = 'closed' | 'viewing' | 'editing';

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 1023px)').matches;
}

interface Props {
  task: Task;
  dependencyInfo?: { undone: number; total: number; parentTitles: string[] };
  /** 层级缩进深度，0 = 顶层 */
  depth?: number;
  /** 是否有子节点 */
  hasChildren?: boolean;
  /** 当前是否折叠 */
  isCollapsed?: boolean;
  /** 折叠/展开切换回调 */
  onToggleCollapse?: (taskId: string) => void;
  /** 当前是否正在被拖拽 */
  isDragging?: boolean;
  /** 专用把手的 pointerdown 拖拽开始回调 */
  onDragStart?: (event: TaskDragStart, task: Task) => void;
  onDragMove?: (event: TaskDragPoint) => void;
  onDragEnd?: (pointerId: number) => void;
  onDragCancel?: (pointerId: number) => void;
  /** 添加子任务；仅在 depth < MAX-1 时传入才显示按钮 */
  onAddChild?: (parentId: string, title: string) => boolean;
}

function caretOffsetFromPoint(element: HTMLElement, clientX: number, clientY: number) {
  const ownerDocument = element.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
  const fallbackRange = caret ? null : ownerDocument.caretRangeFromPoint?.(clientX, clientY);
  const node = caret?.offsetNode ?? fallbackRange?.startContainer;
  const offset = caret?.offset ?? fallbackRange?.startOffset;
  if (node && offset !== undefined && element.contains(node)) {
    const range = ownerDocument.createRange();
    range.selectNodeContents(element);
    range.setEnd(node, offset);
    return range.toString().length;
  }
  const rect = element.getBoundingClientRect();
  const ratio = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 1;
  return Math.round((element.textContent?.length ?? 0) * ratio);
}

/**
 * 极简任务行（参考 ref.PNG）：
 * - 无卡片边框/背景，仅靠空白与分组呈现
 * - 桌面端拖动任务行、触屏长按拖起；状态圆点：todo=空心 / doing=中心点 / done=实心 + 勾
 * - done 状态整行灰化 + 标题 line-through
 * - 子任务、描述和删除按钮在行尾集中显示
 *
 * 用 memo 包住：ListView 每次 store 变化都会重排列表，但对于未变动的行
 * props 引用相同时跳过重渲染，避免大列表下 input 输入卡顿。
 */
export const TaskItem = memo(function TaskItem({ task, dependencyInfo, depth = 0, hasChildren, isCollapsed, onToggleCollapse, isDragging, onDragStart, onDragMove, onDragEnd, onDragCancel, onAddChild }: Props) {
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const completeTask = useTaskStore((s) => s.completeTask);
  const updateTask = useTaskStore((s) => s.updateTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const description = normalizeTaskDescription(task.description);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [descriptionMode, setDescriptionMode] = useState<DescriptionMode>('closed');
  const [descDraft, setDescDraft] = useState(description ?? '');
  const [addingChild, setAddingChild] = useState(false);
  const [childDraft, setChildDraft] = useState('');
  const rowRef = useRef<HTMLLIElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editCaretRef = useRef<number | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const input = inputRef.current;
      input?.focus();
      const caret = editCaretRef.current ?? input?.value.length ?? 0;
      input?.setSelectionRange(caret, caret);
      editCaretRef.current = null;
    }
  }, [editing]);

  useEffect(() => setDescDraft(description ?? ''), [description]);
  useEffect(() => {
    if (descriptionMode === 'editing') descRef.current?.focus();
  }, [descriptionMode]);

  const beginTitleEditing = useCallback((element: HTMLElement, clientX: number, clientY: number) => {
    window.getSelection()?.removeAllRanges();
    editCaretRef.current = caretOffsetFromPoint(element, clientX, clientY);
    setDraft(task.title);
    setEditing(true);
  }, [task.title]);

  const commit = () => {
    const t = draft.trim();
    if (t && t !== task.title) updateTask(task.id, { title: t });
    else setDraft(task.title);
    setEditing(false);
  };

  const commitDesc = () => {
    const normalized = normalizeTaskDescription(descDraft);
    const current = useTaskStore.getState().nodes.find((node) => node.id === task.id)?.description;
    if (normalized !== current) updateTask(task.id, { description: normalized });
  };
  const commitChild = () => {
    const title = childDraft.trim();
    if (!title) setAddingChild(false);
    else if (onAddChild?.(task.id, title)) {
      setChildDraft('');
      setAddingChild(false);
    }
  };

  const { swipeLayerRef, progressHintRef, deleteHintRef } = useTaskItemGestures({
    task,
    rowRef,
    beginTitleEditing,
    toggleStatus,
    completeTask,
    deleteTask,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
  });
  const onRowPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!onDragStart || !event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, textarea')) return;
    if (target.closest('[data-task-title]')) return;
    const sourceElement = event.currentTarget.closest('[data-task-id]') as HTMLElement | null;
    if (!sourceElement) return;
    const dragSurface = event.currentTarget;
    const start = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
      sourceElement,
      activateImmediately: false,
    };
    dragSurface.setPointerCapture?.(event.pointerId);
    onDragStart(start, task);
  }, [onDragStart, task]);

  const onRowPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    onDragMove?.({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
  }, [onDragMove]);

  const onRowPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDragEnd?.(event.pointerId);
  }, [onDragEnd]);

  const onRowPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDragCancel?.(event.pointerId);
  }, [onDragCancel]);

  return (
    <li
      ref={rowRef}
      data-task-id={task.id}
      className={cn(
        'mobile-task-row group relative -mx-4 flex flex-col px-4 select-none [content-visibility:auto] [contain-intrinsic-size:auto_52px] max-lg:-mx-3 max-lg:px-3',
        'transition-colors duration-200',
        'lg:hover:bg-foreground/[0.035]',
        isDragging && 'opacity-25 lg:scale-[0.98]',
        task.status === 'done' && !isDragging && 'text-muted-foreground',
      )}
    >
      {([[task.status === 'todo' ? 'start' : 'complete', progressHintRef, task.status === 'todo' ? Play : Check], ['delete', deleteHintRef, Trash2]] as const).map(([action, ref, Icon]) => (
        <div key={action} ref={ref} data-swipe-action={action} data-active="false" data-armed="false"
          className="mobile-swipe-action" aria-hidden="true">
          <Icon />
        </div>
      ))}
      <div
        ref={swipeLayerRef}
        className="relative flex flex-col will-change-transform"
        style={{ paddingLeft: `${4 + depth * 16}px` }}
      >
      <div
        data-task-drag-surface="true"
        className="task-row__surface items-center gap-2 py-1.5 pr-2 lg:cursor-grab lg:active:cursor-grabbing max-lg:min-h-[44px]"
        onPointerDown={onRowPointerDown}
        onPointerMove={onRowPointerMove}
        onPointerUp={onRowPointerUp}
        onPointerCancel={onRowPointerCancel}
        onLostPointerCapture={onRowPointerCancel}
      >
      {/* 折叠/展开按钮 */}
      {hasChildren && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse?.(task.id);
          }}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded lg:hover:bg-foreground/5 transition-colors"
          title={isCollapsed ? '展开' : '折叠'}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      )}

      {!hasChildren && <span aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />}
      <TaskStatusControl id={task.id} status={task.status} title={task.title} />

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
              setDraft(task.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent pb-0.5 text-sm outline-none"
        />
      ) : (
        <div data-task-title-slot="true" className="min-w-0 flex-1">
          <span
            data-task-title="true"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              beginTitleEditing(event.currentTarget, event.clientX, event.clientY);
            }}
            className={cn(
              'inline-block max-w-full touch-manipulation whitespace-normal [overflow-wrap:anywhere] align-middle text-sm cursor-text select-text',
              task.status === 'done' && 'line-through',
            )}
            title={`${task.title}（双击编辑）`}
            aria-label={`${task.title}，双击编辑`}
          >
            <LinkifiedText text={task.title} />
          </span>
        </div>
      )}

      {dependencyInfo && dependencyInfo.undone > 0 && (
        <span
          className="task-row__dependencies text-xs text-muted-foreground/80 whitespace-nowrap"
          title={`还有 ${dependencyInfo.undone} 个前置未完成:\n${dependencyInfo.parentTitles.map((t) => '• ' + t).join('\n')}`}
        >
          {dependencyInfo.undone}
        </span>
      )}

      <div className="task-row__actions flex items-center gap-1.5 opacity-60 transition-opacity duration-150 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
        {onAddChild && depth < MAX_HIERARCHY_DEPTH - 1 && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              setAddingChild(true);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground',
              'transition-[color,transform,background-color] duration-150 ease-out',
              'lg:hover:bg-foreground/5 lg:hover:text-[hsl(var(--primary))] active:scale-90',
            )}
            title="添加子任务"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}

        <button
          data-task-action="description"
          onClick={(event) => {
            event.stopPropagation();
            if (descriptionMode === 'editing') {
              commitDesc();
              setDescriptionMode('closed');
            } else if (descriptionMode === 'viewing') {
              setDescriptionMode('closed');
            } else {
              setDescriptionMode(isMobileViewport() && description ? 'viewing' : 'editing');
            }
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (descriptionMode === 'editing') event.preventDefault();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
            if (descriptionMode === 'editing') event.preventDefault();
          }}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            'transition-[color,transform,background-color] duration-150 ease-out lg:hover:bg-foreground/5 active:scale-90',
            description ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground',
          )}
          title={description ? '查看/编辑描述' : '添加描述'}
        >
          <FileText className="h-3.5 w-3.5" />
        </button>

        <button
          data-mobile-hidden-action="delete"
          onClick={async () => {
            const confirmed = await dialog.confirm(`删除「${task.title}」`, {
              description: '删除后可从撤销 toast 恢复',
              danger: true,
            });
            if (!confirmed) return;
            deleteTask(task.id);
            toast.action('已删除', '撤销', () => useTaskStore.getState().undo(), task.title);
          }}
          className={cn(
            'ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground max-lg:hidden',
            'transition-[color,transform,background-color] duration-150 ease-out',
            'lg:hover:bg-foreground/5 lg:hover:text-destructive active:scale-90 max-lg:min-h-[28px] max-lg:min-w-[28px]',
          )}
          title="删除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>

      {addingChild && onAddChild && (
        <div className="task-row__child-editor flex items-center gap-2 pb-2 pr-2">
          <Plus className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--primary))]" />
          <input
            autoFocus
            value={childDraft}
            placeholder="输入子任务名称…"
            maxLength={MAX_TITLE_LENGTH}
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => setChildDraft(event.target.value)}
            onBlur={commitChild}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitChild();
              } else if (event.key === 'Escape') {
                setChildDraft('');
                setAddingChild(false);
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-lg border border-[hsl(var(--primary)/0.4)] bg-background px-3 text-sm outline-none focus:border-[hsl(var(--primary))]"
          />
        </div>
      )}

      {descriptionMode === 'editing' && (
        <div className="task-row__details pb-2 pr-2" onMouseDown={(event) => event.stopPropagation()}>
          <textarea
            ref={descRef}
            value={descDraft}
            onChange={(event) => setDescDraft(event.target.value)}
            onBlur={commitDesc}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDescDraft(description ?? '');
                setDescriptionMode('closed');
              }
            }}
            rows={2}
            placeholder="添加描述..."
            className="w-full resize-none border-0 border-l-2 border-[hsl(var(--primary)/0.35)] bg-transparent px-2 py-1 !text-xs font-normal !leading-4 tracking-normal text-muted-foreground outline-none placeholder:text-muted-foreground/45 focus:border-[hsl(var(--primary)/0.7)]"
          />
        </div>
      )}

      {descriptionMode === 'viewing' && description && (
        <div className="task-row__details pb-2 pr-2" onMouseDown={(event) => event.stopPropagation()}>
          <p
            data-task-description-view="true"
            role="button"
            tabIndex={0}
            className="w-full whitespace-pre-wrap break-words border-l-2 border-[hsl(var(--primary)/0.35)] px-2 py-1 text-xs font-normal leading-4 tracking-normal text-muted-foreground select-text"
            onClick={(event) => {
              event.stopPropagation();
              setDescDraft(description);
              setDescriptionMode('editing');
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.stopPropagation();
              setDescDraft(description);
              setDescriptionMode('editing');
            }}
          >
            <LinkifiedText text={description} />
          </p>
        </div>
      )}

      {descriptionMode === 'closed' && description && (
        <p className="task-row__details pb-1 pr-2 text-[11px] font-normal leading-4 tracking-normal text-muted-foreground/75 line-clamp-1 max-lg:hidden lg:text-xs">
          <LinkifiedText text={description} />
        </p>
      )}
      </div>
    </li>
  );
});
