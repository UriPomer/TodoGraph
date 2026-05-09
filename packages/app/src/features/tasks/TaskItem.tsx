import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Check, ChevronRight, ChevronDown, FileText, Plus, Trash2 } from 'lucide-react';
import type { Task } from '@todograph/shared';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/useTaskStore';
import { MAX_HIERARCHY_DEPTH } from '@/stores/useTaskStore';
import { toast } from '@/components/ui/toaster-store';
import { dialog } from '@/components/ui/dialog-store';

interface Props {
  task: Task;
  recommended?: boolean;
  dependencyInfo?: { undone: number; total: number; parentTitles: string[] };
  /** 层级缩进深度，0 = 顶层 */
  depth?: number;
  /** 是否有子节点 */
  hasChildren?: boolean;
  /** 当前是否折叠 */
  isCollapsed?: boolean;
  /** 折叠/展开切换回调 */
  onToggleCollapse?: () => void;
  /** 当前是否正在被拖拽 */
  isDragging?: boolean;
  /** 当前是否是 hover 的 drop target */
  isDropTarget?: boolean;
  /** mousedown 拖拽开始回调 */
  onDragStart?: (e: React.MouseEvent, task: Task) => void;
  /** 添加子任务；仅在 depth < MAX-1 时传入才显示按钮 */
  onAddChild?: (parentId: string) => void;
}

/**
 * 极简任务行（参考 ref.PNG）：
 * - 无卡片边框/背景，仅靠空白与分组呈现
 * - 左侧单个状态圆点：todo=空心 / doing=中心点 / done=实心 + 勾
 * - done 状态整行灰化 + 标题 line-through
 * - 优先级/删除按钮只在 hover 时浮现
 *
 * 用 memo 包住：ListView 每次 store 变化都会重排列表，但对于未变动的行
 * props 引用相同时跳过重渲染，避免大列表下 input 输入卡顿。
 */
