import type { Edge, Graph, Task, TaskStatus } from '@todograph/shared';

export type { Edge, Graph, Task, TaskStatus };

/** 邻接表结构 */
export interface Adjacency {
  children: Map<string, Set<string>>;
  parents: Map<string, Set<string>>;
}
