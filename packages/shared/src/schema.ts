import { z } from 'zod';

export const TaskStatusSchema = z.enum(['todo', 'doing', 'done']);

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: TaskStatusSchema,
  priority: z.number().int().min(1).max(3).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  /**
   * 父任务 id（分组/compound node 用）。
   * - 当一个任务有 parentId 时，它在图中被渲染到父节点的容器内，
   *   坐标 (x, y) 视为相对父节点左上角的偏移。
   * - 父节点本身仍是一个正常的 Task，可以参与依赖边连线。
   * - 为防止自引用或循环层级，store 层会校验。
   */
  parentId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const GraphSchema = z.object({
  nodes: z.array(TaskSchema),
  edges: z.array(EdgeSchema),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Graph = z.infer<typeof GraphSchema>;
