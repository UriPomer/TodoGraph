import { buildAdj, downstreamSet } from './dag.js';
import { readyTasks } from './ready.js';
import type { Graph, Task } from './types.js';

/**
 * 推荐策略接口。输入整张图，返回一个已排序的推荐列表（最佳在前）。
 * 策略可替换：未来接入 AI、deadline 约束、用户习惯学习都只需实现此接口。
 */
export interface RecommendationStrategy {
  readonly name: string;
  rank(graph: Graph): Task[];
}

/**
 * 默认策略：
 *  1) 只考虑 Ready 任务（依赖已全部完成）
 *  2) status=doing 的优先（用户已在处理）
 *  3) priority 高的优先（数值大=更高优先级）
 *  4) 下游任务数多的优先（解锁更多路径）
 */
export const defaultStrategy: RecommendationStrategy = {
  name: 'default',
  rank(graph) {
    const ready = readyTasks(graph);
    if (ready.length === 0) return [];
    const adj = buildAdj(graph);
    const scored = ready.map((n) => ({
      node: n,
      doing: n.status === 'doing' ? 1 : 0,
      pri: n.priority ?? 0,
      down: downstreamSet(adj, n.id).size,
    }));
    scored.sort((a, b) => b.doing - a.doing || b.pri - a.pri || b.down - a.down);
    return scored.map((s) => s.node);
  },
};

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
