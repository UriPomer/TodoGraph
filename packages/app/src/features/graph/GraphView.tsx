import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
} from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
  type Viewport,
} from '@xyflow/react';
import { Layout, Maximize2 } from 'lucide-react';
import { wouldCreateCycle } from '@todograph/core';
import { Button } from '@/components/ui/button';
import { useTaskStore } from '@/stores/useTaskStore';
import {
  MAX_HIERARCHY_DEPTH,
  depthOf,
  subtreeHeight,
} from '@/stores/useTaskStore';
import { useDerived } from '@/hooks/useRecommendation';
import { TaskNode, type TaskNodeData } from './TaskNode';
import { GroupNode, type GroupNodeData } from './GroupNode';
import { MergeGhostNode, type MergeGhostData } from './MergeGhostNode';
import { SelectionMenu, type SelectionMenuAction } from './SelectionMenu';
import { InlineCreateInput } from './InlineCreateInput';
import { dagreLayout } from './useAutoLayout';
import {
  computeGroupSize,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_W,
  CHILD_DEFAULT_H,
  GROUP_MIN_W,
  GROUP_MIN_H,
} from './computeGroupSize';

const nodeTypes: NodeTypes = {
  task: TaskNode,
  group: GroupNode,
  mergeGhost: MergeGhostNode,
};

/** hover 进入目标后多久才显示 ghost 合并预览（ms） */
const MERGE_HOVER_MS = 220;
/** 子节点中心离开父框后多久才真正 ungroup（ms）—— 期间父框显示红色抖动警告 */
const UNGROUP_CONFIRM_MS = 320;
/** 认定为「明显离开父框」所需的最小像素 —— 轻微拖动不触发 ungroup 提示 */
const UNGROUP_ESCAPE_PX = 12;
/** ghost overlay 的固定 id —— 用于在命中检测里排除自己 */
const GHOST_ID = '__merge_ghost__';

interface RFTaskNode extends RFNode<TaskNodeData | GroupNodeData | MergeGhostData> {}

