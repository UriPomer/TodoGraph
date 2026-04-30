import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { buildAdj } from '@todograph/core';
import type { Task } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import {
  MAX_HIERARCHY_DEPTH,
  depthOf,
  subtreeHeight,
} from '@/stores/useTaskStore';
import { useDerived } from '@/hooks/useRecommendation';
import { TaskInput } from './TaskInput';
import { TaskItem } from './TaskItem';

type DepInfo = { undone: number; total: number; parentTitles: string[] };

// ===== 拖拽状态类型 =====
type DragState =
  | { taskId: string; offsetX: number; offsetY: number; startX: number; startY: number; active: false }
  | { taskId: string; offsetX: number; offsetY: number; startX: number; startY: number; active: true; x: number; y: number; targetId: string | null; willUnparent: boolean; nearItemId: string | null }
  | null;

const DRAG_DELAY_MS = 150;
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
  const setParent = useTaskStore((s) => s.setParent);
  const updateTask = useTaskStore((s) => s.updateTask);
  const { graph, readySet, recommended } = useDerived();
  // 折叠状态：parentId → boolean
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // ===== 拖拽状态 =====
  const [drag, setDrag] = useState<DragState>(null);
  const dragTimerRef = useRef<number | null>(null);

  // 获取拖拽节点的 Task 对象（用于 ghost 渲染）
  const dragTask = useMemo(
    () => (drag ? nodes.find((n) => n.id === drag.taskId) ?? null : null),
    [drag, nodes],
  );

  // 上一轮的 depInfo（id → obj），用于签名稳定化
  const depInfoCacheRef = useRef(new Map<string, DepInfo>());

  // 构建树形结构：id → 子节点列表
  const childMap = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const n of nodes) {
      if (n.parentId) {
        const arr = map.get(n.parentId);
        if (arr) arr.push(n);
        else map.set(n.parentId, [n]);
      }
    }
    return map;
  }, [nodes]);

  const toggleCollapse = (parentId: string) => {
    setCollapsed((prev) => ({ ...prev, [parentId]: !prev[parentId] }));
  };

  // ===== 拖拽：检查 targetId 是否是 dragId 的后代（防止循环） =====
  const isDescendantOf = useCallback(
    (descendantId: string, ancestorId: string): boolean => {
      if (descendantId === ancestorId) return true;
      const directChildren = childMap.get(ancestorId);
      if (!directChildren) return false;
      for (const child of directChildren) {
        if (isDescendantOf(descendantId, child.id)) return true;
      }
      return false;
    },
    [childMap],
  );

  // ===== 拖拽开始（mousedown on TaskItem） =====
  const handleDragStart = useCallback((e: React.MouseEvent, task: Task) => {
    e.preventDefault(); // 防止文本选中
    const nativeEvent = e.nativeEvent;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offsetX = nativeEvent.clientX - rect.left;
    const offsetY = nativeEvent.clientY - rect.top;
    setDrag({
      taskId: task.id,
      offsetX,
      offsetY,
      startX: nativeEvent.clientX,
      startY: nativeEvent.clientY,
      active: false,
    });
    // 延迟激活：150ms 后才真正进入拖拽模式
    dragTimerRef.current = window.setTimeout(() => {
      setDrag((prev) =>
        prev && !prev.active ? { ...prev, active: true, x: nativeEvent.clientX, y: nativeEvent.clientY, targetId: null, willUnparent: false, nearItemId: null } : prev,
      );
    }, DRAG_DELAY_MS);
  }, []);

  // ===== 拖拽中 & 结束（document 级别事件） =====
  useEffect(() => {
    if (!drag) {
      // 清理 timer（如果存在）
      if (dragTimerRef.current !== null) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }
      return;
    }

    const onMouseMove = (e: MouseEvent) => {
      setDrag((prev) => {
        if (!prev) return null;
        const dx = e.clientX - prev.startX;
        const dy = e.clientY - prev.startY;

        // 未激活时：位移超过阈值则提前激活
        if (!prev.active) {
          if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
            if (dragTimerRef.current !== null) {
              window.clearTimeout(dragTimerRef.current);
              dragTimerRef.current = null;
            }
            return { ...prev, active: true, x: e.clientX, y: e.clientY, targetId: null, willUnparent: false, nearItemId: null };
          }
          return prev;
        }

        // 已激活：找 drop target / 近邻指示行
        // 三层嵌套限制：合并后的总层数不能超过 MAX_HIERARCHY_DEPTH
        const draggedHeight = subtreeHeight(nodes, prev.taskId);

        const el = document.elementFromPoint(e.clientX, e.clientY);
        const targetLi = el?.closest('[data-task-id]') as HTMLElement | null;
        let targetId: string | null = null;
        let nearItemId: string | null = null;
        if (targetLi) {
          const tid = targetLi.getAttribute('data-task-id');
          if (tid && tid !== prev.taskId && !isDescendantOf(tid, prev.taskId)) {
            // 检查挂到这个候选下会不会超深度
            const candDepth = depthOf(nodes, tid);
            if (candDepth + 1 + draggedHeight + 1 <= MAX_HIERARCHY_DEPTH) {
              targetId = tid;
            }
          }
          nearItemId = tid;
        }

        // 预测"松手时会发生什么"：只有子节点在空白区释放才 ungroup
        const draggingNode = nodes.find((n) => n.id === prev.taskId);
        const willUnparent = !targetId && !!draggingNode?.parentId;

        return { ...prev, x: e.clientX, y: e.clientY, targetId, willUnparent, nearItemId };
      });
    };

    const onMouseUp = () => {
      if (dragTimerRef.current !== null) {
        window.clearTimeout(dragTimerRef.current);
        dragTimerRef.current = null;
      }
      setDrag((prev) => {
        if (!prev || !prev.active) return null; // 未激活 → 取消，无副作用

        if (prev.targetId) {
          // 拖到目标节点上 → 设为子节点
          // 确保被拖拽的节点有合理的坐标（避免 setParent 算出负偏移导致子节点断开）
          const child = nodes.find((n) => n.id === prev.taskId);
          const parent = nodes.find((n) => n.id === prev.targetId);
          if (child && (!child.x || !child.y)) {
            // 节点没有画布坐标（可能来自列表创建），用视口中心作为默认位置
            const vc = useTaskStore.getState().viewportCenter;
            updateTask(prev.taskId, { x: vc?.x ?? 200, y: vc?.y ?? 100 });
          }
          setParent(prev.taskId, prev.targetId);
        } else if (nodes.find((n) => n.id === prev.taskId)?.parentId) {
          // 拖到空白区域且原来是子节点 → 解除分组
          setParent(prev.taskId, null);
        }
        return null;
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [drag, isDescendantOf, setParent, updateTask, nodes, childMap]);

  const { readyArr, blockedArr, doneArr, depInfo } = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const { parents } = buildAdj(graph);
    const prevCache = depInfoCacheRef.current;
    const nextCache = new Map<string, DepInfo>();

    for (const n of nodes) {
      const ps = [...(parents.get(n.id) ?? [])];
      if (ps.length === 0) continue;
      const parentTitles = ps.map((pid) => byId.get(pid)?.title ?? pid);
      const undone = ps.filter((pid) => byId.get(pid)?.status !== 'done').length;
      const candidate: DepInfo = { undone, total: ps.length, parentTitles };
      // 复用旧对象：签名一致则保留引用
      const prev = prevCache.get(n.id);
      const same =
        prev &&
        prev.undone === candidate.undone &&
        prev.total === candidate.total &&
        prev.parentTitles.length === candidate.parentTitles.length &&
        prev.parentTitles.every((t, i) => t === candidate.parentTitles[i]);
      nextCache.set(n.id, same ? prev! : candidate);
    }
    depInfoCacheRef.current = nextCache;

    const rank = (arr: FlatItem[]) =>
      [...arr].sort((a, b) => {
        const aRec = a.task.id === recommended?.id ? 1 : 0;
        const bRec = b.task.id === recommended?.id ? 1 : 0;
        if (aRec !== bRec) return bRec - aRec;
        const aD = a.task.status === 'doing' ? 1 : 0;
        const bD = b.task.status === 'doing' ? 1 : 0;
        if (aD !== bD) return bD - aD;
        return (b.task.priority ?? 0) - (a.task.priority ?? 0);
      });

    // 分离顶层节点和子节点
    const topLevel = nodes.filter((n) => !n.parentId);

    // 将所有节点按树分类到 Ready/Blocked/Done，保持层级关系
    // 关键：以整棵树的根节点的状态来决定该树所属的 Section，避免父子分散在不同区域
    type SectionKey = 'ready' | 'blocked' | 'done';

    const getRootSection = (task: Task): SectionKey => {
      if (task.status === 'done') return 'done';
      return readySet.has(task.id) ? 'ready' : 'blocked';
    };

    const readyArr: FlatItem[] = [];
    const blockedArr: FlatItem[] = [];
    const doneArr: FlatItem[] = [];

    const pushSubtreeToSection = (root: Task, depth: number, section: SectionKey) => {
      const arr = section === 'done' ? doneArr : section === 'ready' ? readyArr : blockedArr;
      arr.push({ task: root, depth });
      const children = childMap.get(root.id);
      if (children && !collapsed[root.id]) {
        for (const child of children) {
          pushSubtreeToSection(child, depth + 1, section);
        }
      }
    };

    // 按顶层节点遍历：每个子树归入根节点的 Section
    for (const t of topLevel) {
      pushSubtreeToSection(t, 0, getRootSection(t));
    }

    // 孤儿子节点（parent 被删除但 parentId 还残留）
    const orphaned = nodes.filter(
      (n) => n.parentId && !byId.has(n.parentId),
    );
    for (const o of orphaned) {
      const sec = getRootSection(o);
      const arr = sec === 'done' ? doneArr : sec === 'ready' ? readyArr : blockedArr;
      arr.push({ task: o, depth: 0 });
    }

    // 各 Section 内部排序：只对顶层节点排序，子节点保持 DFS 顺序跟在父节点后面
    const sortPreservingTree = (arr: FlatItem[]): FlatItem[] => {
      // 找出所有顶层条目（depth === 0）
      const roots: { index: number; item: FlatItem }[] = [];
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (item?.depth === 0) {
          roots.push({ index: i, item });
        }
      }
      // 按推荐/进行中/优先级排序顶层条目
      roots.sort((a, b) => {
        const aRec = a.item.task.id === recommended?.id ? 1 : 0;
        const bRec = b.item.task.id === recommended?.id ? 1 : 0;
        if (aRec !== bRec) return bRec - aRec;
        const aD = a.item.task.status === 'doing' ? 1 : 0;
        const bD = b.item.task.status === 'doing' ? 1 : 0;
        if (aD !== bD) return bD - aD;
        return (b.item.task.priority ?? 0) - (a.item.task.priority ?? 0);
      });
      // 按排序后的顺序重组数组：每个排序后的根节点 + 其子树
      const result: FlatItem[] = [];
      const used = new Set<number>();
      for (const { index } of roots) {
        const rootItem = arr[index];
        if (!rootItem) continue;
        used.add(index);
        result.push(rootItem);
        // 输出该根节点的所有子节点（保持原始相对顺序）
        let j = index + 1;
        while (j < arr.length) {
          const child = arr[j];
          if (!child || child.depth <= 0) break;
          result.push(child);
          used.add(j);
          j++;
        }
      }
      // 处理可能的非顶层孤儿条目（depth > 0 但不在任何子树内）
      for (let k = 0; k < arr.length; k++) {
        if (!used.has(k)) {
          const orphan = arr[k];
          if (orphan) result.push(orphan);
        }
      }
      return result;
    };

    const ready = sortPreservingTree(readyArr);
    const blocked = sortPreservingTree(blockedArr);
    const done = doneArr;
    return { readyArr: ready, blockedArr: blocked, doneArr: done, depInfo: nextCache };
  }, [nodes, graph, readySet, recommended, childMap, collapsed]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-md px-4 py-5">
        <TaskInput />

        <Section
          title="Ready"
          hint="可执行"
          items={readyArr}
          recommendedId={recommended?.id}
          depInfo={depInfo}
          childMap={childMap}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          dragTaskId={drag?.taskId ?? null}
          dropTargetId={drag?.active ? drag.targetId ?? null : null}
          onDragStart={handleDragStart}
          empty="暂无可执行任务"
        />
        <Section
          title="Blocked"
          hint="有未完成的前置"
          items={blockedArr}
          recommendedId={recommended?.id}
          depInfo={depInfo}
          childMap={childMap}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          dragTaskId={drag?.taskId ?? null}
          dropTargetId={drag?.active ? drag.targetId ?? null : null}
          onDragStart={handleDragStart}
        />
        <Section
          title="Done"
          items={doneArr}
          recommendedId={undefined}
          depInfo={depInfo}
          childMap={childMap}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          dragTaskId={drag?.taskId ?? null}
          dropTargetId={drag?.active ? drag.targetId ?? null : null}
          onDragStart={handleDragStart}
        />
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
      {drag?.active && drag.willUnparent && <UnparentIndicator taskId={drag.taskId} />}
    </div>
  );
}

