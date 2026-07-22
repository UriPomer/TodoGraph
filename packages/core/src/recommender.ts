import { buildAdj } from './dag.js';
import type { Adjacency, Graph, Task } from './types.js';

/**
 * 推荐策略接口。输入整张图，返回一个已排序的推荐列表（最佳在前）。
 * 策略可替换：未来接入 AI、deadline 约束、用户习惯学习都只需实现此接口。
 */
export interface RecommendationStrategy {
  readonly name: string;
  rank(graph: Graph): Task[];
}

export interface DerivedReadyState {
  ready: Task[];
  readySet: Set<string>;
  recommended: Task | null;
}

export interface ScoredRecommendation {
  task: Task;
  downstreamCount: number;
}

/**
 * 单次反向拓扑遍历预计算所有节点的下游计数。
 * 处理顺序：逆拓扑序，每个节点的下游 = Σ(1 + 子节点下游) 并去重。
 * 替代原来每个就绪任务单独跑一次 DFS 的 O(R*(V+E)) 做法。
 */
function computeDownstreamCounts(
  graph: Graph,
  adj: Adjacency,
): Map<string, number> {
  const order = topoOrderFromAdj(graph, adj);
  if (!order) return new Map(); // 有环

  const indexById = new Map(order.map((id, index) => [id, index]));
  const wordCount = Math.ceil(order.length / 32);
  const reachable = new Map<string, Uint32Array>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const bits = new Uint32Array(wordCount);
    for (const childId of adj.children.get(id)!) {
      const childIndex = indexById.get(childId);
      if (childIndex === undefined) continue;
      bits[childIndex >>> 5]! |= 1 << (childIndex & 31);
      const childBits = reachable.get(childId);
      if (childBits) {
        for (let word = 0; word < wordCount; word++) bits[word]! |= childBits[word]!;
      }
    }
    reachable.set(id, bits);
  }

  const result = new Map<string, number>();
  for (const [id, bits] of reachable) {
    let count = 0;
    for (const word of bits) count += popCount32(word);
    result.set(id, count);
  }
  return result;
}

function topoOrderFromAdj(graph: Graph, adj: Adjacency): string[] | null {
  const indegree = new Map<string, number>();
  const queue: string[] = [];
  for (const node of graph.nodes) {
    const degree = adj.parents.get(node.id)?.size ?? 0;
    indegree.set(node.id, degree);
    if (degree === 0) queue.push(node.id);
  }
  const order: string[] = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    order.push(id);
    for (const childId of adj.children.get(id) ?? []) {
      const next = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, next);
      if (next === 0) queue.push(childId);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

function popCount32(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function collectReadyTasks(
  graph: Graph,
  adj: Adjacency,
  byId: Map<string, Task>,
): Task[] {
  const ready: Task[] = [];
  for (const node of graph.nodes) {
    if (node.status === 'done') continue;
    const parents = adj.parents.get(node.id);
    if (!parents) continue;
    let allDone = true;
    for (const parentId of parents) {
      if (byId.get(parentId)?.status !== 'done') {
        allDone = false;
        break;
      }
    }
    if (allDone) ready.push(node);
  }
  return ready;
}

function rankReadyTasks(
  ready: Task[],
  downCount: Map<string, number>,
): Task[] {
  const scored = ready.map((node) => ({
    node,
    doing: node.status === 'doing' ? 1 : 0,
    down: downCount.get(node.id) ?? 0,
  }));
  scored.sort((a, b) => b.doing - a.doing || b.down - a.down);
  return scored.map((item) => item.node);
}

function buildReadyContext(graph: Graph): {
  ready: Task[];
  downCount: Map<string, number>;
} {
  const adj = buildAdj(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ready = collectReadyTasks(graph, adj, byId);
  const downCount = computeDownstreamCounts(graph, adj);
  return { ready, downCount };
}

/**
 * 默认策略：
 *  1) 只考虑 Ready 任务（依赖已全部完成）
 *  2) status=doing 的优先（用户已在处理）
 *  3) 下游任务数多的优先（解锁更多路径）
 */
export const defaultStrategy: RecommendationStrategy = {
  name: 'default',
  rank(graph) {
    const { ready, downCount } = buildReadyContext(graph);
    if (ready.length === 0) return [];
    return rankReadyTasks(ready, downCount);
  },
};

export function deriveReadyAndRecommended(graph: Graph): DerivedReadyState {
  const { ready, downCount } = buildReadyContext(graph);
  const readySet = new Set(ready.map((node) => node.id));
  if (ready.length === 0) {
    return { ready, readySet, recommended: null };
  }
  const ranked = rankReadyTasks(ready, downCount);
  return {
    ready,
    readySet,
    recommended: ranked[0] ?? null,
  };
}

/** 便捷函数：用默认策略取头名推荐。 */
export function recommend(
  graph: Graph,
  strategy: RecommendationStrategy = defaultStrategy,
): Task | null {
  const list = strategy.rank(graph);
  return list[0] ?? null;
}

/** 便捷函数：用默认策略取完整排序。 */
export function rankRecommendations(
  graph: Graph,
  strategy: RecommendationStrategy = defaultStrategy,
): Task[] {
  return strategy.rank(graph);
}

/** Exposes the default strategy's comparable score for cross-page consumers. */
export function scoreRecommendations(graph: Graph): ScoredRecommendation[] {
  const { ready, downCount } = buildReadyContext(graph);
  return rankReadyTasks(ready, downCount).map((task) => ({
    task,
    downstreamCount: downCount.get(task.id) ?? 0,
  }));
}
