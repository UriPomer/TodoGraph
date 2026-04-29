import { buildAdj } from './dag.js';
import type { Graph, Task } from './types.js';

/**
 * Ready Task：所有父节点状态为 done，且自身非 done。
 * 数学定义：Ready(T) = { t | ∀ p ∈ Parents(t), status(p) = done } ∩ { t | status(t) ≠ done }
 */
export function readyTasks(graph: Graph): Task[] {
  const { parents } = buildAdj(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const result: Task[] = [];
  for (const n of graph.nodes) {
    if (n.status === 'done') continue;
    const ps = parents.get(n.id);
    if (!ps) continue;
    let ok = true;
    for (const pid of ps) {
      if (byId.get(pid)?.status !== 'done') {
        ok = false;
        break;
      }
    }
    if (ok) result.push(n);
  }
  return result;
}
