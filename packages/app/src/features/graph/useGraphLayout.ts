import { startTransition, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CHILD_DEFAULT_W, CHILD_DEFAULT_H } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { dagreLayout, layoutNestedGroupChildren } from './useAutoLayout';
import { claimPageForAutoLayout, fitPageAfterAutoLayout } from './pageAutoLayout';
import { usePageViewportLifecycle } from './usePageViewportLifecycle';
import type { useGraphModel } from './useGraphModel';

const DESKTOP_MIN_ZOOM = 0.5;
const MOBILE_MIN_ZOOM = 0.1;
const MOBILE_FIT_MIN_ZOOM = 0.35;
type GraphLayoutOptions = Pick<
  ReturnType<typeof useGraphModel>,
  | 'nodes'
  | 'rfNodes'
  | 'rfEdges'
  | 'activePageId'
  | 'hierarchyMetrics'
  | 'nodeGeometryById'
  | 'renderedPageId'
> & { containerRef: RefObject<HTMLDivElement>; viewportScope: 'desktop' | 'mobile' };

export function useGraphLayout({
  nodes,
  rfNodes,
  rfEdges,
  activePageId,
  hierarchyMetrics,
  nodeGeometryById,
  renderedPageId,
  containerRef,
  viewportScope,
}: GraphLayoutOptions) {
  const rf = useReactFlow();
  const updateTasksBulk = useTaskStore((s) => s.updateTasksBulk);
  const setViewportCenter = useTaskStore((s) => s.setViewportCenter);
  const pageViewportCache = useWorkspaceStore((s) => s.pageViewportCache);
  const parentMap = hierarchyMetrics.childIdsByParentId;
  const depthById = hierarchyMetrics.depthById;
  const getViewportDimensions = useCallback(
    () => ({
      width: containerRef.current?.clientWidth ?? 0,
      height: containerRef.current?.clientHeight ?? 0,
    }),
    [containerRef],
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
    const { nodes: laid } = dagreLayout(
      topLevel,
      topLevelEdges,
      (node) =>
        groupLayout.sizes.get(node.id) ?? { width: CHILD_DEFAULT_W, height: CHILD_DEFAULT_H },
    );
    const finalPositions = new Map(workingNodes.map((node) => [node.id, node.position]));
    for (const node of laid) finalPositions.set(node.id, node.position);
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
  useEffect(
    () => () => {
      if (layoutFitRafRef.current !== null) cancelAnimationFrame(layoutFitRafRef.current);
    },
    [],
  );
  const autoLayoutCheckedPagesRef = useRef(new Set<string>());
  useEffect(() => {
    const nodeIds = nodes.map((node) => node.id);
    if (
      !activePageId ||
      !claimPageForAutoLayout(autoLayoutCheckedPagesRef.current, activePageId, nodeIds, rfNodes)
    )
      return;
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
  const minZoom = viewportScope === 'mobile' ? MOBILE_MIN_ZOOM : DESKTOP_MIN_ZOOM;
  const fitMinZoom = viewportScope === 'mobile' ? MOBILE_FIT_MIN_ZOOM : DESKTOP_MIN_ZOOM;
  const {
    isMoving: isViewportMoving,
    isRestoring: isViewportRestoring,
    onMoveStart,
    onMoveEnd,
  } = usePageViewportLifecycle({
    activePageId,
    renderedPageId,
    viewportScope,
    fitMinZoom,
    nodeIds: viewportNodeIds,
    renderedNodes: rfNodes,
    cache: pageViewportCache,
    rf,
    getViewportDimensions,
    updateViewportCenter,
  });
  const fitView = useCallback(() => rf.fitView({ padding: 0.2 }), [rf]);
  return {
    applyAutoLayout,
    fitView,
    minZoom,
    isViewportMoving,
    isViewportRestoring,
    onMoveStart,
    onMoveEnd,
  };
}
