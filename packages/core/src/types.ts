/** 任务状态 */
export type TaskStatus = 'todo' | 'doing' | 'done';

/**
 * 任务节点。
 * - id: 全局唯一
 * - x/y: 可选，图视图的持久化坐标
 * - priority: 1(低) / 2(中) / 3(高)
 */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: number;
  x?: number;
  y?: number;
  /** 可扩展字段：描述、deadline、tags 等，不破坏核心算法 */
  metadata?: Record<string, unknown>;
}

/** 有向边：from 完成后 to 才可执行 */
export interface Edge {
  from: string;
  to: string;
}

/** 图的完整结构 */
export interface Graph {
  nodes: Task[];
  edges: Edge[];
}

/** 邻接表结构 */
export interface Adjacency {
  children: Map<string, Set<string>>;
  parents: Map<string, Set<string>>;
}
