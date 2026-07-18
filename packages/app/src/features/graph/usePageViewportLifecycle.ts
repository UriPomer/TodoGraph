import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, OnMove, ReactFlowInstance } from '@xyflow/react';
import {
  arePageViewportNodesReady,
  type PageViewportCache,
  PageViewportController,
  type ViewportDimensions,
  type ViewportScope,
} from './pageViewportCache';

interface PageViewportLifecycleOptions {
  activePageId: string | null;
  renderedPageId: string | null;
  viewportScope: ViewportScope;
  fitMinZoom: number;
  nodeIds: string[];
  renderedNodes: Array<Pick<Node, 'id' | 'hidden' | 'width' | 'height' | 'measured'>>;
  cache: PageViewportCache;
  rf: ReactFlowInstance;
  getViewportDimensions: () => ViewportDimensions;
  updateViewportCenter: () => void;
}

export const PAGE_VIEWPORT_MAX_ZOOM = 1;

export interface PageViewportLifecycle {
  isMoving: boolean;
  isRestoring: boolean;
  onMoveStart: OnMove;
  onMoveEnd: OnMove;
}

export function usePageViewportLifecycle({
  activePageId,
  renderedPageId,
  viewportScope,
  fitMinZoom,
  nodeIds,
  renderedNodes,
  cache,
  rf,
  getViewportDimensions,
  updateViewportCenter,
}: PageViewportLifecycleOptions): PageViewportLifecycle {
  const controllerRef = useRef<{
    cache: PageViewportCache;
    viewportScope: ViewportScope;
    controller: PageViewportController;
  } | null>(null);
  if (
    !controllerRef.current ||
    controllerRef.current.cache !== cache ||
    controllerRef.current.viewportScope !== viewportScope
  ) {
    controllerRef.current = {
      cache,
      viewportScope,
      controller: new PageViewportController(activePageId, cache, viewportScope, getViewportDimensions),
    };
  }
  const controller = controllerRef.current.controller;
  const [transitionRevision, setTransitionRevision] = useState(0);
  const [isMoving, setIsMoving] = useState(false);
  const [settledRestore, setSettledRestore] = useState<{
    controller: PageViewportController;
    pageId: string;
  } | null>(null);
  const isRestoring =
    activePageId !== null &&
    (settledRestore?.controller !== controller || settledRestore.pageId !== activePageId);
  const activePageIdRef = useRef(activePageId);
  activePageIdRef.current = activePageId;
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    setIsMoving(false);
    controller.switchTo(activePageId, rf.getViewport());
    setTransitionRevision((revision) => revision + 1);
  }, [activePageId, controller, rf]);

  useEffect(() => {
    if (!activePageId || !controller.shouldRestore(activePageId)) return;
    if (renderedPageId !== activePageId) return;
    if (!arePageViewportNodesReady(nodeIds, renderedNodes)) return;

    const frame = requestAnimationFrame(() => {
      const token = controller.beginRestore(activePageId);
      if (!token) return;
      const complete = (success: boolean) => {
        if (!mountedRef.current || controllerRef.current?.controller !== controller) return;
        const result = controller.completeRestore(token, success, rf.getViewport());
        if (result === 'retry' || result === 'stale') {
          setTransitionRevision((revision) => revision + 1);
        } else {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (
                !mountedRef.current ||
                controllerRef.current?.controller !== controller ||
                activePageIdRef.current !== token.pageId
              ) {
                return;
              }
              setSettledRestore({ controller, pageId: token.pageId });
              updateViewportCenter();
            });
          });
        }
      };
      try {
        const restored = token.cachedViewport
          ? rf.setViewport({
              ...token.cachedViewport,
              zoom: Math.min(token.cachedViewport.zoom, PAGE_VIEWPORT_MAX_ZOOM),
            })
          : nodeIds.length > 0
            ? rf.fitView({ padding: 0.3, minZoom: fitMinZoom, maxZoom: PAGE_VIEWPORT_MAX_ZOOM })
            : rf.setViewport({ x: 0, y: 0, zoom: 1 });
        void restored.then(complete, () => complete(false));
      } catch {
        complete(false);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activePageId, controller, fitMinZoom, nodeIds, renderedNodes, renderedPageId, rf, transitionRevision, updateViewportCenter]);

  const onMoveStart = useCallback<OnMove>((event) => {
    const target = event?.target;
    if (
      typeof Element !== 'undefined' &&
      target instanceof Element &&
      target.closest('.react-flow__minimap')
    ) {
      return;
    }
    setIsMoving(true);
  }, []);
  const onMoveEnd = useCallback<OnMove>(
    (_event, viewport) => {
      controller.recordMove(viewport);
      updateViewportCenter();
      setIsMoving(false);
    },
    [controller, updateViewportCenter],
  );

  return { isMoving, isRestoring, onMoveStart, onMoveEnd };
}
