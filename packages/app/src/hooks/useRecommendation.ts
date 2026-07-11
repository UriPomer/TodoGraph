import { useMemo, useRef } from 'react';
import { deriveReadyAndRecommended } from '@todograph/core';
import type { Task } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';

/**
 * 订阅 nodes/edges 变化，实时计算 ready 与 recommended。
 *
 * readyTasks 与 recommend 只关心 id/status/edges。store 用语义修订号标记
 * 这些字段的变化，坐标拖动不会递增修订号，因此可以复用上次派生结果。
 */
export function useDerived() {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);
  const recommendationRevision = useTaskStore((s) => s.recommendationRevision);

  const cacheRef = useRef<{
    revision: number;
    ready: Task[];
    readySet: Set<string>;
    recommended: Task | null;
  } | null>(null);

  return useMemo(() => {
    const cache = cacheRef.current;
    if (cache && cache.revision === recommendationRevision) {
      return {
        graph: { nodes, edges },
        ready: cache.ready,
        readySet: cache.readySet,
        recommended: cache.recommended,
      };
    }
    const graph = { nodes, edges };
    const { ready, readySet, recommended } = deriveReadyAndRecommended(graph);
    cacheRef.current = { revision: recommendationRevision, ready, readySet, recommended };
    return { graph, ready, readySet, recommended };
  }, [nodes, edges, recommendationRevision]);
}
