import type { Graph } from '@todograph/shared';

/**
 * 图数据的持久化抽象。
 * 未来切换 SQLite / Postgres / 云端，只需实现这个接口。
 */
export interface GraphRepository {
  load(): Promise<Graph>;
  save(graph: Graph): Promise<void>;
}
