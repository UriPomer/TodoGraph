import { useMemo, useRef } from 'react';
import { recommend, readyTasks } from '@todograph/core';
import type { Task } from '@todograph/shared';
import { useTaskStore } from '@/stores/useTaskStore';

/**
 * 订阅 nodes/edges 变化，实时计算 ready 与 recommended。
 *
 * 关键性能优化：readyTasks 与 recommend 只关心 id/status/priority/edges——
 * 不关心 x/y。把它们从 nodes 中"投影"出来做一个稳定签名，避免拖动时
 * 每帧重新跑拓扑排序，这是大图下创建新节点卡死的根因之一。
 */
export function useDerived() {
  const nodes = useTaskStore((s) => s.nodes);
  const edges = useTaskStore((s) => s.edges);

  // 把与派生计算相关的字段做一个浅签名（拖动 x/y 不会改变它）
  const signature = useMemo(
    () => nodes.map((n) => `${n.id}|${n.status}|${n.priority ?? 2}`).join(','),
    [nodes],
  );
  const edgeSig = useMemo(
    () => edges.map((e) => `${e.from}>${e.to}`).join(','),
    [edges],
  );

  const cacheRef = useRef<{
    sig: string;
    edgeSig: string;
    ready: Task[];
    readySet: Set<string>;
    recommended: Task | null;
  } | null>(null);

  return useMemo(() => {
    const cache = cacheRef.current;
    if (cache && cache.sig === signature && cache.edgeSig === edgeSig) {
      return {
        graph: { nodes, edges },
        ready: cache.ready,
        readySet: cache.readySet,
        recommended: cache.recommended,
      };
    }
    const graph = { nodes, edges };
    const ready = readyTasks(graph);
    const readySet = new Set(ready.map((n) => n.id));
    const recommended = recommend(graph);
    cacheRef.current = { sig: signature, edgeSig, ready, readySet, recommended };
    return { graph, ready, readySet, recommended };
  }, [nodes, edges, signature, edgeSig]);
}