/** 在被拖行左侧绘制一条蓝色竖线 —— 用 rAF 读取 DOM rect 跟踪位置。 */
function UnparentIndicator({ taskId }: { taskId: string }) {
  const [rect, setRect] = useState<{ top: number; left: number; height: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = document.querySelector(`[data-task-id="${taskId}"]`);
      if (el) {
        const r = (el as HTMLElement).getBoundingClientRect();
        setRect({ top: r.top, left: r.left, height: r.height });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [taskId]);

  if (!rect) return null;
  return (
    <div
      className="fixed pointer-events-none z-[60] w-[3px] rounded-sm bg-[hsl(var(--primary))] shadow-[0_0_8px_hsl(var(--primary)/0.6)]"
      style={{
        // depth=0 的缩进起点（与 TaskItem 的 paddingLeft 基础 12px 对齐）
        left: rect.left + 12,
        top: rect.top + 2,
        height: rect.height - 4,
        animation: 'unparentPulse 0.9s ease-in-out infinite',
      }}
    />
  );
}

interface FlatItem {
  task: Task;
  depth: number;
}

interface SectionProps {
  title: string;
  hint?: string;
  items: FlatItem[];
  recommendedId: string | undefined;
  depInfo: Map<string, DepInfo>;
  childMap: Map<string, Task[]>;
  collapsed: Record<string, boolean>;
  onToggleCollapse: (id: string) => void;
  dragTaskId: string | null;
  dropTargetId: string | null;
  onDragStart: (e: React.MouseEvent, task: Task) => void;
  empty?: string;
}

function Section({ title, hint, items, recommendedId, depInfo, childMap, collapsed, onToggleCollapse, dragTaskId, dropTargetId, onDragStart, empty }: SectionProps) {
  return (
    <section className="mt-5 first:mt-6">
      <h3 className="mb-1 flex items-baseline gap-2 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>{title}</span>
        {hint && <span className="text-[10px] normal-case tracking-normal opacity-70">{hint}</span>}
      </h3>
      {items.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground/50 italic">{empty ?? '空'}</p>
      ) : (
        <ul className="flex flex-col">
          {items.map(({ task, depth }) => {
            const children = childMap.get(task.id);
            const hasChildren = children !== undefined && children.length > 0;
            const isCollapsed = collapsed[task.id];
            return (
              <li key={task.id}>
                <TaskItem
                  task={task}
                  recommended={task.id === recommendedId}
                  dependencyInfo={depInfo.get(task.id)}
                  depth={depth}
                  hasChildren={hasChildren}
                  isCollapsed={isCollapsed}
                  onToggleCollapse={() => onToggleCollapse(task.id)}
                  isDragging={task.id === dragTaskId}
                  isDropTarget={task.id === dropTargetId}
                  onDragStart={onDragStart}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
