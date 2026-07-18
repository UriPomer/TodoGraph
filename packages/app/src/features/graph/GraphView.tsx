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
  computeGroupSize,
  computeNodeSizeMap,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_W,
  CHILD_DEFAULT_H,
  GROUP_MIN_W,
  GROUP_MIN_H,
  GROUP_COLLAPSED_MAX_H,
  capGroupSize,
  resolveClusterTranslationAvoidingOccupied,
  type Task,
} from '@todograph/shared';
import { Button } from '@/components/ui/button';
import { UndoRedoButtons } from '@/components/UndoRedoButtons';
import { buildHierarchyMetrics, useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useDerived } from '@/hooks/useRecommendation';
import { TaskNode, type TaskNodeData } from './TaskNode';
import { GroupNode, type GroupNodeData } from './GroupNode';
import { MergeGhostNode, type MergeGhostData } from './MergeGhostNode';
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
import { claimPageForAutoLayout } from './pageAutoLayout';
const nodeTypes: NodeTypes = {
  task: TaskNode,
  group: GroupNode,
  mergeGhost: MergeGhostNode,
};
/** hover 进入目标后多久才显示 ghost 合并预览（ms） */
const MERGE_HOVER_DEFAULT_MS = 700;
/** 子节点中心离开父框后多久才真正 ungroup（ms）—— 期间父框显示红色抖动警告 */
const UNGROUP_CONFIRM_DEFAULT_MS = 600;
/** 认定为「明显离开父框」所需的最小像素 —— 轻微拖动不触发 ungroup 提示 */
const UNGROUP_ESCAPE_PX = 12;
/** ghost overlay 的固定 id —— 用于在命中检测里排除自己 */
const GHOST_ID = '__merge_ghost__';
const DESKTOP_MIN_ZOOM = 0.5;
const MOBILE_MIN_ZOOM = 0.1;
interface RFTaskNode extends RFNode<TaskNodeData | GroupNodeData | MergeGhostData> {}

