import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, ChevronDown, FileText, Plus, Trash2 } from 'lucide-react';
import { MAX_HIERARCHY_DEPTH, type Task } from '@todograph/shared';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/LinkifiedText';
import { MAX_TITLE_LENGTH } from '@/lib/measureText';
import { useTaskStore } from '@/stores/useTaskStore';
import { toast } from '@/components/ui/toaster-store';
import { dialog } from '@/components/ui/dialog-store';
import {
  LIST_DOUBLE_TAP_MS,
  LIST_LONG_PRESS_MS,
  LIST_SWIPE_COMMIT_PX,
  LIST_SWIPE_START_PX,
  LIST_TAP_SLOP_PX,
} from './gesturePolicy';

export interface TaskDragStart {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  sourceElement: HTMLElement;
  activateImmediately: boolean;
}

export interface TaskDragPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description ?? '');
  const [addingChild, setAddingChild] = useState(false);
  const [childDraft, setChildDraft] = useState('');
  const rowRef = useRef<HTMLLIElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editCaretRef = useRef<number | null>(null);
  const lastTitleTapRef = useRef<{ at: number } | null>(null);
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

  useEffect(() => {
    // 当 store 的 description 外部变化时同步 draft
    setDescDraft(task.description ?? '');
  }, [task.description]);

  useEffect(() => {
    if (descExpanded) descRef.current?.focus();
  }, [descExpanded]);

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
    const d = descDraft;
    if (d !== (task.description ?? '')) {
      updateTask(task.id, { description: d === '' ? undefined : d });
    }
  };

  const commitChild = () => {
    const title = childDraft.trim();
    if (!title) {
      setAddingChild(false);
      return;
    }
    if (onAddChild?.(task.id, title)) {
      setChildDraft('');
      setAddingChild(false);
    }
  };

  // 移动端只使用这一套 Touch 状态机。浏览器可能因 pan-y 取消 Pointer 流，
  // 因此手机滚动、滑动、双触和长按拖拽不能再分散到 Pointer handlers。
  const swipeLayerRef = useRef<HTMLDivElement>(null);
  const bgRightRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileGestureRef = useRef<
    | { kind: 'idle' }
    | { kind: 'pending'; touchId: number; startX: number; startY: number; lastX: number; lastY: number; titleElement: HTMLElement | null; sourceElement: HTMLElement }
    | { kind: 'scrolling'; touchId: number }
    | { kind: 'swiping'; touchId: number; startX: number; offset: number }
    | { kind: 'dragging'; touchId: number }
  >({ kind: 'idle' });
  const cancelSwipeDOM = useCallback(() => {
    const el = swipeLayerRef.current;
    if (el) {
      el.style.transition = 'transform 0.2s ease-out';
      el.style.transform = 'translateX(0px)';
    }
    if (bgRightRef.current) {
      bgRightRef.current.style.opacity = '0';
      bgRightRef.current.style.backgroundColor = 'transparent';
      bgRightRef.current.textContent = '完成';
    }
  }, []);

  const renderSwipe = useCallback((dx: number) => {
    const mag = Math.max(0, dx);
    const clamped = mag > 100 ? 100 + (mag - 100) * 0.3 : mag;
    const el = swipeLayerRef.current;
    if (el) el.style.transform = `translateX(${clamped}px)`;

    const armed = clamped >= LIST_SWIPE_COMMIT_PX;
    const opacity = Math.min(1, Math.max(0, (clamped - 36) / 60));
    if (bgRightRef.current) {
      bgRightRef.current.style.opacity = String(dx > 0 ? opacity : 0);
      bgRightRef.current.style.backgroundColor = armed && dx > 0 ? 'hsl(var(--success) / 0.12)' : 'transparent';
      bgRightRef.current.textContent = armed && dx > 0 ? '松手完成' : '完成';
    }
    return clamped;
  }, []);

  const finishSwipe = useCallback((offset: number) => {
    cancelSwipeDOM();
    if (offset >= LIST_SWIPE_COMMIT_PX) {
      setTimeout(() => {
        if (task.status === 'done') return;
        if (completeTask(task.id)) {
          toast.action('已完成', '撤销', () => useTaskStore.getState().undo(), task.title);
        } else {
          toast.info('无法完成', '该任务下还有未完成的子任务');
        }
      }, 220);
    }
  }, [cancelSwipeDOM, completeTask, task.id, task.status, task.title]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }, []);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof row.addEventListener !== 'function') return;
    const resetGesture = () => {
      cancelLongPress();
      mobileGestureRef.current = { kind: 'idle' };
    };
    const touchById = (touches: TouchList, touchId: number) =>
      Array.from(touches).find((touch) => touch.identifier === touchId) ?? null;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        const current = mobileGestureRef.current;
        if (current.kind === 'dragging') onDragCancel?.(current.touchId);
        resetGesture();
        cancelSwipeDOM();
        return;
      }
      const target = event.target as HTMLElement;
      const titleElement = target.closest('[data-task-title]') as HTMLElement | null;
      if (target.closest('button, input, textarea') || (target.closest('a') && !titleElement)) return;
      const touch = event.touches[0]!;
      const pending = {
        kind: 'pending' as const,
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        titleElement,
        sourceElement: row,
      };
      mobileGestureRef.current = pending;
      if (!onDragStart) return;
      longPressTimerRef.current = setTimeout(() => {
        const current = mobileGestureRef.current;
        if (current.kind !== 'pending' || current.touchId !== pending.touchId) return;
        longPressTimerRef.current = null;
        cancelSwipeDOM();
        mobileGestureRef.current = { kind: 'dragging', touchId: current.touchId };
        onDragStart({
          pointerId: current.touchId,
          pointerType: 'touch',
          clientX: current.lastX,
          clientY: current.lastY,
          sourceElement: current.sourceElement,
          activateImmediately: true,
        }, task);
      }, LIST_LONG_PRESS_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      const current = mobileGestureRef.current;
      if (current.kind === 'idle') return;
      const touch = touchById(event.touches, current.touchId);
      if (!touch) return;
      if (current.kind === 'dragging') {
        if (event.cancelable) event.preventDefault();
        onDragMove?.({ pointerId: current.touchId, clientX: touch.clientX, clientY: touch.clientY });
        return;
      }
      if (current.kind === 'swiping') {
        if (event.cancelable) event.preventDefault();
        const offset = renderSwipe(touch.clientX - current.startX);
        mobileGestureRef.current = { ...current, offset };
        return;
      }
      if (current.kind === 'scrolling') return;
      const dx = touch.clientX - current.startX;
      const dy = touch.clientY - current.startY;
      if (dx > LIST_SWIPE_START_PX && dx > Math.abs(dy) * 1.35) {
        cancelLongPress();
        const el = swipeLayerRef.current;
        if (el) el.style.transition = 'none';
        const offset = renderSwipe(dx);
        mobileGestureRef.current = { kind: 'swiping', touchId: current.touchId, startX: current.startX, offset };
        if (event.cancelable) event.preventDefault();
        return;
      }
      if (Math.hypot(dx, dy) > LIST_TAP_SLOP_PX) {
        cancelLongPress();
        mobileGestureRef.current = { kind: 'scrolling', touchId: current.touchId };
        return;
      }
      mobileGestureRef.current = { ...current, lastX: touch.clientX, lastY: touch.clientY };
    };
    const onTouchEnd = (event: TouchEvent) => {
      const current = mobileGestureRef.current;
      if (current.kind === 'idle') return;
      cancelLongPress();
      if (current.kind === 'dragging') {
        if (event.cancelable) event.preventDefault();
        onDragEnd?.(current.touchId);
      } else if (current.kind === 'swiping') {
        finishSwipe(current.offset);
      } else if (current.kind === 'pending' && current.titleElement) {
        const now = Date.now();
        const previous = lastTitleTapRef.current;
        if (previous && now - previous.at <= LIST_DOUBLE_TAP_MS) {
          lastTitleTapRef.current = null;
          beginTitleEditing(current.titleElement, current.lastX, current.lastY);
        } else {
          lastTitleTapRef.current = { at: now };
        }
      }
      mobileGestureRef.current = { kind: 'idle' };
    };
    const onTouchCancel = () => {
      const current = mobileGestureRef.current;
      if (current.kind === 'dragging') onDragCancel?.(current.touchId);
      cancelSwipeDOM();
      resetGesture();
    };
    row.addEventListener('touchstart', onTouchStart, { passive: true });
    row.addEventListener('touchmove', onTouchMove, { passive: false });
    row.addEventListener('touchend', onTouchEnd, { passive: false });
    row.addEventListener('touchcancel', onTouchCancel);
    return () => {
      const current = mobileGestureRef.current;
      if (current.kind === 'dragging') onDragCancel?.(current.touchId);
      cancelLongPress();
      row.removeEventListener('touchstart', onTouchStart);
      row.removeEventListener('touchmove', onTouchMove);
      row.removeEventListener('touchend', onTouchEnd);
      row.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [beginTitleEditing, cancelLongPress, cancelSwipeDOM, finishSwipe, onDragCancel, onDragEnd, onDragMove, onDragStart, renderSwipe, task]);

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
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, input, textarea, a, [data-task-title]')) {
          window.getSelection()?.removeAllRanges();
        }
      }}
      data-lens
      className={cn(
        'group relative flex flex-col select-none [content-visibility:auto] [contain-intrinsic-size:auto_52px]',
        'transition-colors duration-200',
        'lg:hover:bg-foreground/[0.035]',
        isDragging && 'opacity-30 scale-[0.98]',
        task.status === 'done' && !isDragging && 'text-muted-foreground',
      )}
    >
      {/* 滑动手势背景指示 — 由 ref 直接操作 DOM，不经过 React */}
      <div ref={bgRightRef} className="absolute inset-y-0 left-0 flex items-center pl-4 text-sm font-semibold text-[hsl(var(--success))] pointer-events-none" style={{ opacity: 0 }}>
        完成
      </div>
      <div
        ref={swipeLayerRef}
        className="relative flex flex-col will-change-transform"
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
      <div
        data-task-drag-surface="true"
        className="flex items-center gap-2 py-1.5 pr-2 lg:cursor-grab lg:active:cursor-grabbing max-lg:min-h-[44px]"
        onPointerDown={onRowPointerDown}
        onPointerMove={onRowPointerMove}
        onPointerUp={onRowPointerUp}
        onPointerCancel={onRowPointerCancel}
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

      {/* spacer 尺寸与 CrossPageReady.tsx 中保持一致 */}
      {!hasChildren && <span className="shrink-0 w-[10px]" />}<StatusDot
        status={task.status}
        onClick={() => {
          if (!toggleStatus(task.id)) {
            toast.info('无法完成', '该任务下还有未完成的子任务');
          } else if (task.status === 'doing') {
            toast.action('已完成', '撤销', () => useTaskStore.getState().undo(), task.title);
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
              setDraft(task.title);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 border-b border-[hsl(var(--primary))] bg-transparent pb-0.5 text-sm outline-none"
        />
      ) : (
        <div data-task-title-slot="true" className="min-w-0 flex-1 overflow-hidden">
          <span
            data-task-title="true"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              beginTitleEditing(event.currentTarget, event.clientX, event.clientY);
            }}
            className={cn(
              'inline-block max-w-full touch-manipulation truncate align-middle text-sm cursor-text select-text',
              task.status === 'done' && 'line-through',
            )}
            title="双击编辑"
          >
            <LinkifiedText text={task.title} className="truncate" />
          </span>
        </div>
      )}

      {dependencyInfo && dependencyInfo.undone > 0 && (
        <span
          className="text-xs text-muted-foreground/80 whitespace-nowrap"
          title={`还有 ${dependencyInfo.undone} 个前置未完成:\n${dependencyInfo.parentTitles.map((t) => '• ' + t).join('\n')}`}
        >
          {dependencyInfo.undone}
        </span>
      )}

      {/* 优先级 & 删除：hover 或 focus 时浮现，保持视觉纯净 */}
      <div className="flex items-center gap-1.5 opacity-60 transition-opacity duration-150 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
        {onAddChild && depth < MAX_HIERARCHY_DEPTH - 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAddingChild(true);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground rounded-lg',
              'transition-[color,transform,background-color] duration-150 ease-out',
              'lg:hover:text-[hsl(var(--primary))] lg:hover:bg-foreground/5 active:scale-90',
            )}
            title="添加子任务"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}

        <button
          data-task-action="description"
          onClick={(e) => {
            e.stopPropagation();
            setDescExpanded((v) => !v);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            'transition-[color,transform,background-color] duration-150 ease-out',
            'lg:hover:bg-foreground/5 active:scale-90',
            task.description ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground',
          )}
          title={task.description ? '查看/编辑描述' : '添加描述'}
        >
          <FileText className="h-3.5 w-3.5" />
        </button>

        <button
          data-mobile-hidden-action="delete"
          onClick={async () => {
            const ok = await dialog.confirm(`删除「${task.title}」`, {
              description: '删除后可从撤销 toast 恢复',
              danger: true,
            });
            if (ok) {
              deleteTask(task.id);
              toast.action('已删除', '撤销', () => useTaskStore.getState().undo(), task.title);
            }
          }}
          className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground rounded-lg ml-1 max-lg:hidden',
            'transition-[color,transform,background-color] duration-150 ease-out',
            'lg:hover:text-destructive lg:hover:bg-foreground/5 active:scale-90',
            'max-lg:min-h-[28px] max-lg:min-w-[28px]',
          )}
          title="删除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>

      {addingChild && onAddChild && (
        <div className="flex items-center gap-2 pb-2 pr-2" style={{ paddingLeft: `${32 + (depth + 1) * 20}px` }}>
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

      {/* 描述展开区：点 FileText 按钮打开，blur 时保存 */}
      {descExpanded && (
        <div
          className="pb-2 pr-2"
          style={{ paddingLeft: `${10 + 14 + 16}px` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <textarea
            ref={descRef}
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={commitDesc}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDescDraft(task.description ?? '');
                setDescExpanded(false);
              }
            }}
            rows={2}
            placeholder="添加描述..."
            className="w-full resize-none border-0 border-l-2 border-[hsl(var(--primary)/0.35)] bg-transparent px-2 py-1 text-base font-normal leading-5 tracking-normal text-muted-foreground outline-none placeholder:text-muted-foreground/45 focus:border-[hsl(var(--primary)/0.7)] lg:text-xs lg:leading-4"
          />
        </div>
      )}

      {/* 折叠态下的单行预览：有描述且未展开时显示 */}
      {!descExpanded && task.description && (
        <p
          className="pb-1 pr-2 text-[11px] font-normal leading-4 tracking-normal text-muted-foreground/75 line-clamp-1 max-lg:hidden lg:text-xs"
          style={{ paddingLeft: `${10 + 14 + 16}px` }}
        >
          <LinkifiedText text={task.description} />
        </p>
      )}
      </div>
    </li>
  );
});

/** 状态圆点：三态极简视觉。 */
function StatusDot({
  status,
  onClick,
}: {
  status: Task['status'];
  onClick: () => void;
}) {
  return (
    <button
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={cn(
        'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full lg:h-7 lg:w-7',
        'transition-[transform,box-shadow] duration-150 ease-out',
        'lg:hover:scale-110 active:scale-90',
      )}
      title="点击切换状态 todo → doing → done"
    >
      {/* 外圈 */}
      <span
        className={cn(
          'h-[14px] w-[14px] rounded-full border',
          status === 'todo' && 'border-muted-foreground/55',
          status === 'doing' && 'border-[hsl(var(--primary))]',
          status === 'done' && 'border-transparent bg-muted-foreground/70',
        )}
      />
      {/* doing：中心实点 */}
      {status === 'doing' && (
        <span className="absolute h-[7px] w-[7px] rounded-full bg-[hsl(var(--primary))]" />
      )}
      {/* done：白色勾 */}
      {status === 'done' && (
        <Check className="absolute h-3 w-3 text-[hsl(var(--card))]" strokeWidth={3} />
      )}
    </button>
  );
}
