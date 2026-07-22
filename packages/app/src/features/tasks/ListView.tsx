import { useMemo, useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MAX_HIERARCHY_DEPTH, type Task } from '@todograph/shared';
import { buildHierarchyMetrics, useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { toast } from '@/components/ui/toaster-store';
import { defaultPositionFor } from '@/lib/defaultPosition';
import { CrossPageReady, selectCrossPageReadyTasks } from './CrossPageReady';
import { TaskInput } from './TaskInput';
import { TaskItem, type TaskDragPoint, type TaskDragStart } from './TaskItem';
import { buildTaskListModel, type DepInfo, type FlatItem } from './listModel';
import { applyDragAutoScroll, dragAutoScrollDelta, listDropIntentKey, resolveListDropIntent, type ListDropIntent } from './listDrag';
import { nativeFeedback } from '@/platform/nativeInteractions';
type DragState =
  | { taskId: string; pointerId: number; pointerType: string; width: number; offsetX: number; offsetY: number; startX: number; startY: number; active: false }
  | { taskId: string; pointerId: number; pointerType: string; width: number; offsetX: number; offsetY: number; startX: number; startY: number; active: true; x: number; y: number; intent: ListDropIntent }
  | null;
const DRAG_THRESHOLD_PX = 8;
const LIST_MOVE_ANIMATION_MS = 220;

function findTaskRow(root: ParentNode, taskId: string) {
  if (typeof root.querySelectorAll !== 'function') return null;
  return Array.from(root.querySelectorAll<HTMLElement>('[data-task-id]'))
    .find((row) => row.getAttribute('data-task-id') === taskId) ?? null;
}

export function prepareTaskMoveAnimation(root: ParentNode | null, taskId: string) {
  if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const before = findTaskRow(root, taskId)?.getBoundingClientRect();
  if (!before) return () => {};

  return () => requestAnimationFrame(() => {
    const row = findTaskRow(root, taskId);
    if (!row) return;
    const current = row.getBoundingClientRect();
    const deltaX = before.left - current.left;
    const deltaY = before.top - current.top;
    if (deltaX === 0 && deltaY === 0) return;
    row.animate(
      [
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: LIST_MOVE_ANIMATION_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  });
}

/**
 * 极简列表视图（无外层卡片）：
 * - 三段分组：Ready / Blocked / Done
 * - 每一段只靠一个小标题区分，没有框
 * - 任务行本身也没有卡片边框（见 TaskItem）
 * - 支持父子节点层级：子任务缩进显示在其父任务下方，父任务可折叠
 *
 * 性能优化：depInfo 的对象引用做稳定化 —— 签名相同则复用上一次的对象，
 * 这样 TaskItem 的 memo 浅比较才能命中。否则大图拖动时列表全部重绘。
 */
export function ListView() {
  const nodes = useTaskStore((s) => s.nodes);
  const listRevision = useTaskStore((s) => s.listRevision);
  const activePageId = useTaskStore((s) => s.activePageId);
  const allTasks = useWorkspaceStore((s) => s.allTasks);
  const setParent = useTaskStore((s) => s.setParent);
  const ascendOneLevel = useTaskStore((s) => s.ascendOneLevel);
  const reorderTask = useTaskStore((s) => s.reorderTask);
  const moveTaskToSibling = useTaskStore((s) => s.moveTaskToSibling);
  const addTask = useTaskStore((s) => s.addTask);
  const { graph, readySet } = useDerived();
  // Deliberately retain the last semantic snapshot during coordinate-only node updates.
  const semanticNodes = useMemo(() => nodes, [listRevision]);
  const hierarchyMetrics = useMemo(() => buildHierarchyMetrics(semanticNodes), [semanticNodes]);
  const hasCrossPageReady = useMemo(
    () => selectCrossPageReadyTasks(allTasks, activePageId).length > 0,
    [allTasks, activePageId],
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [doneSectionCollapsed, setDoneSectionCollapsed] = useState(true);
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  const updateDrag = useCallback((next: DragState) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const dragTask = useMemo(
    () => (drag ? nodes.find((n) => n.id === drag.taskId) ?? null : null),
    [drag, nodes],
  );
  const depInfoCacheRef = useRef(new Map<string, DepInfo>());
  const listModel = useMemo(
    () => buildTaskListModel(
      semanticNodes,
      { nodes: semanticNodes, edges: graph.edges },
      readySet,
      collapsed,
      depInfoCacheRef.current,
    ),
    [semanticNodes, graph.edges, readySet, collapsed],
  );
  useEffect(() => {
    depInfoCacheRef.current = listModel.depInfo;
  }, [listModel.depInfo]);
  const { ready: readyArr, blocked: blockedArr, done: doneArr, depInfo, childMap } = listModel;
  const toggleCollapse = useCallback((parentId: string) => {
    setCollapsed((prev) => ({ ...prev, [parentId]: !prev[parentId] }));
  }, []);
  const handleAddChild = useCallback(
    (parentId: string, title: string) => {
      const s = useTaskStore.getState();
      if ((hierarchyMetrics.depthById.get(parentId) ?? 0) + 1 >= MAX_HIERARCHY_DEPTH) {
        toast.error(`嵌套不能超过 ${MAX_HIERARCHY_DEPTH} 层`);
        return false;
      }
      const pos = defaultPositionFor({
        parentId,
        nodes: s.nodes,
        viewportCenter: s.viewportCenter,
      });
      addTask({ title, parentId, x: pos.x, y: pos.y });
      setCollapsed((prev) => (prev[parentId] ? { ...prev, [parentId]: false } : prev));
      return true;
    },
    [addTask, hierarchyMetrics],
  );
  const handleDragStart = useCallback((event: TaskDragStart, task: Task) => {
    const rect = event.sourceElement.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const base = {
      taskId: task.id,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      width: rect.width,
      offsetX,
      offsetY,
      startX: event.clientX,
      startY: event.clientY,
    };
    if (event.activateImmediately) nativeFeedback.dragLift(event.pointerType);
    updateDrag(event.activateImmediately
      ? { ...base, active: true, x: event.clientX, y: event.clientY, intent: { kind: 'none' } }
      : { ...base, active: false });
  }, [updateDrag]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const intentAt = useCallback((current: Extract<DragState, { active: true }>, clientX: number, clientY: number) => {
      const targetLi = document.elementFromPoint(clientX, clientY)?.closest('[data-task-id]') as HTMLElement | null;
      const targetId = targetLi?.getAttribute('data-task-id') ?? null;
      const dragged = hierarchyMetrics.byId.get(current.taskId);
      if (!dragged) return { kind: 'none' } as const;
      return resolveListDropIntent({
        startX: current.startX,
        clientX,
        clientY,
        dragged,
        target: targetId ? hierarchyMetrics.byId.get(targetId) ?? null : null,
        targetRect: targetLi?.getBoundingClientRect() ?? null,
        byId: hierarchyMetrics.byId,
        depthById: hierarchyMetrics.depthById,
        subtreeHeightById: hierarchyMetrics.subtreeHeightById,
      });
  }, [hierarchyMetrics]);
  const stableIntentAt = useCallback((current: Extract<DragState, { active: true }>, clientX: number, clientY: number) => {
    const nextIntent = intentAt(current, clientX, clientY);
    if (
      current.intent.kind === 'unparent'
      && nextIntent.kind !== 'reorder'
      && nextIntent.kind !== 'reparent-reorder'
    ) return current.intent;
    return nextIntent;
  }, [intentAt]);

  const autoScrollFrameRef = useRef(0);
  const latestDragPointRef = useRef<TaskDragPoint | null>(null);
  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current) cancelAnimationFrame(autoScrollFrameRef.current);
    autoScrollFrameRef.current = 0;
    latestDragPointRef.current = null;
  }, []);
  const runAutoScroll = useCallback(function tick() {
    autoScrollFrameRef.current = 0;
    const current = dragRef.current;
    const point = latestDragPointRef.current;
    const scroller = scrollRef.current;
    if (!current?.active || !point || !scroller) return;
    const delta = dragAutoScrollDelta(point.clientY, scroller.getBoundingClientRect());
    if (!delta) return;
    if (!applyDragAutoScroll(scroller, delta)) return;
    const intent = stableIntentAt(current, point.clientX, point.clientY);
    nativeFeedback.dropTargetChanged(listDropIntentKey(intent));
    updateDrag({
      ...current,
      x: point.clientX,
      y: point.clientY,
      intent,
    });
    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }, [stableIntentAt, updateDrag]);
  const scheduleAutoScroll = useCallback((point: TaskDragPoint) => {
    latestDragPointRef.current = point;
    const scroller = scrollRef.current;
    if (
      autoScrollFrameRef.current
      || typeof requestAnimationFrame !== 'function'
      || !scroller
      || typeof scroller.getBoundingClientRect !== 'function'
      || !dragAutoScrollDelta(point.clientY, scroller.getBoundingClientRect())
    ) return;
    autoScrollFrameRef.current = requestAnimationFrame(runAutoScroll);
  }, [runAutoScroll]);

  const moveDrag = useCallback((point: TaskDragPoint) => {
    const { pointerId, clientX, clientY } = point;
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    const dx = clientX - current.startX;
    const dy = clientY - current.startY;
    if (!current.active) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      const activated: Extract<DragState, { active: true }> = {
        ...current,
        active: true,
        x: clientX,
        y: clientY,
        intent: { kind: 'none' },
      };
      const intent = intentAt(activated, clientX, clientY);
      nativeFeedback.dragLift(current.pointerType);
      nativeFeedback.dropTargetChanged(listDropIntentKey(intent));
      updateDrag({ ...activated, intent });
      scheduleAutoScroll(point);
      return;
    }
    const intent = stableIntentAt(current, clientX, clientY);
    nativeFeedback.dropTargetChanged(listDropIntentKey(intent));
    updateDrag({ ...current, x: clientX, y: clientY, intent });
    scheduleAutoScroll(point);
  }, [intentAt, scheduleAutoScroll, stableIntentAt, updateDrag]);

  const finishDrag = useCallback((pointerId: number) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== pointerId) return;
    stopAutoScroll();
    if (!current.active) {
      updateDrag(null);
      return;
    }
    if (current.pointerType === 'touch') {
      if (current.intent.kind === 'none') nativeFeedback.dropInvalid();
      else nativeFeedback.dropSuccess();
    }
    const finishMoveAnimation = current.intent.kind !== 'none'
      ? prepareTaskMoveAnimation(scrollRef.current, current.taskId)
      : null;
    flushSync(() => {
      updateDrag(null);
      if (current.intent.kind === 'nest') {
        setParent(current.taskId, current.intent.targetId);
      } else if (current.intent.kind === 'reorder') {
        reorderTask(current.taskId, current.intent.anchorId, current.intent.position, current.intent.storageOrder);
      } else if (current.intent.kind === 'reparent-reorder') {
        moveTaskToSibling(current.taskId, current.intent.anchorId, current.intent.position, current.intent.storageOrder);
      } else if (current.intent.kind === 'unparent') {
        ascendOneLevel(current.taskId);
      }
    });
    finishMoveAnimation?.();
  }, [ascendOneLevel, moveTaskToSibling, reorderTask, setParent, stopAutoScroll, updateDrag]);

  const cancelDrag = useCallback((pointerId: number) => {
    if (dragRef.current?.pointerId !== pointerId) return;
    stopAutoScroll();
    if (dragRef.current?.pointerType === 'touch') nativeFeedback.dragCancel();
    updateDrag(null);
  }, [stopAutoScroll, updateDrag]);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const pullRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pullReady, setPullReady] = useState(false);
  const [focusTrigger, setFocusTrigger] = useState(0);
  const pullReadyRef = useRef(false);
  const PULL_THRESHOLD = 80;
  const PULL_MAX = 112;
  useEffect(() => {
    const el = scrollRef.current;
    const indicator = pullRef.current;
    const content = contentRef.current;
    if (!el || !indicator || !content) return;
    let startY = 0;
    let pulling = false;
    let dist = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (el.scrollTop <= 0) {
        startY = e.touches[0]!.clientY;
        pulling = true;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current) {
        finishPull(false);
        return;
      }
      if (!pulling) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy > 0 && el.scrollTop <= 0) {
        e.preventDefault();
        dist = Math.min(dy * 0.45, PULL_MAX);
        content.style.transition = 'none';
        content.style.transform = `translateY(${dist}px)`;
        indicator.style.transition = 'none';
        indicator.style.opacity = String(Math.min(1, dist / PULL_THRESHOLD));
        indicator.style.transform = `translateY(${dist * 0.4}px)`;
        const over = dist >= PULL_THRESHOLD;
        if (over !== pullReadyRef.current) {
          pullReadyRef.current = over;
          setPullReady(over);
        }
      } else if (dy <= 0) {
        pulling = false;
        dist = 0;
        resetPullDOM(content, indicator);
        pullReadyRef.current = false;
        setPullReady(false);
      }
    };
    const finishPull = (commit: boolean) => {
      if (!pulling) return;
      pulling = false;
      if (commit && dist >= PULL_THRESHOLD) {
        setFocusTrigger((n) => n + 1);
      }
      content.style.transition = 'transform 0.2s ease-out';
      content.style.transform = 'translateY(0px)';
      indicator.style.transition = 'opacity 0.2s, transform 0.2s';
      indicator.style.opacity = '0';
      indicator.style.transform = `translateY(${INIT_INDICATOR_Y}px)`;
      pullReadyRef.current = false;
      setPullReady(false);
    };
    const onTouchEnd = () => finishPull(true);
    const onTouchCancel = () => finishPull(false);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchCancel);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, []);
  const INIT_INDICATOR_Y = -20;
  function resetPullDOM(content: HTMLElement, indicator: HTMLElement) {
    content.style.transition = 'none';
    content.style.transform = 'translateY(0px)';
    indicator.style.transition = 'none';
    indicator.style.opacity = '0';
    indicator.style.transform = `translateY(${INIT_INDICATOR_Y}px)`;
  }

  const [topPct, setTopPct] = useState(() => {
    if (typeof window !== 'undefined') {
      const v = Number(localStorage.getItem('todograph.listSplitTopPct'));
      if (v >= 25 && v <= 85) return v;
    }
    return 65;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const splitPctRef = useRef(topPct);
  const splitRectRef = useRef<DOMRect | null>(null);
  const [splitDragging, setSplitDragging] = useState(false);
  const onSplitPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitRectRef.current = container.getBoundingClientRect();
    setSplitDragging(true);
  }, []);
  const onSplitPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = splitRectRef.current;
    if (!rect || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const pct = Math.max(25, Math.min(85, ((e.clientY - rect.top) / rect.height) * 100));
    splitPctRef.current = pct;
    setTopPct(pct);
  }, []);
  const onSplitPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      localStorage.setItem('todograph.listSplitTopPct', String(Math.round(splitPctRef.current)));
    }
    splitRectRef.current = null;
    setSplitDragging(false);
  }, []);
  const onSplitPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    splitRectRef.current = null;
    setSplitDragging(false);
  }, []);
  const onSplitLostPointerCapture = useCallback(() => {
    splitRectRef.current = null;
    setSplitDragging(false);
  }, []);
  return (
    <div ref={containerRef} className="mobile-list-glass relative h-full flex flex-col">
      {/* 上半部分：当前页任务（可滚动） */}
      <div
        ref={scrollRef}
        className={hasCrossPageReady ? 'overflow-auto' : 'min-h-0 flex-1 overflow-auto'}
        style={{
          height: hasCrossPageReady ? `${topPct}%` : undefined,
          overscrollBehaviorY: 'contain',
          touchAction: 'pan-y',
        }}
      >
        {/* 下拉指示器 */}
        <div
          ref={pullRef}
          className="absolute top-0 left-0 right-0 flex items-center justify-center text-sm text-muted-foreground will-change-transform will-change-[opacity]"
          style={{ height: 60, opacity: 0, transform: 'translateY(-20px)' }}
        >
          <span className={pullReady ? 'text-[hsl(var(--success))] font-semibold' : ''}>
            {pullReady ? '松手新建' : '下拉新建'}
          </span>
        </div>
        <div ref={contentRef} className="will-change-transform w-full px-5 py-5 max-lg:py-3" style={{ transform: 'translateY(0px)' }}>
          <TaskInput focusTrigger={focusTrigger} />

          <Section
            title="Ready"
            mobileKey="ready"
            hint="可执行"
            items={readyArr}
            depInfo={depInfo}
            childMap={childMap}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            dragTaskId={drag?.active ? drag.taskId : null}
            onDragStart={handleDragStart}
            onDragMove={moveDrag}
            onDragEnd={finishDrag}
            onDragCancel={cancelDrag}
            onAddChild={handleAddChild}
            empty="暂无可执行任务"
          />
          <Section
            title="Blocked"
            mobileKey="blocked"
            hint="有未完成的前置"
            items={blockedArr}
            depInfo={depInfo}
            childMap={childMap}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            dragTaskId={drag?.active ? drag.taskId : null}
            onDragStart={handleDragStart}
            onDragMove={moveDrag}
            onDragEnd={finishDrag}
            onDragCancel={cancelDrag}
            onAddChild={handleAddChild}
          />
          <Section
            title="Done"
            mobileKey="done"
            items={doneArr}
            depInfo={depInfo}
            childMap={childMap}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            dragTaskId={drag?.active ? drag.taskId : null}
            onDragStart={handleDragStart}
            onDragMove={moveDrag}
            onDragEnd={finishDrag}
            onDragCancel={cancelDrag}
            onAddChild={handleAddChild}
            sectionCollapsed={doneSectionCollapsed}
            onToggleSection={() => setDoneSectionCollapsed((value) => !value)}
          />
        </div>
      </div>

      {/* 拖动分隔条：移动端可见手柄（12px高 + 中间把手），桌面端细线 */}
      <div
        data-list-split={hasCrossPageReady ? 'adjustable' : 'bottom'}
        data-list-split-dragging={splitDragging ? 'true' : undefined}
        onPointerDown={hasCrossPageReady ? onSplitPointerDown : undefined}
        onPointerMove={hasCrossPageReady ? onSplitPointerMove : undefined}
        onPointerUp={hasCrossPageReady ? onSplitPointerUp : undefined}
        onPointerCancel={hasCrossPageReady ? onSplitPointerCancel : undefined}
        onLostPointerCapture={hasCrossPageReady ? onSplitLostPointerCapture : undefined}
        className={`shrink-0 h-px lg:h-[5px] flex items-center justify-center transition-colors relative group touch-none select-none ${
          splitDragging ? 'bg-[hsl(var(--primary))]' : 'bg-border/30'
        } ${
          hasCrossPageReady
            ? 'cursor-row-resize lg:hover:bg-[hsl(var(--primary))]'
            : 'cursor-default'
        }`}
        title={hasCrossPageReady ? '拖动调整上下高度' : undefined}
      >
        {/* 中间拖拽把手，仅移动端显示 */}
        {hasCrossPageReady && (
          <span className="absolute right-2 top-1/2 flex h-8 w-10 -translate-y-1/2 items-center justify-center rounded-xl border border-border/70 bg-card/85 shadow-md backdrop-blur lg:hidden">
            <span className={`h-1 w-5 rounded-full transition-colors ${splitDragging ? 'bg-[hsl(var(--primary))]' : 'bg-muted-foreground/45'}`} />
          </span>
        )}
      </div>

      {/* 下半部分：其他页面可做（可滚动） */}
      <div className={hasCrossPageReady ? 'flex-1 overflow-auto' : 'hidden'}>
        <div className="w-full px-5">
          <CrossPageReady />
        </div>
      </div>

      {/* Ghost overlay：拖拽激活后跟随鼠标 */}
      {drag?.active && dragTask && createPortal(
        <div
          className="fixed pointer-events-none z-50"
          style={{
            left: drag.pointerType === 'touch' ? 0 : drag.x - drag.offsetX,
            top: drag.y - drag.offsetY,
            width: drag.pointerType === 'touch' ? '100vw' : drag.width,
          }}
        >
          <div className="border-y border-[hsl(var(--primary)/0.28)] bg-card/90 px-5 opacity-95 shadow-[0_12px_36px_hsl(var(--background)/0.38)] backdrop-blur-xl lg:scale-[1.015] lg:rounded-md lg:border lg:border-border lg:bg-card lg:px-0 lg:shadow-2xl">
            <TaskItem task={dragTask} depth={hierarchyMetrics.depthById.get(dragTask.id) ?? 0} />
          </div>
        </div>,
        document.body,
      )}

      {drag?.active && (drag.intent.kind === 'reorder' || drag.intent.kind === 'reparent-reorder' || drag.intent.kind === 'nest') && (
        <DropIndicator intent={drag.intent} />
      )}

      {/* Ungroup 指示线：拖拽激活 + 向左退出当前父节点 → 在被拖行左侧画一条蓝色竖线，
          代表"松手后会上移一个层级"。放到最外层 fixed 覆盖层，
          避免被被拖行的 opacity-30 继承变淡。 */}
      {drag?.active && drag.intent.kind === 'unparent' && <UnparentIndicator taskId={drag.taskId} />}
    </div>
  );
}

