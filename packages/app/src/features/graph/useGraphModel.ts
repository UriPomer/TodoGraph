import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeChange,
} from '@xyflow/react';
import {
  MAX_HIERARCHY_DEPTH,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  CHILD_DEFAULT_W,
  CHILD_DEFAULT_H,
  GROUP_MIN_W,
  GROUP_MIN_H,
  computeNodeGeometryMap,
  resolveClusterTranslationAvoidingOccupied,
  type CollisionRect,
} from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import { buildHierarchyMetrics } from '@/lib/taskHierarchy';
import { useDerived } from '@/hooks/useRecommendation';
import { buildGraphNodeProjection, type ProjectedGraphNode } from './graphNodeProjection';
import { resolvePinnedDropPushAway } from './dropCollision';

const UNGROUP_ESCAPE_PX = 12;
function collisionRect(node: RFNode, fallback?: RFNode): CollisionRect {
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    w:
      node.measured?.width ??
      node.width ??
      fallback?.measured?.width ??
      fallback?.width ??
      (node.type === 'group' ? GROUP_MIN_W : CHILD_DEFAULT_W),
    h:
      node.measured?.height ??
      node.height ??
      fallback?.measured?.height ??
      fallback?.height ??
      (node.type === 'group' ? GROUP_MIN_H : CHILD_DEFAULT_H),
  };
}

export function useGraphModel() {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);
  const activePageId = useTaskStore((s) => s.activePageId);
  const updateTasksBulk = useTaskStore((s) => s.updateTasksBulk);
  const syncMeasuredSizes = useTaskStore((s) => s.syncMeasuredSizes);
  const deleteTasks = useTaskStore((s) => s.deleteTasks);
  const setParent = useTaskStore((s) => s.setParent);
  const ascendOneLevel = useTaskStore((s) => s.ascendOneLevel);
  const { graph, readySet, recommended } = useDerived();
  const rf = useReactFlow();
  const [projection, setProjection] = useState<{
    nodes: ProjectedGraphNode[];
    pageId: string | null;
  }>({ nodes: [], pageId: null });
  const rfNodes = projection.nodes;
  const [isNodeDragging, setIsNodeDragging] = useState(false);
  const dragPageRef = useRef<string | null>(null);
  const dragDescendantIdsRef = useRef(new Set<string>());
  const hierarchyMetrics = useMemo(() => buildHierarchyMetrics(nodes), [nodes]);
  const parentMap = hierarchyMetrics.childIdsByParentId;
  const depthById = hierarchyMetrics.depthById;
  const subtreeHeightById = hierarchyMetrics.subtreeHeightById;
  const nodeGeometryById = useMemo(() => computeNodeGeometryMap(nodes), [nodes]);
  const dataCacheRef = useRef<ReturnType<typeof buildGraphNodeProjection>['dataById']>(new Map());
  useEffect(() => {
    if (isNodeDragging && dragPageRef.current === activePageId) return;
    const next = buildGraphNodeProjection({
      nodes,
      hierarchy: hierarchyMetrics,
      geometryById: nodeGeometryById,
      readySet,
      recommendedId: recommended?.id,
      previousData: dataCacheRef.current,
    });
    dataCacheRef.current = next.dataById;
    setProjection({ nodes: next.nodes, pageId: activePageId });
  }, [
    activePageId,
    nodes,
    readySet,
    recommended,
    hierarchyMetrics,
    nodeGeometryById,
    isNodeDragging,
  ]);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (!parentMap.size) return;
    const frame = requestAnimationFrame(() => updateNodeInternals([...parentMap.keys()]));
    return () => cancelAnimationFrame(frame);
  }, [parentMap, updateNodeInternals]);
  const rfEdges: RFEdge[] = useMemo(
    () =>
      edges.map((edge) => {
        const isReady = hierarchyMetrics.byId.get(edge.from)?.status === 'done';
        return {
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          animated: isReady,
          className: isReady ? 'ready' : undefined,
        };
      }),
    [edges, hierarchyMetrics],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<ProjectedGraphNode>[]) => {
      setProjection((previous) => ({
        ...previous,
        nodes: applyNodeChanges(changes, previous.nodes),
      }));
      const measurements: Array<{ id: string; width: number; height: number }> = [];
      const removed: string[] = [];
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions && !parentMap.has(change.id)) {
          measurements.push({
            id: change.id,
            width: change.dimensions.width,
            height: change.dimensions.height,
          });
        }
        if (change.type === 'remove') removed.push(change.id);
      }
      if (removed.length) deleteTasks(removed);
      syncMeasuredSizes(measurements);
    },
    [deleteTasks, parentMap, syncMeasuredSizes],
  );
  const onNodeDragStart = useCallback(
    (_evt: React.MouseEvent, node: RFNode) => {
      dragPageRef.current = activePageId;
      setIsNodeDragging(true);
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
    [activePageId, parentMap],
  );
  const onNodeDragStop = useCallback(
    (_evt: React.MouseEvent, draggedNode: RFNode, draggedNodes: RFNode[]) => {
      const dragId = draggedNode.id;
      setIsNodeDragging(false);
      if (dragPageRef.current !== useTaskStore.getState().activePageId) return;
      if (draggedNodes.length > 1) {
        const selected = draggedNodes;
        const selectedIds = new Set(selected.map((n) => n.id));
        const translationById = new Map<string, { dx: number; dy: number }>();
        const selectedByParent = new Map<string, RFNode[]>();
        const unselectedByParent = new Map<string, RFNode[]>();
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
          const occupied = (unselectedByParent.get(parentId ?? '') ?? []).map((node) =>
            collisionRect(node),
          );
          const translation = resolveClusterTranslationAvoidingOccupied(
            group.map((node) => collisionRect(node)),
            occupied,
          );
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
        if (patches.length > 0) updateTasksBulk(patches);
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

      const movedSiblings = resolvePinnedDropPushAway({
        pinned: collisionRect(
          draggedNode,
          rfNodes.find((node) => node.id === dragId),
        ),
        occupied: rfNodes
          .filter((node) => node.id !== dragId && node.parentId === draggedNode.parentId)
          .map((node) => collisionRect(node)),
      });

      updateTasksBulk([
        { id: dragId, patch: { x: draggedNode.position.x, y: draggedNode.position.y } },
        ...movedSiblings.map((item) => ({
          id: item.id,
          patch: { x: item.x, y: item.y },
        })),
      ]);
    },
    [
      rf,
      parentMap,
      setParent,
      ascendOneLevel,
      updateTasksBulk,
      rfNodes,
      depthById,
      subtreeHeightById,
    ],
  );
  return {
    nodes,
    graph,
    activePageId,
    hierarchyMetrics,
    nodeGeometryById,
    rfNodes,
    rfEdges,
    renderedPageId: projection.pageId,
    isNodeDragging,
    handlers: { onNodesChange, onNodeDragStart, onNodeDragStop },
  };
}
