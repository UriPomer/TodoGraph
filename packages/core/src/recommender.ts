import { buildAdj, downstreamSet } from './dag.js';
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

function rankReadyTasks(ready: Task[], adj: Adjacency): Task[] {
  const scored = ready.map((node) => ({
    node,
    doing: node.status === 'doing' ? 1 : 0,
    down: downstreamSet(adj, node.id).size,
  }));
  scored.sort((a, b) => b.doing - a.doing || b.down - a.down);
  return scored.map((item) => item.node);
}

function buildReadyContext(graph: Graph): { adj: Adjacency; ready: Task[] } {
  const adj = buildAdj(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ready = collectReadyTasks(graph, adj, byId);
  return { adj, ready };
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
    const { adj, ready } = buildReadyContext(graph);
    if (ready.length === 0) return [];
    return rankReadyTasks(ready, adj);
  },
};

export function deriveReadyAndRecommended(graph: Graph): DerivedReadyState {
  const { adj, ready } = buildReadyContext(graph);
  const readySet = new Set(ready.map((node) => node.id));
  if (ready.length === 0) {
    return { ready, readySet, recommended: null };
  }
  const ranked = rankReadyTasks(ready, adj);
  return {
    ready,
    readySet,
    recommended: ranked[0] ?? null,
  };
}

/** 便捷函数：用默认策略取头名推荐。 */
export function recommend(graph: Graph, strategy: RecommendationStrategy = defaultStrategy): Task | null {
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
