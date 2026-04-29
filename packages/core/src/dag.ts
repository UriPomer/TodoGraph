import type { Adjacency, Graph } from './types.js';

/** 构建邻接表（children/parents 两向）。未知节点边会被忽略；自环会被忽略。 */
export function buildAdj(graph: Graph): Adjacency {
  const children = new Map<string, Set<string>>();
  const parents = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    children.set(n.id, new Set());
    parents.set(n.id, new Set());
  }
  for (const e of graph.edges) {
    if (!children.has(e.from) || !children.has(e.to)) continue;
    if (e.from === e.to) continue;
    children.get(e.from)!.add(e.to);
    parents.get(e.to)!.add(e.from);
  }
  return { children, parents };
}

/**
 * 检测新增边 from → to 是否会形成环。
 * 判定条件：当前图中已存在 to → … → from 的路径。
 */
export function wouldCreateCycle(graph: Graph, from: string, to: string): boolean {
  if (from === to) return true;
  const { children } = buildAdj(graph);
  const kidsOfTo = children.get(to);
  if (!kidsOfTo) return false;
  const stack: string[] = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const kids = children.get(cur);
    if (kids) for (const k of kids) stack.push(k);
  }
  return false;
}

/**
 * Kahn 拓扑排序。存在环时返回 null。
 */
export function topoSort(graph: Graph): string[] | null {
  const { children, parents } = buildAdj(graph);
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) indeg.set(n.id, parents.get(n.id)!.size);
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/** 图是否是 DAG（无环）。 */
export function isDAG(graph: Graph): boolean {
  return topoSort(graph) !== null;
}

/** 下游（可达后继）节点集合，不包含自身。 */
export function downstreamSet(adj: Adjacency, id: string): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  const kids = adj.children.get(id);
  if (kids) for (const k of kids) stack.push(k);
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const kk = adj.children.get(cur);
    if (kk) for (const k of kk) stack.push(k);
  }
  return seen;
}
