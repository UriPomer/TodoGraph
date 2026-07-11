import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node, OnMove, ReactFlowInstance, Viewport } from '@xyflow/react';
import {
  arePageViewportNodesReady,
  PageViewportController,
} from './pageViewportCache';

interface PageViewportLifecycleOptions {
  activePageId: string | null;
  nodeIds: string[];
  renderedNodes: Array<Pick<Node, 'id' | 'width' | 'height' | 'measured'>>;
  cache: Map<string, Viewport>;
  rf: ReactFlowInstance;
  updateViewportCenter: () => void;
}

export function usePageViewportLifecycle({
  activePageId,
  nodeIds,
  renderedNodes,
  cache,
  rf,
  updateViewportCenter,
}: PageViewportLifecycleOptions): OnMove {
  const controllerRef = useRef<{
    cache: Map<string, Viewport>;
    controller: PageViewportController;
  } | null>(null);
  if (!controllerRef.current || controllerRef.current.cache !== cache) {
    controllerRef.current = {
      cache,
      controller: new PageViewportController(activePageId, cache),
    };
  }
  const controller = controllerRef.current.controller;
  const [transitionRevision, setTransitionRevision] = useState(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    controller.switchTo(activePageId, rf.getViewport());
    setTransitionRevision((revision) => revision + 1);
  }, [activePageId, controller, rf]);

  useEffect(() => {
    if (!activePageId || !controller.shouldRestore(activePageId)) return;
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
          updateViewportCenter();
        }
      };
      try {
        const restored = token.cachedViewport
          ? rf.setViewport(token.cachedViewport)
          : nodeIds.length > 0
            ? rf.fitView({ padding: 0.2 })
            : rf.setViewport({ x: 0, y: 0, zoom: 1 });
        void restored.then(complete, () => complete(false));
      } catch {
        complete(false);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activePageId, controller, nodeIds, renderedNodes, rf, transitionRevision, updateViewportCenter]);

  return useCallback<OnMove>(
    (_event, viewport) => {
      controller.recordMove(viewport);
      updateViewportCenter();
    },
    [controller, updateViewportCenter],
  );
}