function GraphViewInner({ viewportScope }: { viewportScope: 'desktop' | 'mobile' }) {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);
  const activePageId = useTaskStore((s) => s.activePageId);
  const addTask = useTaskStore((s) => s.addTask);
  const addEdge = useTaskStore((s) => s.addEdge);
  const removeEdge = useTaskStore((s) => s.removeEdge);
  const insertBetween = useTaskStore((s) => s.insertBetween);
  const updateTasksBulk = useTaskStore((s) => s.updateTasksBulk);
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
  const mergeHoverMs = workspaceMeta?.settings?.mergeHoverMs ?? MERGE_HOVER_DEFAULT_MS;
  const ungroupConfirmMs =
    workspaceMeta?.settings?.ungroupConfirmMs ?? UNGROUP_CONFIRM_DEFAULT_MS;

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
  interface DragState {
    dragId: string;
    /** 悬停在候选上、timer 仍在计时期间 —— 候选节点打"待确认"虚线外框。 */
    mergeCandidatePending: string | null;
    /** timer 触发 / 松手时锁定的合并目标 —— 显示 ghost overlay。 */
    mergeTarget: string | null;
    ungroupFrom: string | null;
  }
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);
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
  useEffect(() => {
    return () => {
      if (mergeTimerRef.current !== null) window.clearTimeout(mergeTimerRef.current);
      if (ungroupTimerRef.current !== null) window.clearTimeout(ungroupTimerRef.current);
    };
  }, []);
  /**
   * 是否处于"多选拖动"—— 多选时禁用合并/ungroup 判定，drag stop 时批量 flush
   * 所有被选节点的新位置。否则 bug1：多选拖动末态错乱 + 误形成父子。
   */
  const isMultiDragRef = useRef(false);
  const multiDragSessionRef = useRef(new MultiDragSession());
  const dragDescendantIdsRef = useRef(new Set<string>());
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
  const hierarchyMetrics = useMemo(() => buildHierarchyMetrics(nodes), [nodes]);
  const depthById = hierarchyMetrics.depthById;
  const subtreeHeightById = hierarchyMetrics.subtreeHeightById;
  const dataCacheRef = useRef(new Map<string, TaskNodeData | GroupNodeData>());
  const prevGroupSizesRef = useRef(new Map<string, { w: number; h: number }>());
  const [resizedGroupIds, setResizedGroupIds] = useState<string[]>([]);
  useEffect(() => {
    if (draggingRef.current) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const groupIds = [...parentMap.keys()];
    groupIds.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));
    const groupSizes = new Map<string, { w: number; h: number }>();
    const collapsedGroupIds = new Set<string>();
    for (const pid of groupIds) {
      const childIds = parentMap.get(pid) ?? [];
      const childPositions: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const cid of childIds) {
        const c = byId.get(cid);
        if (!c) continue;
        const childSize = groupSizes.get(cid);
        childPositions.push({
          x: c.x ?? 0,
          y: c.y ?? 0,
          w: childSize?.w ?? c.width ?? CHILD_DEFAULT_W,
          h: childSize?.h ?? CHILD_DEFAULT_H,
        });
      }
      const fullSize = computeGroupSize(childPositions);
      if (fullSize.h > GROUP_COLLAPSED_MAX_H) collapsedGroupIds.add(pid);
      groupSizes.set(pid, capGroupSize(fullSize));
    }

    const isInsideCollapsedGroup = (node: Task): boolean => {
      const seen = new Set<string>();
      let parentId = node.parentId;
      while (parentId && !seen.has(parentId)) {
        if (collapsedGroupIds.has(parentId)) return true;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
      return false;
    };

    const descendantsOf = (parentId: string): NonNullable<GroupNodeData['descendants']> => {
      const descendants: NonNullable<GroupNodeData['descendants']> = [];
      const visit = (id: string, depth: number) => {
        for (const childId of parentMap.get(id) ?? []) {
          const child = byId.get(childId);
          if (!child) continue;
          descendants.push({
            id: child.id,
            title: child.title,
            status: child.status,
            description: child.description,
            depth,
          });
          visit(child.id, depth + 1);
        }
      };
      visit(parentId, 1);
      return descendants;
    };

    const prevSizes = prevGroupSizesRef.current;
    const changed: string[] = [];
    for (const [pid, cur] of groupSizes) {
      const old = prevSizes.get(pid);
      if (!old || old.w !== cur.w || old.h !== cur.h) changed.push(pid);
    }
    prevGroupSizesRef.current = groupSizes;
    if (changed.length > 0) {
      setResizedGroupIds(changed);
    }

    const sorted = [...nodes].sort(
      (a, b) => (depthById.get(a.id) ?? 0) - (depthById.get(b.id) ?? 0),
    );
    setRfNodes(() => {
      const cache = dataCacheRef.current;
      const nextCache = new Map<string, TaskNodeData | GroupNodeData>();
      const built: RFTaskNode[] = sorted.map((n) => {
        const isGroup = parentMap.has(n.id);
        const size = groupSizes.get(n.id);
        const baseData = isGroup
          ? ({
              title: n.title,
              status: n.status,
              ready: readySet.has(n.id),
              recommended: recommended?.id === n.id,
              childrenCount: parentMap.get(n.id)?.length ?? 0,
              description: n.description,
              isHeightCollapsed: collapsedGroupIds.has(n.id),
              descendants: collapsedGroupIds.has(n.id) ? descendantsOf(n.id) : undefined,
            } as GroupNodeData)
          : ({
              title: n.title,
              status: n.status,
              ready: readySet.has(n.id),
              recommended: recommended?.id === n.id,
              description: n.description,
              nodeWidth: n.width,
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
          position: { x: n.x ?? 0, y: n.y ?? 0 },
          data,
          hidden: isInsideCollapsedGroup(n),
          className: isGroup && collapsedGroupIds.has(n.id) ? 'group-scroll-node' : undefined,
          ...(n.parentId
            ? { parentId: n.parentId }
            : {}),
          ...(isGroup ? { dragHandle: '.group-drag-handle' } : {}),
          ...(isGroup && size
            ? { style: { width: size.w, height: size.h }, width: size.w, height: size.h }
            : {}),
          ...(isGroup
            ? {}
            : { style: { width: n.width ?? CHILD_DEFAULT_W } }),
        };
        return node;
      });
      dataCacheRef.current = nextCache;
      return built;
    });
    setRfNodesPageId(activePageId);
  }, [activePageId, nodes, readySet, recommended, parentMap]);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const ids = new Set<string>([...parentMap.keys(), ...resizedGroupIds]);
    if (ids.size === 0) return;
    const frame = requestAnimationFrame(() => {
      updateNodeInternals([...ids]);
    });
    return () => cancelAnimationFrame(frame);
  }, [parentMap, resizedGroupIds, updateNodeInternals]);
  /**
   * 合成送给 React Flow 的最终节点数组。两种效果：
   *   1. 把 dragState 的 mergeTarget / ungroupFrom 标记写到对应节点的 data 上（不污染源数据）。
   *   2. mergeTarget 存在时追加一个 ghost overlay 节点。
   * sync effect 被 draggingRef 守卫挡住 —— 所以拖拽期间的视觉反馈只能在这里做。
   */
  const renderNodes: RFTaskNode[] = useMemo(() => {
    if (!dragState) return rfNodes;
    const { mergeCandidatePending, mergeTarget, ungroupFrom, dragId } = dragState;
    const flagged = (mergeTarget || ungroupFrom || mergeCandidatePending)
      ? rfNodes.map((n) => {
          if (n.id !== mergeTarget && n.id !== ungroupFrom && n.id !== mergeCandidatePending) return n;
          let extra: Record<string, boolean>;
          if (n.id === mergeTarget) extra = { isMergeTarget: true };
          else if (n.id === ungroupFrom) extra = { isUngroupWarn: true };
          else extra = { isMergePending: true };
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
  const resolveDropPushAway = useCallback(
    (draggedNode: RFNode): Array<{ id: string; x: number; y: number }> => {
      const draggedLocal = rfNodes.find((n) => n.id === draggedNode.id);
      const pinned: CollisionRect = {
        id: draggedNode.id,
        x: draggedNode.position.x,
        y: draggedNode.position.y,
        w:
          draggedNode.width ??
          draggedLocal?.width ??
          (draggedNode.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
        h:
          draggedNode.height ??
          draggedLocal?.height ??
          (draggedNode.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
      };
      const occupied: CollisionRect[] = rfNodes
        .filter(
          (n) =>
            n.id !== draggedNode.id &&
            n.parentId === draggedNode.parentId &&
            n.id !== GHOST_ID,
        )
        .map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          w: n.width ?? (n.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
          h: n.height ?? (n.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
        }));
      return resolvePinnedDropPushAway({ pinned, occupied });
    },
    [rfNodes],
  );
  /**
   * 拖拽过程中：使用 React Flow 的 getIntersectingNodes 做命中检测。
   * 官方 API 已经内置了绝对坐标 + bounding box 计算，不需要手写 computeAbs。
   */
  const onNodeDrag = useCallback(
    (_evt: React.MouseEvent, draggedNode: RFNode) => {
      if (isMultiDragRef.current) return;
      const dragId = draggedNode.id;
      const draggedHeight = subtreeHeightById.get(dragId) ?? 0;
      let mergeCandidate: RFNode | null = null;
      const intersecting = rf.getIntersectingNodes(draggedNode);
      for (const n of intersecting) {
        if (n.id === dragId) continue;
        if (n.id === GHOST_ID || n.type === 'mergeGhost') continue;
        if (dragDescendantIdsRef.current.has(n.id)) continue;
        if (draggedNode.parentId === n.id) continue;
        const candDepth = depthById.get(n.id) ?? 0;
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
          setDragState((s) =>
            s && s.dragId === dragId
              ? { ...s, mergeCandidatePending: candidateId, mergeTarget: null }
              : s,
          );
          mergeTimerRef.current = window.setTimeout(() => {
            setDragState((s) =>
              s && s.dragId === dragId
                ? { ...s, mergeCandidatePending: null, mergeTarget: candidateId }
                : s,
            );
          }, mergeHoverMs);
        } else {
          setDragState((s) =>
            s && (s.mergeTarget || s.mergeCandidatePending)
              ? { ...s, mergeTarget: null, mergeCandidatePending: null }
              : s,
          );
        }
      }

      if (draggedNode.parentId) {
        const parentRfNode = rf.getNode(draggedNode.parentId);
        const pw = parentRfNode?.measured?.width ?? parentRfNode?.width ?? GROUP_MIN_W;
        const ph = parentRfNode?.measured?.height ?? parentRfNode?.height ?? GROUP_MIN_H;
        const draggedW = draggedNode.width ?? CHILD_DEFAULT_W;
        const draggedH = draggedNode.height ?? CHILD_DEFAULT_H;
        const cx = draggedNode.position.x + draggedW / 2;
        const cy = draggedNode.position.y + draggedH / 2;
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
            }, ungroupConfirmMs);
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
    [
      rf,
      clearMergeTimer,
      clearUngroupTimer,
      mergeHoverMs,
      ungroupConfirmMs,
      depthById,
      subtreeHeightById,
    ],
  );
  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent, node: RFNode) => {
      const startsNewGesture = !draggingRef.current;
      draggingRef.current = true;
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
      setDragState({ dragId: node.id, mergeCandidatePending: null, mergeTarget: null, ungroupFrom: null });
    },
    [parentMap],
  );
  const onNodeDragStop = useCallback(
    (_evt: React.MouseEvent, draggedNode: RFNode) => {
      const dragId = draggedNode.id;
      const state = dragStateRef.current;
      const mergeTarget = state?.mergeTarget ?? null;
      const ungroupFrom = state?.ungroupFrom ?? null;
      setDragState(null);
      clearMergeTimer();
      clearUngroupTimer();
      draggingRef.current = false;
      const multiStopAction = multiDragSessionRef.current.stop(dragId);
      if (multiStopAction === 'ignore') return;
      if (multiStopAction === 'commit') {
        isMultiDragRef.current = false;
        const selected = rfNodes.filter((n) => n.selected && n.id !== GHOST_ID);
        const selectedIds = new Set(selected.map((n) => n.id));
        const translationById = new Map<string, { dx: number; dy: number }>();
        const selectedByParent = new Map<string, RFTaskNode[]>();
        for (const node of selected) {
          const key = node.parentId ?? '';
          const group = selectedByParent.get(key);
          if (group) group.push(node);
          else selectedByParent.set(key, [node]);
        }
        for (const group of selectedByParent.values()) {
          const parentId = group[0]?.parentId;
          const toRect = (node: RFTaskNode): CollisionRect => ({
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            w: node.width ?? (node.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
            h: node.height ?? (node.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
          });
          const occupied = rfNodes
            .filter(
              (node) =>
                node.id !== GHOST_ID &&
                !selectedIds.has(node.id) &&
                (node.parentId ?? '') === (parentId ?? ''),
            )
            .map(toRect);
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
    [rf, parentMap, setParent, ascendOneLevel, updateTasksBulk, normalizeGroupBounds, rfNodes, clearMergeTimer, clearUngroupTimer, resolveDropPushAway],
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
  const applyAutoLayout = useCallback(() => {
    const groupIds = [...parentMap.keys()].sort(
      (left, right) => (depthById.get(right) ?? 0) - (depthById.get(left) ?? 0),
    );
    const groupLayout = layoutNestedGroupChildren(rfNodes, groupIds, parentMap, (node) => ({
      width: typeof node.width === 'number' ? node.width : CHILD_DEFAULT_W,
      height: typeof node.height === 'number' ? node.height : CHILD_DEFAULT_H,
    }));
    const workingNodes = rfNodes.map((node) => ({
      ...node,
      position: groupLayout.positions.get(node.id) ?? node.position,
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
      prev.map((node) => ({ ...node, position: finalPositions.get(node.id) ?? node.position })),
    );
    const patches = workingNodes.map((node) => ({
      id: node.id,
      patch: {
        x: finalPositions.get(node.id)?.x ?? node.position.x,
        y: finalPositions.get(node.id)?.y ?? node.position.y,
      },
    }));
    updateTasksBulk(patches);
  }, [rfNodes, rfEdges, updateTasksBulk, parentMap, depthById]);
  const autoLayoutCheckedPagesRef = useRef(new Set<string>());
  useEffect(() => {
    if (!activePageId || !claimPageForAutoLayout(
      autoLayoutCheckedPagesRef.current,
      activePageId,
      nodes.map((node) => node.id),
      rfNodes.map((node) => node.id),
    )) return;
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
  const viewportRenderedNodes = useMemo(
    () => rfNodes.filter((node) => node.id !== GHOST_ID),
    [rfNodes],
  );
  const minZoom = viewportScope === 'mobile' ? MOBILE_MIN_ZOOM : DESKTOP_MIN_ZOOM;
  const {
    isMoving: isViewportMoving,
    isRestoring: isViewportRestoring,
    onMoveStart,
    onMoveEnd,
  } = usePageViewportLifecycle({
    activePageId,
    renderedPageId: rfNodesPageId,
    viewportScope,
    minZoom,
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
    <div ref={containerRef} className={`graph-surface relative h-full w-full${isViewportMoving ? ' graph-viewport-moving' : ''}${isViewportRestoring ? ' graph-viewport-restoring' : ''}`} style={{ touchAction: 'none', WebkitTouchCallout: 'none' }} onMouseMove={handleContainerMouseMove} onKeyDown={handleKeyDown} tabIndex={0}>
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
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background gap={24} size={1} color="hsl(var(--border))" />
        <Controls />
        {!isViewportMoving && !isViewportRestoring && (
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
    const size = sizeMap.get(node.id) ?? { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
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
