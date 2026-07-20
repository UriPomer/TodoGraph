import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MAX_HIERARCHY_DEPTH, type Task } from '@todograph/shared';
import { buildHierarchyMetrics, useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { toast } from '@/components/ui/toaster-store';
import { defaultPositionFor } from '@/lib/defaultPosition';
import { CrossPageReady, selectCrossPageReadyTasks } from './CrossPageReady';
import { TaskInput } from './TaskInput';
import { TaskItem } from './TaskItem';
import { buildTaskListModel, type DepInfo, type FlatItem } from './listModel';
import { dragAutoScrollDelta, resolveListDropIntent, type ListDropIntent } from './listDrag';
type DragState =
  | { taskId: string; pointerId: number; offsetX: number; offsetY: number; startX: number; startY: number; active: false }
  | { taskId: string; pointerId: number; offsetX: number; offsetY: number; startX: number; startY: number; active: true; x: number; y: number; intent: ListDropIntent }
  | null;
const DRAG_THRESHOLD_PX = 8;
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
  const reorderTask = useTaskStore((s) => s.reorderTask);
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
  const handleDragStart = useCallback((e: React.PointerEvent, task: Task) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const row = e.currentTarget.closest('[data-task-id]') as HTMLElement | null;
    const rect = row?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const initial: DragState = {
      taskId: task.id,
      pointerId: e.pointerId,
      offsetX,
      offsetY,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    updateDrag(initial);
  }, [updateDrag]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!drag) return;
    const eventDocument = document;
    let autoScrollFrame = 0;
    let latestPointer: { x: number; y: number } | null = null;

    const intentAt = (current: Extract<DragState, { active: true }>, clientX: number, clientY: number) => {
      const targetLi = eventDocument.elementFromPoint(clientX, clientY)?.closest('[data-task-id]') as HTMLElement | null;
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
    };

    const autoScroll = () => {
      autoScrollFrame = 0;
      const current = dragRef.current;
      const scroller = scrollRef.current;
      if (!current?.active || !latestPointer || !scroller) return;
      const delta = dragAutoScrollDelta(latestPointer.y, scroller.getBoundingClientRect());
      if (!delta) return;
      scroller.scrollTop += delta;
      updateDrag({
        ...current,
        x: latestPointer.x,
        y: latestPointer.y,
        intent: intentAt(current, latestPointer.x, latestPointer.y),
      });
      autoScrollFrame = requestAnimationFrame(autoScroll);
    };

    const onPointerMove = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      const dx = e.clientX - current.startX;
      const dy = e.clientY - current.startY;
      if (!current.active) {
        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
          updateDrag({ ...current, active: true, x: e.clientX, y: e.clientY, intent: { kind: 'none' } });
        }
        return;
      }
      e.preventDefault();
      latestPointer = { x: e.clientX, y: e.clientY };
      updateDrag({ ...current, x: e.clientX, y: e.clientY, intent: intentAt(current, e.clientX, e.clientY) });
      if (!autoScrollFrame && typeof requestAnimationFrame === 'function') {
        autoScrollFrame = requestAnimationFrame(autoScroll);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const current = dragRef.current;
      if (!current || e.pointerId !== current.pointerId) return;
      updateDrag(null);
      if (!current.active) return;
      if (current.intent.kind === 'nest') {
        setParent(current.taskId, current.intent.targetId);
      } else if (current.intent.kind === 'reorder') {
        reorderTask(current.taskId, current.intent.anchorId, current.intent.position, current.intent.storageOrder);
      } else if (current.intent.kind === 'unparent') {
        setParent(current.taskId, null);
      }
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (dragRef.current?.pointerId === e.pointerId) updateDrag(null);
    };
    eventDocument.addEventListener('pointermove', onPointerMove);
    eventDocument.addEventListener('pointerup', onPointerUp);
    eventDocument.addEventListener('pointercancel', onPointerCancel);
    return () => {
      if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
      eventDocument.removeEventListener('pointermove', onPointerMove);
      eventDocument.removeEventListener('pointerup', onPointerUp);
      eventDocument.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [drag?.taskId, setParent, reorderTask, updateDrag, hierarchyMetrics]);
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
  const onSplitPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitRectRef.current = container.getBoundingClientRect();
  }, []);
  const onSplitPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = splitRectRef.current;
    if (!rect || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const pct = Math.max(25, Math.min(85, ((e.clientY - rect.top) / rect.height) * 100));
    splitPctRef.current = pct;
    setTopPct(pct);
  }, []);
  const onSplitPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    splitRectRef.current = null;
    localStorage.setItem('todograph.listSplitTopPct', String(Math.round(splitPctRef.current)));
  }, []);
  const onSplitPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    splitRectRef.current = null;
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
            dropTargetId={drag?.active && drag.intent.kind === 'nest' ? drag.intent.targetId : null}
            reorderTargetId={drag?.active && drag.intent.kind === 'reorder' ? drag.intent.anchorId : null}
            reorderPosition={drag?.active && drag.intent.kind === 'reorder' ? drag.intent.position : undefined}
            onDragStart={handleDragStart}
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
            dropTargetId={drag?.active && drag.intent.kind === 'nest' ? drag.intent.targetId : null}
            reorderTargetId={drag?.active && drag.intent.kind === 'reorder' ? drag.intent.anchorId : null}
            reorderPosition={drag?.active && drag.intent.kind === 'reorder' ? drag.intent.position : undefined}
            onDragStart={handleDragStart}
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
            dropTargetId={drag?.active && drag.intent.kind === 'nest' ? drag.intent.targetId : null}
            reorderTargetId={drag?.active && drag.intent.kind === 'reorder' ? drag.intent.anchorId : null}
            reorderPosition={drag?.active && drag.intent.kind === 'reorder' ? drag.intent.position : undefined}
            onDragStart={handleDragStart}
            onAddChild={handleAddChild}
            sectionCollapsed={doneSectionCollapsed}
            onToggleSection={() => setDoneSectionCollapsed((value) => !value)}
          />
        </div>
      </div>

      {/* 拖动分隔条：移动端可见手柄（12px高 + 中间把手），桌面端细线 */}
      <div
        data-list-split={hasCrossPageReady ? 'adjustable' : 'bottom'}
        onPointerDown={hasCrossPageReady ? onSplitPointerDown : undefined}
        onPointerMove={hasCrossPageReady ? onSplitPointerMove : undefined}
        onPointerUp={hasCrossPageReady ? onSplitPointerUp : undefined}
        onPointerCancel={hasCrossPageReady ? onSplitPointerCancel : undefined}
        className={`shrink-0 h-3 lg:h-[5px] flex items-center justify-center bg-border/30 transition-colors relative group touch-none select-none ${
          hasCrossPageReady
            ? 'cursor-row-resize hover:bg-[hsl(var(--primary))] active:bg-[hsl(var(--primary))]'
            : 'cursor-default'
        }`}
        title={hasCrossPageReady ? '拖动调整上下高度' : undefined}
      >
        {/* 中间拖拽把手，仅移动端显示 */}
        <span className="lg:hidden w-8 h-1 rounded-full bg-muted-foreground/30 group-active:bg-[hsl(var(--primary))] transition-colors" />
      </div>

      {/* 下半部分：其他页面可做（可滚动） */}
      <div className={hasCrossPageReady ? 'flex-1 overflow-auto' : 'hidden'}>
        <div className="w-full px-5">
          <CrossPageReady />
        </div>
      </div>

      {/* Ghost overlay：拖拽激活后跟随鼠标 */}
      {drag?.active && dragTask && (
        <div
          className="fixed pointer-events-none z-50"
          style={{
            left: drag.x - drag.offsetX,
            top: drag.y - drag.offsetY,
            width: '360px', // 匹配 max-w-md + padding
          }}
        >
          <div className="rounded-md bg-card border border-border shadow-lg px-2.5 py-2 opacity-90">
            <TaskItem task={dragTask} depth={0} isDragging />
          </div>
        </div>
      )}

      {/* Ungroup 指示线：拖拽激活 + 落点不合法 + 被拖节点原本有父 → 在被拖行左侧画一条蓝色竖线，
          代表"松手后会脱离父节点，移到顶层（depth=0）"。放到最外层 fixed 覆盖层，
          避免被被拖行的 opacity-30 继承变淡。 */}
      {drag?.active && drag.intent.kind === 'unparent' && <UnparentIndicator taskId={drag.taskId} />}
    </div>
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
  dropTargetId: string | null;
  reorderTargetId: string | null;
  reorderPosition?: 'before' | 'after';
  onDragStart: (e: React.PointerEvent, task: Task) => void;
  onAddChild?: (parentId: string, title: string) => boolean;
  empty?: string;
  sectionCollapsed?: boolean;
  onToggleSection?: () => void;
}

function Section({ title, mobileKey, hint, items, depInfo, childMap, collapsed, onToggleCollapse, dragTaskId, dropTargetId, reorderTargetId, reorderPosition, onDragStart, onAddChild, empty, sectionCollapsed = false, onToggleSection }: SectionProps) {
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
                isDropTarget={task.id === dropTargetId}
                reorderPosition={task.id === reorderTargetId ? reorderPosition : undefined}
                onDragStart={onDragStart}
                onAddChild={onAddChild}
              />
            );
          })}
        </ul>
      ))}
    </section>
  );
}