export const TaskItem = memo(function TaskItem({ task, recommended, dependencyInfo, depth = 0, hasChildren, isCollapsed, onToggleCollapse, isDragging, isDropTarget, onDragStart, onAddChild }: Props) {
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const updateTask = useTaskStore((s) => s.updateTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    // 当 store 的 description 外部变化时同步 draft
    setDescDraft(task.description ?? '');
  }, [task.description]);

  useEffect(() => {
    if (descExpanded) descRef.current?.focus();
  }, [descExpanded]);

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

  // ===== 移动端滑动手势：纯 DOM 动画，不经过 React 渲染管线 =====
  // touchmove 期间每帧 ~16ms 预算，React reconciliation 太慢，改用 ref 直接操作 DOM
  const swipeLayerRef = useRef<HTMLDivElement>(null);
  const bgRightRef = useRef<HTMLDivElement>(null);
  const bgLeftRef = useRef<HTMLDivElement>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipeOffsetRef = useRef(0); //  touchmove 期间累积偏移，供 touchend 读
  const swipingRef = useRef(false);
  const SWIPE_THRESHOLD = 60;

  const onSwipeStart = useCallback((e: React.TouchEvent) => {
    swipeStartRef.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    swipingRef.current = false;
  }, []);

  const onSwipeMove = useCallback((e: React.TouchEvent) => {
    const start = swipeStartRef.current;
    if (!start) return;
    const dx = e.touches[0]!.clientX - start.x;
    const dy = e.touches[0]!.clientY - start.y;

    if (!swipingRef.current) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        swipingRef.current = true;
        // 首次进入 swipe 态：禁用 CSS transition，防止手指落后于动画
        const el = swipeLayerRef.current;
        if (el) el.style.transition = 'none';
      } else return;
    }

    const mag = Math.abs(dx);
    const clamped = mag > 100 ? 100 + (mag - 100) * 0.3 : mag;
    const offset = dx > 0 ? clamped : -clamped;
    swipeOffsetRef.current = offset;

    // 直接操作 DOM — 不触发 React 渲染
    const el = swipeLayerRef.current;
    if (el) el.style.transform = `translateX(${offset}px)`;

    // 背景指示器也跟着手指淡入
    const opacity = Math.min(1, Math.max(0, (Math.abs(offset) - 20) / 40));
    if (bgRightRef.current) bgRightRef.current.style.opacity = String(dx > 0 ? opacity : 0);
    if (bgLeftRef.current) bgLeftRef.current.style.opacity = String(dx < 0 ? opacity : 0);
  }, []);

  const onSwipeEnd = useCallback(() => {
    swipeStartRef.current = null;
    swipingRef.current = false;
    const offset = swipeOffsetRef.current;
    swipeOffsetRef.current = 0;

    // DOM 驱动的归位动画（CSS transition）
    const el = swipeLayerRef.current;
    if (el) {
      el.style.transition = 'transform 0.2s ease-out';
      el.style.transform = 'translateX(0px)';
    }
    if (bgRightRef.current) bgRightRef.current.style.opacity = '0';
    if (bgLeftRef.current) bgLeftRef.current.style.opacity = '0';

    if (Math.abs(offset) > SWIPE_THRESHOLD) {
      // 等归位动画播完再弹 toast
      setTimeout(() => {
        if (offset > SWIPE_THRESHOLD) {
          if (toggleStatus(task.id)) {
            toast.action('已完成', '撤销', () => useTaskStore.getState().undo());
          } else {
            toast.info('无法完成', '该任务下还有未完成的子任务');
          }
        } else {
          deleteTask(task.id);
          toast.action('已删除', '撤销', () => useTaskStore.getState().undo());
        }
      }, 220);
    }
  }, [toggleStatus, deleteTask, task.id]);

  return (
    <li
      data-task-id={task.id}
      onMouseDown={(e) => {
        if (e.button !== 0) return; // 只响应左键
        onDragStart?.(e, task);
      }}
      onTouchStart={onSwipeStart}
      onTouchMove={onSwipeMove}
      onTouchEnd={onSwipeEnd}
      className={cn(
        'group relative flex flex-col rounded-md select-none overflow-hidden',
        'transition-colors duration-150',
        'hover:bg-accent/40',
        isDragging && 'opacity-30 scale-[0.98]',
        isDropTarget && 'bg-primary/10 border-l-2 border-primary',
        task.status === 'done' && !isDragging && 'text-muted-foreground',
      )}
    >
      {/* 滑动手势背景指示 — 由 ref 直接操作 DOM，不经过 React */}
      <div ref={bgRightRef} className="absolute inset-y-0 left-0 flex items-center pl-4 text-sm font-semibold text-[hsl(var(--success))] pointer-events-none" style={{ opacity: 0 }}>
        完成
      </div>
      <div ref={bgLeftRef} className="absolute inset-y-0 right-0 flex items-center pr-4 text-sm font-semibold text-destructive pointer-events-none" style={{ opacity: 0 }}>
        删除
      </div>

      <div
        ref={swipeLayerRef}
        className="relative flex flex-col will-change-transform"
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
      <div className="flex items-center gap-2 py-1.5 pr-2 max-lg:min-h-[44px]">
      {/* 折叠/展开按钮 */}
      {hasChildren && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse?.();
          }}
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded hover:bg-accent transition-colors"
          title={isCollapsed ? '展开' : '折叠'}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      )}

      {!hasChildren && <span className="shrink-0 w-[10px]" />}<StatusDot
        status={task.status}
        recommended={recommended}
        onClick={() => {
          if (!toggleStatus(task.id)) {
            toast.info('无法完成', '该任务下还有未完成的子任务');
          }
        }}
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

      {dependencyInfo && dependencyInfo.undone > 0 && (
        <span
          className="text-[11px] text-muted-foreground/80 whitespace-nowrap"
          title={`还有 ${dependencyInfo.undone} 个前置未完成:\n${dependencyInfo.parentTitles.map((t) => '• ' + t).join('\n')}`}
        >
          {dependencyInfo.undone}
        </span>
      )}

      {/* 优先级 & 删除：hover 或 focus 时浮现，保持视觉纯净 */}
      <div className="flex items-center gap-1.5 opacity-60 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        {onAddChild && depth < MAX_HIERARCHY_DEPTH - 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(task.id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className={cn(
              'shrink-0 text-muted-foreground rounded p-1',
              'transition-[color,transform,background-color] duration-150 ease-out',
              'hover:text-[hsl(var(--primary))] hover:bg-accent active:scale-90',
            )}
            title="添加子任务"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation();
            setDescExpanded((v) => !v);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            'shrink-0 rounded p-1',
            'transition-[color,transform,background-color] duration-150 ease-out',
            'hover:bg-accent active:scale-90',
            task.description ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground',
          )}
          title={task.description ? '查看/编辑描述' : '添加描述'}
        >
          <FileText className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={async () => {
            const ok = await dialog.confirm(`删除「${task.title}」`, {
              description: '删除后可从撤销 toast 恢复',
              danger: true,
            });
            if (ok) deleteTask(task.id);
          }}
          className={cn(
            'shrink-0 text-muted-foreground rounded p-1.5 ml-1',
            'transition-[color,transform,background-color] duration-150 ease-out',
            'hover:text-destructive hover:bg-destructive/10 active:scale-90',
            'max-lg:min-h-[28px] max-lg:min-w-[28px]',
          )}
          title="删除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>

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
            rows={3}
            placeholder="添加描述..."
            className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-[hsl(var(--primary))]"
          />
        </div>
      )}

      {/* 折叠态下的单行预览：有描述且未展开时显示 */}
      {!descExpanded && task.description && (
        <p
          className="pb-1 pr-2 text-[11px] text-muted-foreground/80 line-clamp-1"
          style={{ paddingLeft: `${10 + 14 + 16}px` }}
        >
          {task.description}
        </p>
      )}
      </div>
    </li>
  );
});

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
        'relative flex shrink-0 items-center justify-center rounded-full h-[14px] w-[14px]',
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
