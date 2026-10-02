import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { MAX_HIERARCHY_DEPTH, SYSTEM_HIERARCHY_PAGE_ID, type Task } from '@todograph/shared';
import { buildHierarchyMetrics, useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { toast } from '@/components/ui/toaster-store';
import { defaultPositionFor } from '@/lib/defaultPosition';
import { CrossPageReady, selectCrossPageReadyTasks } from './CrossPageReady';
import { TaskInput } from './TaskInput';
import { TaskItem, type TaskDragPoint, type TaskDragStart } from './TaskItem';
import { TaskSection } from './TaskSection';
import { DropIndicator, prepareTaskMoveAnimation, UnparentIndicator } from './ListDragOverlays';
import { usePullToCreateTask } from './usePullToCreateTask';
import { buildTaskListModel, type DepInfo } from './listModel';
import { applyDragAutoScroll, dragAutoScrollDelta, listDropIntentKey, resolveListDropIntent, type ListDropIntent } from './listDrag';
import { nativeFeedback } from '@/platform/nativeInteractions';
type DragState =
  | { taskId: string; pointerId: number; pointerType: string; width: number; offsetX: number; offsetY: number; startX: number; startY: number; active: false }
  | { taskId: string; pointerId: number; pointerType: string; width: number; offsetX: number; offsetY: number; startX: number; startY: number; active: true; x: number; y: number; intent: ListDropIntent }
  | null;
const DRAG_THRESHOLD_PX = 12;

/**
 * 极简列表视图（无外层卡片）：
 * - 页面模式分为 Ready / Blocked / Done；清单模式不显示 Blocked
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
  const isChecklistMode = activePageId === SYSTEM_HIERARCHY_PAGE_ID;
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
  const isDragging = useCallback(() => dragRef.current !== null, []);
  const { scrollRef, pullRef, contentRef, pullReady, focusTrigger } = usePullToCreateTask(isDragging);
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
  const sectionDrag = { taskId: drag?.active ? drag.taskId : null, start: handleDragStart, move: moveDrag, end: finishDrag, cancel: cancelDrag };
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
        <div ref={contentRef} className="will-change-transform w-full px-4 py-5 max-lg:px-3 max-lg:py-3" style={{ transform: 'translateY(0px)' }}>
          <TaskInput focusTrigger={focusTrigger} />

          <TaskSection
            title="Ready"
            mobileKey="ready"
            hint="可执行"
            items={readyArr}
            depInfo={depInfo}
            childMap={childMap}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            drag={sectionDrag}
            onAddChild={handleAddChild}
            empty="暂无可执行任务"
          />
          {!isChecklistMode && (
            <TaskSection
              title="Blocked"
              mobileKey="blocked"
              hint="有未完成的前置"
              items={blockedArr}
              depInfo={depInfo}
              childMap={childMap}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              drag={sectionDrag}
              onAddChild={handleAddChild}
            />
          )}
          <TaskSection
            title="Done"
            mobileKey="done"
            items={doneArr}
            depInfo={depInfo}
            childMap={childMap}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            drag={sectionDrag}
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
        <div className="w-full px-4 max-lg:px-3">
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