function DropIndicator({ intent }: { intent: Extract<ListDropIntent, { kind: 'reorder' | 'reparent-reorder' | 'nest' }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const targetId = intent.kind === 'nest' ? intent.targetId : intent.anchorId;
    const target = findTaskRow(document, targetId);
    const indicator = ref.current;
    if (!indicator) return;
    if (!target) {
      indicator.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    if (intent.kind === 'nest') {
      indicator.style.left = `${rect.left + 2}px`;
      indicator.style.top = `${rect.top + 2}px`;
      indicator.style.width = `${Math.max(0, rect.width - 4)}px`;
      indicator.style.height = `${Math.max(0, rect.height - 4)}px`;
    } else {
      indicator.style.left = `${rect.left + 8}px`;
      indicator.style.top = `${intent.position === 'before' ? rect.top - 2 : rect.bottom - 2}px`;
      indicator.style.width = `${Math.max(0, rect.width - 16)}px`;
      indicator.style.height = '4px';
    }
    indicator.style.display = '';
  });

  return createPortal(
    <div
      ref={ref}
      data-list-drop-indicator={intent.kind}
      className={intent.kind === 'nest'
        ? 'fixed pointer-events-none z-[60] rounded-xl ring-2 ring-inset ring-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)] shadow-[0_0_12px_hsl(var(--primary)/0.45)]'
        : 'fixed pointer-events-none z-[60] rounded-full bg-[hsl(var(--primary))] shadow-[0_0_10px_hsl(var(--primary)/0.8)]'}
      style={{ display: 'none' }}
    />,
    document.body,
  );
}

