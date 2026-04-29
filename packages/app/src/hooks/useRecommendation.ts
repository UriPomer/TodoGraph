import { useMemo } from 'react';
import { recommend, readyTasks } from '@todograph/core';
import { useTaskStore } from '@/stores/useTaskStore';

/**
 * 订阅 nodes/edges 变化，实时计算 ready 与 recommended。
 * 以 hook 包装便于组件单独使用，避免每个组件都手写派生逻辑。
 */
export function useDerived() {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);

  return useMemo(() => {
    const graph = { nodes, edges };
    const ready = readyTasks(graph);
    const readySet = new Set(ready.map((n) => n.id));
    const recommended = recommend(graph);
    return { graph, ready, readySet, recommended };
  }, [nodes, edges]);
}
