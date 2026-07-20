import { memo, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/LinkifiedText';
import { useTaskStore } from '@/stores/useTaskStore';
import { dialog } from '@/components/ui/dialog-store';
import { toast } from '@/components/ui/toaster-store';
import type { TaskStatus } from '@todograph/shared';
import { GroupContentsDialog, type GroupDescendant } from './GroupContentsDialog';
import { centeredDropPosition, isOutsideRect } from './collapsedGroupDrag';
import { TaskStatusButton } from './TaskStatusButton';

export interface GroupNodeData extends Record<string, unknown> {
  title: string;
  status: TaskStatus;
  ready?: boolean;
  recommended?: boolean;
  description?: string;
  /** 子节点个数，用于标题徽标显示。 */
  childrenCount: number;
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
  const rf = useReactFlow();
  const toggleStatus = useTaskStore((s) => s.toggleStatus);
  const updateTask = useTaskStore((s) => s.updateTask);
  const setParent = useTaskStore((s) => s.setParent);
  const [showAll, setShowAll] = useState(false);
  const descendants = d.descendants ?? [];
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const closeAll = useCallback(() => setShowAll(false), []);
  const dragRef = useRef<{
    child: GroupDescendant;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const [childDrag, setChildDrag] = useState(dragRef.current);

  const startChildDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, child: GroupDescendant) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = {
      child,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
    dragRef.current = next;
    setChildDrag(next);
  }, []);

  const moveChildDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const active = current.active || Math.hypot(
      event.clientX - current.startX,
      event.clientY - current.startY,
    ) >= 6;
    const next = { ...current, x: event.clientX, y: event.clientY, active };
    dragRef.current = next;
    setChildDrag(next);
  }, []);

  const finishChildDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = { x: event.clientX, y: event.clientY };
    const rect = rootRef.current?.getBoundingClientRect();
    if (current.active && rect && isOutsideRect(point, rect)) {
      const flowPoint = rf.screenToFlowPosition(point);
      setParent(current.child.id, null, centeredDropPosition(flowPoint, {
        width: current.child.width,
        height: current.child.height,
      }));
    }
    dragRef.current = null;
    setChildDrag(null);
  }, [rf, setParent]);

  const cancelChildDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setChildDrag(null);
  }, []);

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
      ref={rootRef}
      data-lens
      className={cn(
        'relative h-full w-full rounded-xl bg-card',
        'transition-colors duration-200',
        'hover:bg-foreground/3',
        d.status === 'doing' && 'border-[hsl(var(--primary)/0.75)]',
        d.status === 'done' && 'opacity-60',
        d.recommended && 'shadow-[0_0_12px_hsl(var(--success)/0.3)]',
        selected && 'ring-2 ring-[hsl(var(--ring))]',
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
        <TaskStatusButton
          status={d.status}
          className="nodrag nopan"
          onClick={(e) => {
            e.stopPropagation();
            if (toggleStatus(id) && d.status === 'doing') {
              toast.action('已完成', '撤销', () => useTaskStore.getState().undo(), d.title);
            }
          }}
        />

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
          <LinkifiedText text={d.title} className="truncate" compactUrls />
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
                  className="flex min-w-0 items-center rounded-lg border border-border/70 bg-background/55 py-1 pl-2.5 pr-1 shadow-sm"
                  title={child.description || child.title}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <TaskStatusButton
                      status={child.status}
                      touchTarget
                      className="nodrag nopan nowheel"
                      aria-label={`推进 ${child.title} 状态`}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (toggleStatus(child.id) && child.status === 'doing') {
                          toast.action('已完成', '撤销', () => useTaskStore.getState().undo(), child.title);
                        }
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    />
                    <span className={cn('truncate text-xs', child.status === 'done' && 'line-through text-muted-foreground')}>
                      {child.depth > 1 ? `${'·'.repeat(child.depth - 1)} ` : ''}{child.title}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="nodrag nopan nowheel flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-lg text-muted-foreground cursor-grab active:cursor-grabbing lg:h-8 lg:w-8"
                    aria-label={`拖出 ${child.title}`}
                    title="拖出父节点"
                    onPointerDown={(event) => startChildDrag(event, child)}
                    onPointerMove={moveChildDrag}
                    onPointerUp={finishChildDrag}
                    onPointerCancel={cancelChildDrag}
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
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
          onToggleStatus={toggleStatus}
          onClose={closeAll}
        />
      )}

      {childDrag?.active && createPortal(
        <div
          className="pointer-events-none fixed z-[1100] flex items-center gap-2 rounded-lg border border-[hsl(var(--primary)/0.7)] bg-card px-3 py-2 text-sm shadow-xl"
          style={{
            left: childDrag.x,
            top: childDrag.y,
            width: Math.min(childDrag.child.width, 240),
            transform: 'translate(-50%, -50%)',
          }}
        >
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{childDrag.child.title}</span>
        </div>,
        document.body,
      )}
    </div>
  );
}

export const GroupNode = memo(GroupNodeImpl);