/** 在被拖行左侧绘制一条蓝色竖线 —— 纯 DOM rAF 跟踪，零 React 渲染开销 */
function UnparentIndicator({ taskId }: { taskId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = document.querySelector(`[data-task-id="${taskId}"]`);
      const indicator = ref.current;
      if (el && indicator) {
        const r = (el as HTMLElement).getBoundingClientRect();
        indicator.style.left = `${r.left + 12}px`;
        indicator.style.top = `${r.top + 2}px`;
        indicator.style.height = `${r.height - 4}px`;
        indicator.style.display = '';
      } else if (indicator) {
        indicator.style.display = 'none';
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [taskId]);
  return (
    <div
      ref={ref}
      className="fixed pointer-events-none z-[60] w-[3px] rounded-sm bg-[hsl(var(--primary))] shadow-[0_0_8px_hsl(var(--primary)/0.6)]"
      style={{ display: 'none', animation: 'unparentPulse 0.9s ease-in-out infinite' }}
    />
  );
}

interface SectionProps {
  title: string;
  mobileKey: 'ready' | 'blocked' | 'done';
  hint?: string;
  items: FlatItem[];
  depInfo: Map<string, DepInfo>;
  childMap: Map<string, Task[]>;
  collapsed: Record<string, boolean>;
  onToggleCollapse: (id: string) => void;
  dragTaskId: string | null;
  onDragStart: (event: TaskDragStart, task: Task) => void;
  onDragMove: (event: TaskDragPoint) => void;
  onDragEnd: (pointerId: number) => void;
  onDragCancel: (pointerId: number) => void;
  onAddChild?: (parentId: string, title: string) => boolean;
  empty?: string;
  sectionCollapsed?: boolean;
  onToggleSection?: () => void;
}

function Section({ title, mobileKey, hint, items, depInfo, childMap, collapsed, onToggleCollapse, dragTaskId, onDragStart, onDragMove, onDragEnd, onDragCancel, onAddChild, empty, sectionCollapsed = false, onToggleSection }: SectionProps) {
  const visibleIds = new Set(items.map(({ task }) => task.id));
  const heading = (
    <>
      <span>{title}</span>
      <span className="inline-flex px-1 text-[10px] font-medium leading-none text-[#70e3d1] lg:hidden">
        {items.length}
      </span>
      {hint && <span className="text-[10px] normal-case tracking-normal opacity-70 max-lg:ml-auto max-lg:text-[#8f8796]">{hint}</span>}
    </>
  );
  return (
    <section
      data-mobile-task-section={mobileKey}
      className="mt-5 first:mt-6 max-lg:border-t max-lg:border-[#34303a]/70 max-lg:pt-3"
    >
      <h3 className="mb-1 flex items-baseline gap-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground/70 max-lg:mb-1 max-lg:h-7 max-lg:items-center max-lg:px-1 max-lg:text-[#b7b0be] max-lg:tracking-[0.08em]">
        {onToggleSection ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 text-left"
            aria-expanded={!sectionCollapsed}
            aria-label={sectionCollapsed ? '展开已完成任务' : '折叠已完成任务'}
            onClick={onToggleSection}
          >
            {sectionCollapsed
              ? <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
            {heading}
          </button>
        ) : heading}
      </h3>
      {!sectionCollapsed && (items.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground/50 italic max-lg:px-1 max-lg:py-1.5 max-lg:text-[#7d7784]">{empty ?? '空'}</p>
      ) : (
        <ul className="flex flex-col max-lg:divide-y max-lg:divide-[#2b2730]/70">
          {items.map(({ task, depth }) => {
            const children = childMap.get(task.id);
            const hasChildren = children?.some((child) => visibleIds.has(child.id)) ?? false;
            const isCollapsed = collapsed[task.id];
            return (
              <TaskItem
                key={task.id}
                task={task}
                dependencyInfo={depInfo.get(task.id)}
                depth={depth}
                hasChildren={hasChildren}
                isCollapsed={isCollapsed}
                onToggleCollapse={onToggleCollapse}
                isDragging={task.id === dragTaskId}
                onDragStart={onDragStart}
                onDragMove={onDragMove}
                onDragEnd={onDragEnd}
                onDragCancel={onDragCancel}
                onAddChild={onAddChild}
              />
            );
          })}
        </ul>
      ))}
    </section>
  );
}
