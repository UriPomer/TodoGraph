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
} from '@xyflow/react';
import { Layout, Maximize2 } from 'lucide-react';
import { wouldCreateCycle } from '@todograph/core';
import {
  MAX_HIERARCHY_DEPTH,
  MAX_PAGE_TITLE_LENGTH,
  type CollisionRect,
  computeNodeSizeMap,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_W,
  CHILD_DEFAULT_H,
  GROUP_MIN_W,
  GROUP_MIN_H,
  computeNodeGeometryMap,
  resolveClusterTranslationAvoidingOccupied,
  type Task,
} from '@todograph/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { UndoRedoButtons } from '@/components/UndoRedoButtons';
import { buildHierarchyMetrics, useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { TaskNode, type TaskNodeData } from './TaskNode';
import { GroupNode, type GroupNodeData } from './GroupNode';
import { SelectionMenu, type SelectionMenuAction } from './SelectionMenu';
import { dialog } from '@/components/ui/dialog-store';
import { InlineCreateInput } from './InlineCreateInput';
import { dagreLayout, layoutNestedGroupChildren } from './useAutoLayout';
import { resolvePinnedDropPushAway } from './dropCollision';
import { useTouchManager } from './useTouchManager';
import {
  PAGE_VIEWPORT_MAX_ZOOM,
  usePageViewportLifecycle,
} from './usePageViewportLifecycle';
import { MultiDragSession } from './multiDragSession';
import { claimPageForAutoLayout, fitPageAfterAutoLayout } from './pageAutoLayout';
import { buildGraphNodeProjection } from './graphNodeProjection';
const nodeTypes: NodeTypes = {
  task: TaskNode,
  group: GroupNode,
};
/** 认定为「明显离开父框」所需的最小像素 —— 轻微拖动不触发 ungroup 提示 */
const UNGROUP_ESCAPE_PX = 12;
const DESKTOP_MIN_ZOOM = 0.5;
const MOBILE_MIN_ZOOM = 0.1;
const MOBILE_FIT_MIN_ZOOM = 0.35;
const MINI_MAP_STYLE = { width: 160, height: 110 } as const;
interface RFTaskNode extends RFNode<TaskNodeData | GroupNodeData> {}

function GraphViewInner({ viewportScope }: { viewportScope: 'desktop' | 'mobile' }) {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);
  const activePageId = useTaskStore((s) => s.activePageId);
  const addTask = useTaskStore((s) => s.addTask);
  const addEdge = useTaskStore((s) => s.addEdge);
  const removeEdge = useTaskStore((s) => s.removeEdge);
  const insertBetween = useTaskStore((s) => s.insertBetween);
  const updateTasksBulk = useTaskStore((s) => s.updateTasksBulk);
  const syncMeasuredSizes = useTaskStore((s) => s.syncMeasuredSizes);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const deleteTasks = useTaskStore((s) => s.deleteTasks);
  const detachTasks = useTaskStore((s) => s.detachTasks);
  const setParent = useTaskStore((s) => s.setParent);
  const groupTasks = useTaskStore((s) => s.groupTasks);
  const normalizeGroupBounds = useTaskStore((s) => s.normalizeGroupBounds);
  const ascendOneLevel = useTaskStore((s) => s.ascendOneLevel);
  const setViewportCenter = useTaskStore((s) => s.setViewportCenter);
  const workspaceMeta = useWorkspaceStore((s) => s.meta);
  const pageViewportCache = useWorkspaceStore((s) => s.pageViewportCache);
  const moveNodesToPage = useWorkspaceStore((s) => s.moveNodesToPage);
  const { graph, readySet, recommended } = useDerived();
  const rf = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const getViewportDimensions = useCallback(() => ({
    width: containerRef.current?.clientWidth ?? 0,
    height: containerRef.current?.clientHeight ?? 0,
  }), []);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const handleContainerMouseMove = useCallback((e: React.MouseEvent) => {
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const [rfNodes, setRfNodes] = useState<RFTaskNode[]>([]);
  const [rfNodesPageId, setRfNodesPageId] = useState<string | null>(null);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === ' ' || e.key === 'Enter') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        const selIds = selectedIdsRef.current;
        if (selIds.length === 1) {
          const selectedId = selIds[0]!;
          const selNode = nodes.find((n) => n.id === selectedId);
          if (selNode) {
            const selRFNode = rfNodes.find((n) => n.id === selectedId);
            if (selRFNode && selRFNode.type === 'group') {
              const metrics = buildHierarchyMetrics(nodes);
              const depth = metrics.depthById.get(selectedId) ?? 0;
              if (depth + 1 < MAX_HIERARCHY_DEPTH) {
                const siblings = nodes.filter((n) => n.parentId === selectedId);
                let childY = GROUP_PADDING_Y;
                for (const s of siblings) {
                  const b = (s.y ?? 0) + CHILD_DEFAULT_H;
                  if (b > childY) childY = b;
                }
                setPendingCreate({
                  flowX: GROUP_PADDING_X,
                  flowY: childY + 12,
                  fromId: '',
                  fromHandleType: null,
                  parentId: selIds[0],
                });
                return;
              }
              return;
            }
          }
        }
        const flow = rf.screenToFlowPosition(lastMousePosRef.current);
        setPendingCreate({
          flowX: flow.x - 90,
          flowY: flow.y - 28,
          fromId: '',
          fromHandleType: null,
        });
      }
    },
    [rf, nodes, rfNodes],
  );
  const draggingRef = useRef(false);
  const [isNodeDragging, setIsNodeDragging] = useState(false);
  /**
   * 是否处于"多选拖动"—— 多选时禁用合并/ungroup 判定，drag stop 时批量 flush
   * 所有被选节点的新位置。否则 bug1：多选拖动末态错乱 + 误形成父子。
   */
  const isMultiDragRef = useRef(false);
  const multiDragSessionRef = useRef(new MultiDragSession());
  const dragDescendantIdsRef = useRef(new Set<string>());
  const hierarchyMetrics = useMemo(() => buildHierarchyMetrics(nodes), [nodes]);
  const parentMap = hierarchyMetrics.childIdsByParentId;
  const byId = hierarchyMetrics.byId;
  const depthById = hierarchyMetrics.depthById;
  const subtreeHeightById = hierarchyMetrics.subtreeHeightById;
  const nodeGeometryById = useMemo(() => computeNodeGeometryMap(nodes), [nodes]);
  const dataCacheRef = useRef(new Map<string, TaskNodeData | GroupNodeData>());
  const prevGroupSizesRef = useRef(new Map<string, { w: number; h: number }>());
  const [resizedGroupIds, setResizedGroupIds] = useState<string[]>([]);
  useEffect(() => {
    if (draggingRef.current) return;
    const projection = buildGraphNodeProjection({
      nodes,
      hierarchy: hierarchyMetrics,
      geometryById: nodeGeometryById,
      readySet,
      recommendedId: recommended?.id,
      previousData: dataCacheRef.current,
    });
    const prevSizes = prevGroupSizesRef.current;
    const changed: string[] = [];
    for (const [pid, cur] of projection.groupSizes) {
      const old = prevSizes.get(pid);
      if (!old || old.w !== cur.w || old.h !== cur.h) changed.push(pid);
    }
    prevGroupSizesRef.current = projection.groupSizes;
    if (changed.length > 0) {
      setResizedGroupIds(changed);
    }

    dataCacheRef.current = projection.dataById;
    setRfNodes(projection.nodes);
    setRfNodesPageId(activePageId);
  }, [activePageId, nodes, readySet, recommended, hierarchyMetrics, nodeGeometryById]);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const ids = new Set<string>([...parentMap.keys(), ...resizedGroupIds]);
    if (ids.size === 0) return;
    const frame = requestAnimationFrame(() => {
      updateNodeInternals([...ids]);
    });
    return () => cancelAnimationFrame(frame);
  }, [parentMap, resizedGroupIds, updateNodeInternals]);
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
  const miniMapNodeColor = useCallback((node: RFNode) => {
    const status = (node.data as TaskNodeData | undefined)?.status;
    if (status === 'done') return 'hsl(var(--muted-foreground) / 0.6)';
    if (status === 'doing') return 'hsl(var(--primary))';
    return 'hsl(var(--muted-foreground) / 0.35)';
  }, []);

  /** 拖动帧只更新位置；尺寸变化同步到布局几何；碰撞统一在 drag stop 处理。 */
  const onNodesChange = useCallback(
    (changes: NodeChange<RFTaskNode>[]) => {
      setRfNodes((prev) => applyNodeChanges(changes, prev));
      const measurements: Array<{ id: string; width: number; height: number }> = [];
      for (const c of changes) {
        if (c.type === 'position') {
          if (c.dragging) draggingRef.current = true;
          else draggingRef.current = false;
        }
        if (c.type === 'dimensions' && c.dimensions && !parentMap.has(c.id)) {
          measurements.push({
            id: c.id,
            width: c.dimensions.width,
            height: c.dimensions.height,
          });
        }
        if (c.type === 'remove' && c.id) {
          deleteTask(c.id);
        }
      }
      syncMeasuredSizes(measurements);
    },
    [deleteTask, parentMap, syncMeasuredSizes],
  );
  const resolveDropPushAway = useCallback(
    (draggedNode: RFNode): Array<{ id: string; x: number; y: number }> => {
      const draggedLocal = rfNodes.find((n) => n.id === draggedNode.id);
      const pinned: CollisionRect = {
        id: draggedNode.id,
        x: draggedNode.position.x,
        y: draggedNode.position.y,
        w:
          draggedNode.measured?.width ??
          draggedNode.width ??
          draggedLocal?.measured?.width ??
          draggedLocal?.width ??
          (draggedNode.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
        h:
          draggedNode.measured?.height ??
          draggedNode.height ??
          draggedLocal?.measured?.height ??
          draggedLocal?.height ??
          (draggedNode.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
      };
      const occupied: CollisionRect[] = rfNodes
        .filter(
          (n) =>
            n.id !== draggedNode.id &&
            n.parentId === draggedNode.parentId,
        )
        .map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          w: n.measured?.width ?? n.width ?? (n.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
          h: n.measured?.height ?? n.height ?? (n.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
        }));
      return resolvePinnedDropPushAway({ pinned, occupied });
    },
    [rfNodes],
  );
  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent, node: RFNode) => {
      const startsNewGesture = !draggingRef.current;
      draggingRef.current = true;
      setIsNodeDragging(true);
      if (startsNewGesture) {
        multiDragSessionRef.current.start(selectedIdsRef.current);
      }
      isMultiDragRef.current = multiDragSessionRef.current.active;
      const descSet = new Set<string>();
      descSet.add(node.id);
      const stack = [node.id];
      while (stack.length) {
        const id = stack.pop()!;
        const children = parentMap.get(id) ?? [];
        for (const cid of children) {
          if (!descSet.has(cid)) {
            descSet.add(cid);
            stack.push(cid);
          }
        }
      }
      dragDescendantIdsRef.current = descSet;
    },
    [parentMap],
  );
  const onNodeDragStop = useCallback(
    (_evt: React.MouseEvent, draggedNode: RFNode) => {
      const dragId = draggedNode.id;
      draggingRef.current = false;
      setIsNodeDragging(false);
      const multiStopAction = multiDragSessionRef.current.stop(dragId);
      if (multiStopAction === 'ignore') return;
      if (multiStopAction === 'commit') {
        isMultiDragRef.current = false;
        const selected = rfNodes.filter((n) => n.selected);
        const selectedIds = new Set(selected.map((n) => n.id));
        const translationById = new Map<string, { dx: number; dy: number }>();
        const selectedByParent = new Map<string, RFTaskNode[]>();
        const unselectedByParent = new Map<string, RFTaskNode[]>();
        for (const node of selected) {
          const key = node.parentId ?? '';
          const group = selectedByParent.get(key);
          if (group) group.push(node);
          else selectedByParent.set(key, [node]);
        }
        for (const node of rfNodes) {
          if (selectedIds.has(node.id)) continue;
          const key = node.parentId ?? '';
          const group = unselectedByParent.get(key);
          if (group) group.push(node);
          else unselectedByParent.set(key, [node]);
        }
        for (const group of selectedByParent.values()) {
          const parentId = group[0]?.parentId;
          const toRect = (node: RFTaskNode): CollisionRect => ({
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            w: node.measured?.width ?? node.width ?? (node.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
            h: node.measured?.height ?? node.height ?? (node.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
          });
          const occupied = (unselectedByParent.get(parentId ?? '') ?? []).map(toRect);
          const translation = resolveClusterTranslationAvoidingOccupied(group.map(toRect), occupied);
          for (const node of group) translationById.set(node.id, translation);
        }
        const patches = selected.map((node) => {
          const translation = translationById.get(node.id) ?? { dx: 0, dy: 0 };
          return {
            id: node.id,
            patch: {
              x: node.position.x + translation.dx,
              y: node.position.y + translation.dy,
            },
          };
        });
        if ([...translationById.values()].some(({ dx, dy }) => dx !== 0 || dy !== 0)) {
          setRfNodes((prev) =>
            prev.map((node) => {
              const translation = translationById.get(node.id);
              return translation
                ? {
                    ...node,
                    position: {
                      x: node.position.x + translation.dx,
                      y: node.position.y + translation.dy,
                    },
                  }
                : node;
            }),
          );
        }
        if (patches.length > 0) updateTasksBulk(patches);
        const storeNodes = useTaskStore.getState().nodes;
        const byId = new Map(storeNodes.map((n) => [n.id, n]));
        const seen = new Set<string>();
        for (const n of rfNodes) {
          if (!n.selected || !n.parentId) continue;
          let cur: string | undefined = n.parentId;
          while (cur && !seen.has(cur)) {
            seen.add(cur);
            normalizeGroupBounds(cur);
            cur = byId.get(cur)?.parentId;
          }
        }
        return;
      }

      let ungroupFrom: string | null = null;
      if (draggedNode.parentId) {
        const parentNode = rf.getNode(draggedNode.parentId);
        const parentWidth = parentNode?.measured?.width ?? parentNode?.width ?? GROUP_MIN_W;
        const parentHeight = parentNode?.measured?.height ?? parentNode?.height ?? GROUP_MIN_H;
        const draggedWidth = draggedNode.measured?.width ?? draggedNode.width ?? CHILD_DEFAULT_W;
        const draggedHeight = draggedNode.measured?.height ?? draggedNode.height ?? CHILD_DEFAULT_H;
        const centerX = draggedNode.position.x + draggedWidth / 2;
        const centerY = draggedNode.position.y + draggedHeight / 2;
        if (
          centerX < -UNGROUP_ESCAPE_PX ||
          centerY < -UNGROUP_ESCAPE_PX ||
          centerX > parentWidth + UNGROUP_ESCAPE_PX ||
          centerY > parentHeight + UNGROUP_ESCAPE_PX
        ) {
          ungroupFrom = draggedNode.parentId;
        }
      }

      if (ungroupFrom && draggedNode.parentId === ungroupFrom) {
        ascendOneLevel(dragId);
        return;
      }

      const draggedSubtreeHeight = subtreeHeightById.get(dragId) ?? 0;
      let mergeTarget: string | null = null;
      for (const candidate of rf.getIntersectingNodes(draggedNode)) {
        if (candidate.id === dragId) continue;
        if (dragDescendantIdsRef.current.has(candidate.id)) continue;
        if (draggedNode.parentId === candidate.id) continue;
        const candidateDepth = depthById.get(candidate.id) ?? 0;
        if (candidateDepth + draggedSubtreeHeight + 2 > MAX_HIERARCHY_DEPTH) continue;
        if (candidate.type === 'group') {
          mergeTarget = candidate.id;
          break;
        }
        if (!mergeTarget) mergeTarget = candidate.id;
      }

      if (mergeTarget) {
        const targetNode = rf.getNode(mergeTarget);
        if (targetNode) {
          const childIds = parentMap.get(mergeTarget) ?? [];
          let offsetY = GROUP_PADDING_Y + 4;
          for (const cid of childIds) {
            if (cid === dragId) continue;
            const c = rf.getNode(cid);
            if (c) {
              const childHeight = c.measured?.height ?? c.height ?? CHILD_DEFAULT_H;
              offsetY = Math.max(offsetY, c.position.y + childHeight + 12);
            }
          }
          setParent(dragId, mergeTarget, { x: GROUP_PADDING_X, y: offsetY });
          return;
        }
      }

      const movedSiblings = resolveDropPushAway(draggedNode);
      if (movedSiblings.length > 0) {
        const movedById = new Map(movedSiblings.map((item) => [item.id, item]));
        setRfNodes((prev) =>
          prev.map((n) => {
            const moved = movedById.get(n.id);
            return moved ? { ...n, position: { x: moved.x, y: moved.y } } : n;
          }),
        );
      }

      updateTasksBulk([
        { id: dragId, patch: { x: draggedNode.position.x, y: draggedNode.position.y } },
        ...movedSiblings.map((item) => ({
          id: item.id,
          patch: { x: item.x, y: item.y },
        })),
      ]);
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
    [rf, parentMap, setParent, ascendOneLevel, updateTasksBulk, normalizeGroupBounds, rfNodes, resolveDropPushAway, depthById, subtreeHeightById],
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
  const connectStartRef = useRef<{ nodeId: string; handleType: string | null } | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{
    flowX: number;
    flowY: number;
    fromId: string;
    fromHandleType: string | null;
    parentId?: string;
  } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    return () => document.removeEventListener('pointermove', onMove, { capture: true });
  }, []);
  const onConnectStart = useCallback(
    (_: unknown, params: { nodeId: string | null; handleType: string | null }) => {
      connectStartRef.current = params.nodeId ? { nodeId: params.nodeId, handleType: params.handleType } : null;
    },
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) {
        connectStartRef.current = null; // 连线成功 → 阻止 onConnectEnd 再弹创建框
        addEdge(c.source, c.target);
      }
    },
    [addEdge],
  );
  const onConnectEnd = useCallback(
    () => {
      const start = connectStartRef.current;
      connectStartRef.current = null;
      if (!start) return;
      const pos = lastPointerRef.current;
      if (!pos) return;
      const el = document.elementFromPoint(pos.x, pos.y);
      if (el?.closest('.react-flow__handle, .react-flow__node')) return;
      const flow = rf.screenToFlowPosition({ x: pos.x, y: pos.y });
      setPendingCreate({
        flowX: flow.x - 90,
        flowY: flow.y - 28,
        fromId: start.nodeId,
        fromHandleType: start.handleType,
      });
    },
    [rf],
  );
  const commitPendingCreate = useCallback(
    (title: string) => {
      if (!pendingCreate) return;
      const opts: { title: string; x: number; y: number; parentId?: string } = {
        title,
        x: pendingCreate.flowX,
        y: pendingCreate.flowY,
      };
      if (pendingCreate.parentId) opts.parentId = pendingCreate.parentId;
      const task = addTask(opts);
      if (pendingCreate.fromId) {
        if (pendingCreate.fromHandleType === 'target') {
          addEdge(task.id, pendingCreate.fromId);
        } else {
          addEdge(pendingCreate.fromId, task.id);
        }
      }
      setPendingCreate(null);
    },
    [pendingCreate, addTask, addEdge],
  );
  const cancelPendingCreate = useCallback(() => {
    setPendingCreate(null);
  }, []);
  const hasPendingCreate = useCallback(() => pendingCreate !== null, [pendingCreate]);
  const onLongPressBlank = useCallback(
    (flowX: number, flowY: number) => {
      setPendingCreate({ flowX, flowY, fromId: '', fromHandleType: null });
    },
    [],
  );
  const onCancelCreate = useCallback(() => setPendingCreate(null), []);
  useTouchManager({
    containerRef,
    rf,
    hasPendingCreate,
    onLongPressBlank,
    onCancelPendingCreate: onCancelCreate,
  });
  const onEdgeClick = useCallback(
    async (_evt: React.MouseEvent, e: RFEdge) => {
      const ok = await dialog.confirm('删除这条依赖?', { danger: true });
      if (ok) removeEdge(e.source, e.target);
    },
    [removeEdge],
  );
  const layoutFitRafRef = useRef<number | null>(null);
  const applyAutoLayout = useCallback(() => {
    const groupIds = [...parentMap.keys()].sort(
      (left, right) => (depthById.get(right) ?? 0) - (depthById.get(left) ?? 0),
    );
    const groupLayout = layoutNestedGroupChildren(rfNodes, groupIds, parentMap, (node) => {
      const geometry = nodeGeometryById.get(node.id);
      return geometry
        ? { width: geometry.displayedSize.w, height: geometry.displayedSize.h }
        : {
            width: typeof node.width === 'number' ? node.width : CHILD_DEFAULT_W,
            height: typeof node.height === 'number' ? node.height : CHILD_DEFAULT_H,
          };
    });
    const workingNodes = rfNodes.map((node) => ({
      ...node,
      position: groupLayout.positions.get(node.id)!,
    }));

    const topLevel = workingNodes.filter((n) => !n.parentId);
    const topLevelSet = new Set(topLevel.map((n) => n.id));
    const topLevelEdges = rfEdges.filter(
      (e) => topLevelSet.has(e.source) && topLevelSet.has(e.target),
    );
    const { nodes: laid } = dagreLayout(topLevel, topLevelEdges, (node) => (
      groupLayout.sizes.get(node.id) ?? { width: CHILD_DEFAULT_W, height: CHILD_DEFAULT_H }
    ));
    const finalPositions = new Map(workingNodes.map((node) => [node.id, node.position]));
    for (const node of laid) finalPositions.set(node.id, node.position);
    setRfNodes((prev) =>
      prev.map((node) => ({ ...node, position: finalPositions.get(node.id)! })),
    );
    const patches = workingNodes.map((node) => {
      const position = finalPositions.get(node.id)!;
      return { id: node.id, patch: { x: position.x, y: position.y } };
    });
    updateTasksBulk(patches);
    if (layoutFitRafRef.current !== null) cancelAnimationFrame(layoutFitRafRef.current);
    // Fit only after React Flow has committed the newly calculated positions.
    layoutFitRafRef.current = fitPageAfterAutoLayout((options) => {
      layoutFitRafRef.current = null;
      return rf.fitView(options);
    });
  }, [rfNodes, rfEdges, updateTasksBulk, parentMap, depthById, nodeGeometryById, rf]);
  useEffect(() => () => {
    if (layoutFitRafRef.current !== null) cancelAnimationFrame(layoutFitRafRef.current);
  }, []);
  const autoLayoutCheckedPagesRef = useRef(new Set<string>());
  useEffect(() => {
    const nodeIds = nodes.map((node) => node.id);
    if (
      !activePageId ||
      !claimPageForAutoLayout(
        autoLayoutCheckedPagesRef.current,
        activePageId,
        nodeIds,
        rfNodes,
      )
    ) return;
    const allAtOrigin = nodes.length > 0 && nodes.every((n) => !n.x && !n.y);
    if (allAtOrigin) applyAutoLayout();
  }, [activePageId, applyAutoLayout, nodes, rfNodes]);
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
  const viewportNodeIds = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const viewportRenderedNodes = rfNodes;
  const minZoom = viewportScope === 'mobile' ? MOBILE_MIN_ZOOM : DESKTOP_MIN_ZOOM;
  const fitMinZoom = viewportScope === 'mobile' ? MOBILE_FIT_MIN_ZOOM : DESKTOP_MIN_ZOOM;
  const {
    isMoving: isViewportMoving,
    isRestoring: isViewportRestoring,
    onMoveStart,
    onMoveEnd,
  } = usePageViewportLifecycle({
    activePageId,
    renderedPageId: rfNodesPageId,
    viewportScope,
    fitMinZoom,
    nodeIds: viewportNodeIds,
    renderedNodes: viewportRenderedNodes,
    cache: pageViewportCache,
    rf,
    getViewportDimensions,
    updateViewportCenter,
  });
  const selectedIdsRef = useRef<string[]>([]);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    ids: string[];
  } | null>(null);
  const selectedNodeIds = useMemo(
    () => rfNodes.filter((n) => n.selected).map((n) => n.id),
    [rfNodes],
  );
  const onSelectionChange = useCallback((p: OnSelectionChangeParams) => {
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
  const lastClickPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const onNodeClick = useCallback(
    (_e: React.MouseEvent, _node: RFNode) => {
      lastClickPosRef.current = { x: _e.clientX, y: _e.clientY };
      window.setTimeout(() => {
        const ids = selectedIdsRef.current;
        if (ids.length >= 2) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          setSelectionMenu({
            x: lastClickPosRef.current.x - rect.left,
            y: lastClickPosRef.current.y - rect.top,
            ids: [...ids],
          });
        }
      }, 0);
    },
    [],
  );
  const promptMoveSelectionToPage = useCallback(
    async (idsInput?: string[]) => {
      const ids = [...new Set(idsInput ?? selectedNodeIds)];
      if (ids.length === 0) return;
      if (!workspaceMeta) return;
      const idSet = new Set(ids);
      const selectedTasks = nodes.filter((n) => idSet.has(n.id));
      const defaultTitle = pickDefaultMovePageTitle(selectedTasks, nodes);
      const otherPages = workspaceMeta.pages.filter((page) => page.id !== workspaceMeta.activePageId);
      const raw = await dialog.prompt(
        '移到页面',
        {
          defaultValue: defaultTitle,
          placeholder: `已有：${otherPages.map((p) => p.title).join(' / ')}` || '输入新页面名称',
          maxLength: MAX_PAGE_TITLE_LENGTH,
        },
      );
      if (raw === null) return;
      const title = raw.trim() || defaultTitle;
      const existing = otherPages.find((page) => page.title === title);
      if (existing) {
        await moveNodesToPage(ids, { pageId: existing.id });
      } else {
        await moveNodesToPage(ids, { newPageTitle: title });
      }
      setSelectionMenu(null);
    },
    [selectedNodeIds, nodes, workspaceMeta, moveNodesToPage],
  );
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
        onClick: async () => {
          const title = await dialog.prompt('分组名称', { defaultValue: '新分组' });
          if (title === null) return;
          groupTasks(ids, { title: title || '新分组' });
        },
        disabled: ids.length < 2,
      },
      {
        label: '在中间插入',
        hint: '依赖链插入',
        onClick: async () => {
          const title = await dialog.prompt('新任务名称', { defaultValue: '未命名' });
          if (title === null) return;
          insertBetween(ids[0]!, ids[1]!, title || '未命名');
        },
        disabled: ids.length !== 2,
      },
      {
        label: '解除分组',
        hint: '清除 parentId',
        onClick: () => {
          detachTasks(ids);
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
          updateTasksBulk(buildAlignedPatches(nodes, ids, 'horizontal'));
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
          updateTasksBulk(buildAlignedPatches(nodes, ids, 'vertical'));
        },
        disabled: ids.length < 2 || !allHaveSameParent,
      },
      {
        label: '移到页面',
        hint: ids.length > 1 ? `${ids.length} 个` : '跨页',
        onClick: () => {
          void promptMoveSelectionToPage(ids);
        },
      },
      {
        label: '删除选中',
        hint: `${ids.length} 个`,
        danger: true,
        onClick: async () => {
          const ok = await dialog.confirm(`删除选中的 ${ids.length} 个任务`, { danger: true });
          if (!ok) return;
          deleteTasks(ids);
        },
      },
    ];
  }, [selectionMenu, nodes, groupTasks, setParent, detachTasks, updateTasksBulk, deleteTasks, promptMoveSelectionToPage, insertBetween]);
  return (
    <div ref={containerRef} className={`graph-surface relative h-full w-full${isViewportMoving ? ' graph-viewport-moving' : ''}${isNodeDragging ? ' graph-node-dragging' : ''}${isViewportRestoring ? ' graph-viewport-restoring' : ''}`} style={{ touchAction: 'none', WebkitTouchCallout: 'none' }} onMouseMove={handleContainerMouseMove} onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="graph-toolbar absolute left-3 right-3 top-3 z-10 flex items-center justify-center gap-2 rounded-xl border border-border bg-card/90 p-2 backdrop-blur lg:right-auto lg:justify-start lg:rounded-lg">
        <span className="text-xs text-muted-foreground hidden lg:inline">
          拖 <b>●</b> 连边；拖到空白处创建新节点；<kbd className="text-[10px]">Shift</kbd>+左键框选
        </span>
        <div className="mx-1 h-4 w-px bg-border" />
        <UndoRedoButtons />
        <div className="mx-1 h-4 w-px bg-border" />
        <Button variant="outline" size="sm" className="h-8 min-w-9 gap-1 px-2 lg:h-7 lg:min-w-0" onClick={applyAutoLayout}>
          <Layout className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">自动布局</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 min-w-9 gap-1 px-2 lg:h-7 lg:min-w-0"
          onClick={() => rf.fitView({ padding: 0.2 })}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">适配</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs lg:h-7"
          disabled={selectedNodeIds.length < 1}
          onClick={() => void promptMoveSelectionToPage()}
          title={selectedNodeIds.length < 1 ? '先选中节点' : '移到已有页面或新建页面'}
        >
          移到页面
        </Button>
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onEdgeClick={onEdgeClick}
        onNodeClick={onNodeClick}
        onSelectionChange={onSelectionChange}
        onSelectionEnd={onSelectionEnd}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        connectionRadius={48}
        minZoom={minZoom}
        maxZoom={PAGE_VIEWPORT_MAX_ZOOM}
        defaultEdgeOptions={{ interactionWidth: 32 }}
        onlyRenderVisibleElements={viewportScope === 'mobile'}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background gap={24} size={1} color="hsl(var(--border))" />
        <Controls />
        {!isViewportRestoring && (
          <MiniMap
            pannable
            zoomable
            ariaLabel="概览"
            position="bottom-right"
            nodeColor={miniMapNodeColor}
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
            maskColor="hsl(var(--background) / 0.6)"
            maskStrokeColor="hsl(var(--border))"
            maskStrokeWidth={1}
            className={cn(
              '!bg-card/80 !border-border !rounded-lg !shadow-md',
              viewportScope === 'mobile' ? 'graph-minimap-mobile' : 'backdrop-blur',
            )}
            style={MINI_MAP_STYLE}
          />
        )}
      </ReactFlow>

      {pendingCreate && (
        <InlineCreateInput
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

function pickDefaultMovePageTitle(selected: Task[], allNodes: Task[]): string {
  if (selected.length === 0) return '新页面';
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const [first] = [...selected].sort((a, b) => {
    const ap = worldPositionOf(a, byId);
    const bp = worldPositionOf(b, byId);
    return ap.y - bp.y || ap.x - bp.x || a.title.localeCompare(b.title);
  });
  return first?.title.trim() || '新页面';
}

function worldPositionOf(node: Task, byId: Map<string, Task>): { x: number; y: number } {
  let x = node.x ?? 0;
  let y = node.y ?? 0;
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.x ?? 0;
    y += parent.y ?? 0;
    parentId = parent.parentId;
  }
  return { x, y };
}

export function buildAlignedPatches(
  nodes: Task[],
  ids: readonly string[],
  axis: 'horizontal' | 'vertical',
): Array<{ id: string; patch: Partial<Task> }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = ids.map((id) => byId.get(id)).filter((node): node is Task => Boolean(node));
  if (selected.length === 0) return [];
  const anchor = selected[0]!;
  const sizeMap = computeNodeSizeMap(nodes);
  const ordered = [...selected].sort((a, b) => axis === 'horizontal'
    ? (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0) || a.id.localeCompare(b.id)
    : (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || a.id.localeCompare(b.id));
  let cursor = -Infinity;
  const patches = new Map<string, Partial<Task>>();
  for (const node of ordered) {
    const size = sizeMap.get(node.id)!;
    if (axis === 'horizontal') {
      const x = Math.max(node.x ?? 0, cursor);
      patches.set(node.id, { x, y: anchor.y ?? 0 });
      cursor = x + size.w + 12;
    } else {
      const y = Math.max(node.y ?? 0, cursor);
      patches.set(node.id, { x: anchor.x ?? 0, y });
      cursor = y + size.h + 12;
    }
  }
  return ids.flatMap((id) => {
    const patch = patches.get(id);
    return patch ? [{ id, patch }] : [];
  });
}

export function GraphView({ viewportScope }: { viewportScope: 'desktop' | 'mobile' }) {
  return (
    <ReactFlowProvider>
      <GraphViewInner viewportScope={viewportScope} />
    </ReactFlowProvider>
  );
}