function GraphViewInner() {
  // 拆分订阅：单个字段订阅 + 稳定的函数引用，避免不必要的重渲染
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);
  const addTask = useTaskStore((s) => s.addTask);
  const addEdge = useTaskStore((s) => s.addEdge);
  const removeEdge = useTaskStore((s) => s.removeEdge);
  const updateTasksBulk = useTaskStore((s) => s.updateTasksBulk);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const setParent = useTaskStore((s) => s.setParent);
  const groupTasks = useTaskStore((s) => s.groupTasks);
  const normalizeGroupBounds = useTaskStore((s) => s.normalizeGroupBounds);
  const ascendOneLevel = useTaskStore((s) => s.ascendOneLevel);
  const setViewportCenter = useTaskStore((s) => s.setViewportCenter);

  const { graph, readySet, recommended } = useDerived();
  const rf = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);

  // ===== 鼠标位置追踪（用于空格键新建节点） =====
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // ===== 空格/回车键：在鼠标位置创建新节点 =====
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 只在非输入框聚焦时响应
      if ((e.key === ' ' || e.key === 'Enter') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const screenX = lastMousePosRef.current.x - rect.left;
        const screenY = lastMousePosRef.current.y - rect.top;
        const flow = rf.screenToFlowPosition(lastMousePosRef.current);
        setPendingCreate({
          screenX,
          screenY,
          flowX: flow.x - 90,
          flowY: flow.y - 28,
          fromId: '', // 空格创建不关联依赖边
        });
      }
    },
    [rf],
  );

  // ===== 本地 nodes state =====
  // 拖动的位置先只更新本地 state（实时响应），drag stop 才 flush 回 store。
  const [rfNodes, setRfNodes] = useState<RFTaskNode[]>([]);
  const draggingRef = useRef(false);

  interface DragState {
    dragId: string;
    mergeTarget: string | null;
    ungroupFrom: string | null;
  }
  const [dragState, setDragState] = useState<DragState | null>(null);
  // ref 镜像：onNodeDragStop 在 React 18 strict mode 下通过 functional setter 读取
  // 会被双调用（第二次 s=null），必须通过 ref 同步读取最新值。
  const dragStateRef = useRef<DragState | null>(null);
  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  // 计时器与候选 ref：transient 值，state 只保存「确认后」的结果。
  const mergeTimerRef = useRef<number | null>(null);
  const mergeCandidateRef = useRef<string | null>(null);
  const ungroupTimerRef = useRef<number | null>(null);
  const ungroupCandidateRef = useRef<string | null>(null);

  const clearMergeTimer = useCallback(() => {
    if (mergeTimerRef.current !== null) {
      window.clearTimeout(mergeTimerRef.current);
      mergeTimerRef.current = null;
    }
    mergeCandidateRef.current = null;
  }, []);
  const clearUngroupTimer = useCallback(() => {
    if (ungroupTimerRef.current !== null) {
      window.clearTimeout(ungroupTimerRef.current);
      ungroupTimerRef.current = null;
    }
    ungroupCandidateRef.current = null;
  }, []);

  // 组件卸载时清理悬挂定时器 —— 否则 setTimeout 会 setDragState 到已卸载树
  useEffect(() => {
    return () => {
      if (mergeTimerRef.current !== null) window.clearTimeout(mergeTimerRef.current);
      if (ungroupTimerRef.current !== null) window.clearTimeout(ungroupTimerRef.current);
    };
  }, []);

  // 父节点 id → 子节点集合。用于计算父容器尺寸 & 批量移动。
  const parentMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of nodes) {
      if (n.parentId) {
        const arr = m.get(n.parentId);
        if (arr) arr.push(n.id);
        else m.set(n.parentId, [n.id]);
      }
    }
    return m;
  }, [nodes]);

  // 判断 nodeId 是否是 ancestorId 的后代（含自身）
  const isDescendantOf = useCallback(
    (descendantId: string, ancestorId: string): boolean => {
      if (descendantId === ancestorId) return true;
      const directChildren = parentMap.get(ancestorId);
      if (!directChildren) return false;
      for (const cid of directChildren) {
        if (isDescendantOf(descendantId, cid)) return true;
      }
      return false;
    },
    [parentMap],
  );

  // 稳定的 data 对象缓存，避免每帧 new 一个对象触发 TaskNode 重渲染
  const dataCacheRef = useRef(new Map<string, TaskNodeData | GroupNodeData>());
  // 上一轮计算出的父节点尺寸 —— 用于 diff 触发 updateNodeInternals
  const prevGroupSizesRef = useRef(new Map<string, { w: number; h: number }>());
  // 当 sync effect 发现父尺寸变化时，把 id 收集起来，交给一个后续 effect 调 updateNodeInternals
  const [resizedGroupIds, setResizedGroupIds] = useState<string[]>([]);

  // 同步 store → 本地 rfNodes；正在拖动时不覆盖 position
  useEffect(() => {
    if (draggingRef.current) return;
    // 节点 id → node 的索引，供本 effect 内所有查找复用，避免 O(n²)
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // === 拓扑排序（叶子优先）===
    // 多层 group 场景下，祖父的尺寸要包含父 —— 而父的尺寸取决于它的子。
    // 按深度倒序遍历 parentMap：先算叶子层的 group，再算它们的父。
    const groupIds = [...parentMap.keys()];
    groupIds.sort((a, b) => depthOf(nodes, b) - depthOf(nodes, a));

    const groupSizes = new Map<string, { w: number; h: number }>();
    for (const pid of groupIds) {
      const childIds = parentMap.get(pid) ?? [];
      const childPositions: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const cid of childIds) {
        const c = byId.get(cid);
        if (!c) continue;
        // 若子节点本身也是父节点 —— 用它已经计算好的尺寸（已按叶子优先拿到）
        const childSize = groupSizes.get(cid);
        childPositions.push({
          x: c.x ?? 0,
          y: c.y ?? 0,
          w: childSize?.w ?? CHILD_DEFAULT_W,
          h: childSize?.h ?? CHILD_DEFAULT_H,
        });
      }
      groupSizes.set(pid, computeGroupSize(childPositions));
    }

    // === Diff：哪些父的尺寸变了？ ===
    const prevSizes = prevGroupSizesRef.current;
    const changed: string[] = [];
    for (const [pid, cur] of groupSizes) {
      const old = prevSizes.get(pid);
      if (!old || old.w !== cur.w || old.h !== cur.h) changed.push(pid);
    }
    prevGroupSizesRef.current = groupSizes;
    if (changed.length > 0) {
      // 用 state 把变化传给独立 effect —— 这里直接 setState 会触发重渲染，但
      // 只要 array 引用稳定（changed.length > 0 才变），次数很少。
      setResizedGroupIds(changed);
    }

    // React Flow 要求 parent 在 children 之前；按深度升序（根 → 子 → 孙）
    const sorted = [...nodes].sort((a, b) => depthOf(nodes, a.id) - depthOf(nodes, b.id));

    setRfNodes((prev) => {
      const prevById = new Map(prev.map((p) => [p.id, p]));
      const cache = dataCacheRef.current;
      const nextCache = new Map<string, TaskNodeData | GroupNodeData>();

      const built: RFTaskNode[] = sorted.map((n) => {
        const old = prevById.get(n.id);
        const isGroup = parentMap.has(n.id);
        const size = groupSizes.get(n.id);

        // 数据对象：只在真正变化时重新创建（保持引用稳定以命中 memo）
        // 注意：拖拽时的 isMergeTarget/isUngroupWarn 不在这里算 —— 会被 draggingRef 守卫挡住。
        // 它们在 renderNodes memo 里单独注入（见下方）。
        const baseData = isGroup
          ? ({
              title: n.title,
              status: n.status,
              priority: n.priority,
              ready: readySet.has(n.id),
              recommended: recommended?.id === n.id,
              childrenCount: parentMap.get(n.id)?.length ?? 0,
            } as GroupNodeData)
          : ({
              title: n.title,
              status: n.status,
              priority: n.priority,
              ready: readySet.has(n.id),
              recommended: recommended?.id === n.id,
            } as TaskNodeData);

        const cached = cache.get(n.id);
        const data =
          cached && shallowEqualData(cached, baseData)
            ? cached
            : baseData;
        nextCache.set(n.id, data);

        const node: RFTaskNode = {
          id: n.id,
          type: isGroup ? 'group' : 'task',
          // 非拖动状态时始终从 store 读位置，确保外部变更（如对齐）能生效
          position: { x: n.x ?? 0, y: n.y ?? 0 },
          data,
          ...(n.parentId
            ? { parentId: n.parentId }
            : {}),
          // group 节点：只有 .group-drag-handle（header）可以拖动，
          // 框内其它区域交还给 panOnDrag，避免误把整个 group 丢进别的 group 里。
          ...(isGroup ? { dragHandle: '.group-drag-handle' } : {}),
          ...(isGroup && size
            ? { style: { width: size.w, height: size.h }, width: size.w, height: size.h }
            : {}),
        };
        return node;
      });

      dataCacheRef.current = nextCache;
      return built;
    });
  }, [nodes, readySet, recommended, parentMap]);

  // 父节点结构（子节点增减）或尺寸变化时，通知 React Flow 重新测量
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    // parentMap 变化时：全部 parent 重测；尺寸变化时：只测有变化的
    const ids = new Set<string>([...parentMap.keys(), ...resizedGroupIds]);
    if (ids.size === 0) return;
    // 延迟一帧确保 rfNodes 已写入 DOM
    requestAnimationFrame(() => {
      updateNodeInternals([...ids]);
    });
  }, [parentMap, resizedGroupIds, updateNodeInternals]);

  /**
   * 合成送给 React Flow 的最终节点数组。两种效果：
   *   1. 把 dragState 的 mergeTarget / ungroupFrom 标记写到对应节点的 data 上（不污染源数据）。
   *   2. mergeTarget 存在时追加一个 ghost overlay 节点。
   * sync effect 被 draggingRef 守卫挡住 —— 所以拖拽期间的视觉反馈只能在这里做。
   */
  const renderNodes: RFTaskNode[] = useMemo(() => {
    if (!dragState) return rfNodes;
    const { mergeTarget, ungroupFrom, dragId } = dragState;

    // 只对被标记的节点重建 —— 其它节点保留原引用命中 memo
    const flagged = (mergeTarget || ungroupFrom)
      ? rfNodes.map((n) => {
          if (n.id !== mergeTarget && n.id !== ungroupFrom) return n;
          const extra = n.id === mergeTarget ? { isMergeTarget: true } : { isUngroupWarn: true };
          return { ...n, data: { ...n.data, ...extra } };
        })
      : rfNodes;

    if (!mergeTarget) return flagged;

    const target = flagged.find((n) => n.id === mergeTarget);
    const dragNode = flagged.find((n) => n.id === dragId);
    if (!target || !dragNode) return flagged;

    const targetW = target.width ?? (target.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W);
    const targetH = target.height ?? (target.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H);
    const ghost: RFTaskNode = {
      id: GHOST_ID,
      type: 'mergeGhost',
      position: { x: target.position.x, y: target.position.y },
      data: {
        dragTitle: (dragNode.data as { title?: string }).title ?? '',
        targetTitle: (target.data as { title?: string }).title ?? '',
        targetIsGroup: target.type === 'group',
      } as MergeGhostData,
      ...(target.parentId ? { parentId: target.parentId } : {}),
      style: { width: targetW, height: targetH, zIndex: 1000 },
      width: targetW,
      height: targetH,
      selectable: false,
      draggable: false,
      focusable: false,
    };
    return [...flagged, ghost];
  }, [rfNodes, dragState]);

  // edges 稳定化：edges 数组引用变化时才重算；status 变化通过 status map 命中
  const nodeStatusById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.status);
    return m;
  }, [nodes]);

  const rfEdges: RFEdge[] = useMemo(
    () =>
      edges.map((e) => {
        const isReady = nodeStatusById.get(e.from) === 'done';
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          animated: isReady,
          className: isReady ? 'ready' : undefined,
        };
      }),
    [edges, nodeStatusById],
  );

  /**
   * 只做 applyNodeChanges + remove dispatch + draggingRef 维护。
   * 合并 / ungroup 业务在 onNodeDrag* 钩子里做 —— 避免上帝函数。
   */
  const onNodesChange = useCallback(
    (changes: NodeChange<RFTaskNode>[]) => {
      setRfNodes((prev) => applyNodeChanges(changes, prev));
      for (const c of changes) {
        if (c.type === 'position') {
          if (c.dragging) draggingRef.current = true;
          else draggingRef.current = false;
        }
        if (c.type === 'remove' && c.id) deleteTask(c.id);
      }
    },
    [deleteTask],
  );

  /**
   * 拖拽过程中：使用 React Flow 的 getIntersectingNodes 做命中检测。
   * 官方 API 已经内置了绝对坐标 + bounding box 计算，不需要手写 computeAbs。
   */
  const onNodeDrag = useCallback(
    (_evt: React.MouseEvent, draggedNode: RFNode) => {
      const dragId = draggedNode.id;

      // ===== 1. 合并检测：放开多层嵌套，以"合并后的总深度"作为上限 =====
      // 允许合并的条件：若把 draggedNode 挂到 candidate 下，合并后的最深层数 ≤ MAX_HIERARCHY_DEPTH
      //   candidateDepth + 1（child 自身）+ draggedSubtreeHeight + 1（层数 = 深度 + 1）≤ MAX
      const draggedHeight = subtreeHeight(nodes, dragId);
      let mergeCandidate: RFNode | null = null;
      const intersecting = rf.getIntersectingNodes(draggedNode);
      for (const n of intersecting) {
        if (n.id === dragId) continue;
        if (n.id === GHOST_ID || n.type === 'mergeGhost') continue;
        if (isDescendantOf(n.id, dragId)) continue;
        // 已在该父下 —— 无需再合并
        if (draggedNode.parentId === n.id) continue;
        // 深度检查：挂上后不能超层
        const candDepth = depthOf(nodes, n.id);
        if (candDepth + 1 + draggedHeight + 1 > MAX_HIERARCHY_DEPTH) continue;

        if (n.type === 'group') {
          mergeCandidate = n;
          break;
        }
        if (!mergeCandidate) mergeCandidate = n;
      }

      const candidateId = mergeCandidate?.id ?? null;
      if (candidateId !== mergeCandidateRef.current) {
        clearMergeTimer();
        mergeCandidateRef.current = candidateId;
        if (candidateId) {
          mergeTimerRef.current = window.setTimeout(() => {
            setDragState((s) =>
              s && s.dragId === dragId
                ? { ...s, mergeTarget: candidateId }
                : s,
            );
          }, MERGE_HOVER_MS);
        } else {
          setDragState((s) =>
            s && s.mergeTarget ? { ...s, mergeTarget: null } : s,
          );
        }
      }

      // ===== 2. Ungroup 警告检测：子节点中心是否明显越出父框 =====
      if (draggedNode.parentId) {
        const parentRfNode = rf.getNode(draggedNode.parentId);
        const pw = parentRfNode?.measured?.width ?? parentRfNode?.width ?? GROUP_MIN_W;
        const ph = parentRfNode?.measured?.height ?? parentRfNode?.height ?? GROUP_MIN_H;
        const cx = draggedNode.position.x + CHILD_DEFAULT_W / 2;
        const cy = draggedNode.position.y + CHILD_DEFAULT_H / 2;
        const escaped =
          cx < -UNGROUP_ESCAPE_PX ||
          cy < -UNGROUP_ESCAPE_PX ||
          cx > pw + UNGROUP_ESCAPE_PX ||
          cy > ph + UNGROUP_ESCAPE_PX;

        const parentId = draggedNode.parentId;
        if (escaped) {
          if (ungroupCandidateRef.current !== parentId) {
            clearUngroupTimer();
            ungroupCandidateRef.current = parentId;
            ungroupTimerRef.current = window.setTimeout(() => {
              setDragState((s) =>
                s && s.dragId === dragId
                  ? { ...s, ungroupFrom: parentId }
                  : s,
              );
            }, UNGROUP_CONFIRM_MS);
          }
        } else {
          if (ungroupCandidateRef.current) {
            clearUngroupTimer();
            setDragState((s) =>
              s && s.ungroupFrom ? { ...s, ungroupFrom: null } : s,
            );
          }
        }
      }
    },
    [rf, nodes, isDescendantOf, clearMergeTimer, clearUngroupTimer],
  );

  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent, node: RFNode) => {
      draggingRef.current = true;
      setDragState({ dragId: node.id, mergeTarget: null, ungroupFrom: null });
    },
    [],
  );

  const onNodeDragStop = useCallback(
    (_evt: React.MouseEvent, draggedNode: RFNode) => {
      const dragId = draggedNode.id;
      const state = dragStateRef.current;
      // 松手时若正好悬停在有效候选上 —— 即便 debounce 定时器还没触发，
      // 也按"已确认"处理。否则手快用户会反复失败。
      const mergeTarget = state?.mergeTarget ?? mergeCandidateRef.current ?? null;
      const ungroupFrom = state?.ungroupFrom ?? null;

      setDragState(null);
      clearMergeTimer();
      clearUngroupTimer();
      draggingRef.current = false;

      // mergeAllowed 限制已经在 onNodeDrag 挡掉了"父/子节点被拖合并"的情况，
      // 所以走到 merge 分支时，被拖的一定是自由节点 —— 不会同时持有 ungroupFrom。
      // 顺序上把 ungroup 放在前面表意更清晰：「拖出父框」优先解释为「脱离」而非「再合并」。
      // 三层嵌套下 ungroup 只脱一层 —— 孙节点拖出父框应该落到祖父而不是顶层
      if (ungroupFrom && draggedNode.parentId === ungroupFrom) {
        ascendOneLevel(dragId);
        return;
      }

      if (mergeTarget) {
        const targetNode = rf.getNode(mergeTarget);
        if (targetNode) {
          const childIds = parentMap.get(mergeTarget) ?? [];
          let offsetY = GROUP_PADDING_Y + 4;
          for (const cid of childIds) {
            if (cid === dragId) continue;
            const c = rf.getNode(cid);
            if (c) offsetY = Math.max(offsetY, c.position.y + CHILD_DEFAULT_H + 12);
          }
          setParent(dragId, mergeTarget, { x: GROUP_PADDING_X, y: offsetY });
          return;
        }
      }

      updateTasksBulk([
        {
          id: dragId,
          patch: { x: draggedNode.position.x, y: draggedNode.position.y },
        },
      ]);
      // 子节点被拖到父框的左/上方（负相对坐标）会让父框无法包围 —— 归一化一次
      // 多层嵌套下：链路上所有祖先都需要跟着重算（否则祖父框不会跟着涨）
      if (draggedNode.parentId) {
        const storeNodes = useTaskStore.getState().nodes;
        const byId = new Map(storeNodes.map((n) => [n.id, n]));
        let cur: string | undefined = draggedNode.parentId;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          normalizeGroupBounds(cur);
          cur = byId.get(cur)?.parentId;
        }
      }
    },
    [rf, parentMap, setParent, ascendOneLevel, updateTasksBulk, normalizeGroupBounds, clearMergeTimer, clearUngroupTimer],
  );

  const isValidConnection = useCallback(
    (c: Connection | RFEdge) => {
      const source = (c as Connection).source ?? (c as RFEdge).source;
      const target = (c as Connection).target ?? (c as RFEdge).target;
      if (!source || !target || source === target) return false;
      return !wouldCreateCycle(graph, source, target);
    },
    [graph],
  );

  // ===== 拖线到空白处创建新节点 =====
  // onConnect 只在两端都是 handle 时触发；落空不会触发。
  // onConnectEnd 无论落点在哪都会触发 —— 我们在此处判断落点是否是空白并创建。
  const connectStartRef = useRef<{ nodeId: string } | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{
    /** 屏幕坐标（相对于容器），用于定位输入框 */
    screenX: number;
    screenY: number;
    /** 画布坐标，用于存储新节点位置 */
    flowX: number;
    flowY: number;
    fromId: string;
  } | null>(null);

  const onConnectStart = useCallback(
    (_: unknown, params: { nodeId: string | null }) => {
      connectStartRef.current = params.nodeId ? { nodeId: params.nodeId } : null;
    },
    [],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) addEdge(c.source, c.target);
    },
    [addEdge],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const start = connectStartRef.current;
      connectStartRef.current = null;
      if (!start) return;

      // 如果连到了某个节点的 handle，React Flow 会触发 onConnect；
      // 这里判断 target 是否命中 handle/node，若命中则不处理
      const target = event.target as HTMLElement | null;
      if (target?.closest('.react-flow__handle')) return;
      if (target?.closest('.react-flow__node')) return;

      // 计算落点画布坐标
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const me = event as MouseEvent;
      const cx = 'clientX' in me ? me.clientX : 0;
      const cy = 'clientY' in me ? me.clientY : 0;
      const screenX = cx - rect.left;
      const screenY = cy - rect.top;
      const flow = rf.screenToFlowPosition({ x: cx, y: cy });
      setPendingCreate({
        screenX,
        screenY,
        flowX: flow.x - 90,
        flowY: flow.y - 28,
        fromId: start.nodeId,
      });
    },
    [rf],
  );

  const commitPendingCreate = useCallback(
    (title: string) => {
      if (!pendingCreate) return;
      const task = addTask({
        title,
        priority: 2,
        x: pendingCreate.flowX,
        y: pendingCreate.flowY,
      });
      // 空格键创建时 fromId 为空，不创建依赖边
      if (pendingCreate.fromId) {
        addEdge(pendingCreate.fromId, task.id);
      }
      setPendingCreate(null);
    },
    [pendingCreate, addTask, addEdge],
  );

  const cancelPendingCreate = useCallback(() => {
    // 空输入 → 什么都不创建
    setPendingCreate(null);
  }, []);

  const onEdgeClick = useCallback(
    (_evt: React.MouseEvent, e: RFEdge) => {
      if (confirm('删除这条依赖?')) removeEdge(e.source, e.target);
    },
    [removeEdge],
  );

  const applyAutoLayout = useCallback(() => {
    // 父节点参与布局；子节点相对父节点的布局由 dagre 当作独立节点处理
    // 为了简单起见，仅对 "顶层" 节点（parentId 为空的）跑 dagre；
    // 子节点保留在其父容器内的相对位置。
    //
    // 关键：父节点（group）要告诉 dagre 它的真实尺寸 —— 否则 dagre 按默认
    // 180x56 布局，兄弟节点就会撞进父框里。
    const topLevel = rfNodes.filter((n) => !n.parentId);
    const topLevelSet = new Set(topLevel.map((n) => n.id));
    const topLevelEdges = rfEdges.filter(
      (e) => topLevelSet.has(e.source) && topLevelSet.has(e.target),
    );
    const { nodes: laid } = dagreLayout(topLevel, topLevelEdges, (n) => {
      // sync effect 在 rfNode 上已经设好 width/height（group 节点）
      const w = typeof n.width === 'number' ? n.width : undefined;
      const h = typeof n.height === 'number' ? n.height : undefined;
      if (w !== undefined && h !== undefined) return { width: w, height: h };
      return { width: CHILD_DEFAULT_W, height: CHILD_DEFAULT_H };
    });
    const byId = new Map(laid.map((n) => [n.id, n.position]));
    setRfNodes((prev) =>
      prev.map((p) =>
        p.parentId ? p : { ...p, position: byId.get(p.id) ?? p.position },
      ),
    );
    const patches = laid.map((n) => ({
      id: n.id,
      patch: { x: n.position.x, y: n.position.y },
    }));
    updateTasksBulk(patches);
    setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
  }, [rfNodes, rfEdges, updateTasksBulk, rf]);

  // 初次进入图视图若所有节点都在 (0,0) 附近则自动布局一次
  useEffect(() => {
    const allAtOrigin = nodes.length > 0 && nodes.every((n) => !n.x && !n.y);
    if (allAtOrigin) applyAutoLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 视口中心：mount 时初始化；后续通过 onMove / onMoveEnd 更新（rAF 节流） =====
  const vpRafRef = useRef<number | null>(null);
  const updateViewportCenter = useCallback(() => {
    if (vpRafRef.current != null) return;
    vpRafRef.current = requestAnimationFrame(() => {
      vpRafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const p = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      startTransition(() => {
        setViewportCenter({ x: p.x, y: p.y });
      });
    });
  }, [rf, setViewportCenter]);

  useEffect(() => {
    updateViewportCenter();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateViewportCenter);
    ro.observe(el);
    return () => {
      if (vpRafRef.current != null) cancelAnimationFrame(vpRafRef.current);
      ro.disconnect();
      setViewportCenter(null);
    };
  }, [updateViewportCenter, setViewportCenter]);

  const onMoveEnd = useCallback(
    (_e: MouseEvent | TouchEvent | null, _v: Viewport) => updateViewportCenter(),
    [updateViewportCenter],
  );

  // ===== Shift+左键框选 =====
  const selectedIdsRef = useRef<string[]>([]);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);

  const onSelectionChange = useCallback((p: OnSelectionChangeParams) => {
    // 用 ref 同步写入，保证 onSelectionEnd 能读到最新值
    selectedIdsRef.current = p.nodes.map((n) => n.id);
  }, []);

  const onSelectionEnd = useCallback((event: React.MouseEvent | MouseEvent) => {
    const ids = selectedIdsRef.current;
    if (ids.length < 1) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx =
      'clientX' in event
        ? (event as MouseEvent).clientX
        : rect.left + rect.width / 2;
    const cy =
      'clientY' in event
        ? (event as MouseEvent).clientY
        : rect.top + rect.height / 2;
    setSelectionMenu({ x: cx - rect.left, y: cy - rect.top, ids: [...ids] });
  }, []);

  const selectionActions: SelectionMenuAction[] = useMemo(() => {
    if (!selectionMenu) return [];
    const ids = selectionMenu.ids;
    const firstId = ids[0];
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const allHaveSameParent =
      firstId !== undefined &&
      ids.every((id) => nodesById.get(id)?.parentId === nodesById.get(firstId)?.parentId);

    return [
      {
        label: `归入新分组 (${ids.length})`,
        hint: '创建父任务',
        onClick: () => {
          const title = prompt('分组名称:', '新分组');
          if (title === null) return; // 取消
          groupTasks(ids, { title: title || '新分组' });
        },
        disabled: ids.length < 2,
      },
      {
        label: '解除分组',
        hint: '清除 parentId',
        onClick: () => {
          for (const id of ids) setParent(id, null);
        },
        disabled: !ids.some((id) => nodesById.get(id)?.parentId),
      },
      {
        label: '水平对齐',
        hint: '按首个节点 Y',
        onClick: () => {
          if (firstId === undefined) return;
          const first = nodesById.get(firstId);
          if (!first) return;
          updateTasksBulk(ids.map((id) => ({ id, patch: { y: first.y ?? 0 } })));
        },
        disabled: ids.length < 2 || !allHaveSameParent,
      },
      {
        label: '垂直对齐',
        hint: '按首个节点 X',
        onClick: () => {
          if (firstId === undefined) return;
          const first = nodesById.get(firstId);
          if (!first) return;
          updateTasksBulk(ids.map((id) => ({ id, patch: { x: first.x ?? 0 } })));
        },
        disabled: ids.length < 2 || !allHaveSameParent,
      },
      {
        label: '删除选中',
        hint: `${ids.length} 个`,
        danger: true,
        onClick: () => {
          if (!confirm(`删除选中的 ${ids.length} 个任务?`)) return;
          for (const id of ids) deleteTask(id);
        },
      },
    ];
  }, [selectionMenu, nodes, groupTasks, setParent, updateTasksBulk, deleteTask]);

  return (
    <div ref={containerRef} className="relative h-full w-full" onMouseMove={handleContainerMouseMove} onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-border bg-card/90 p-2 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          拖 <b>●</b> 连边；拖到空白处创建新节点；<kbd className="text-[10px]">Shift</kbd>+左键框选
        </span>
        <div className="mx-1 h-4 w-px bg-border" />
        <Button variant="outline" size="sm" className="gap-1 h-7" onClick={applyAutoLayout}>
          <Layout className="h-3.5 w-3.5" />
          自动布局
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1 h-7"
          onClick={() => rf.fitView({ padding: 0.2 })}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          适配
        </Button>
      </div>

      <ReactFlow
        nodes={renderNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onEdgeClick={onEdgeClick}
        onSelectionChange={onSelectionChange}
        onSelectionEnd={onSelectionEnd}
        onMoveEnd={onMoveEnd}
        // UE Blueprint 风格：
        // - 默认左键拖空白 = 平移（panOnDrag 默认 true，左键）
        // - 按住 Shift 左键拖 = 框选（selectionKeyCode）
        // React Flow 的语义：selectionKeyCode 被按下时 panOnDrag 自动让位给框选
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control']}
        // onlyRenderVisibleElements 需节点显式 width/height，否则首帧可能被误判到视口外。
        // 目前普通任务节点没有显式尺寸，保守起见不开启；改用 data 稳定化 + memo 缓解渲染开销。
        defaultEdgeOptions={{ interactionWidth: 20 }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background gap={24} size={1} color="hsl(var(--border))" />
        <Controls />
        <MiniMap
          pannable
          zoomable
          ariaLabel="概览"
          position="bottom-right"
          nodeColor={(node) => {
            const s = (node.data as TaskNodeData | undefined)?.status;
            if (s === 'done') return 'hsl(var(--muted-foreground) / 0.6)';
            if (s === 'doing') return 'hsl(var(--primary))';
            return 'hsl(var(--muted-foreground) / 0.35)';
          }}
          nodeStrokeWidth={0}
          nodeBorderRadius={3}
          maskColor="hsl(var(--background) / 0.6)"
          maskStrokeColor="hsl(var(--border))"
          maskStrokeWidth={1}
          className="!bg-card/80 !border-border !rounded-lg !shadow-md backdrop-blur"
          style={{ width: 160, height: 110 }}
        />
      </ReactFlow>

      {pendingCreate && (
        <InlineCreateInput
          x={pendingCreate.screenX}
          y={pendingCreate.screenY}
          onCommit={commitPendingCreate}
          onCancel={cancelPendingCreate}
        />
      )}

      {selectionMenu && (
        <SelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          actions={selectionActions}
          onClose={() => setSelectionMenu(null)}
        />
      )}
    </div>
  );
}

/** 浅比较 data 对象，命中则复用旧引用以保持 React Flow memo 生效 */
function shallowEqualData(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export function GraphView() {
  return (
    <ReactFlowProvider>
      <GraphViewInner />
    </ReactFlowProvider>
  );
}
