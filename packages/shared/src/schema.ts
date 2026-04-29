import { z } from 'zod';

export const TaskStatusSchema = z.enum(['todo', 'doing', 'done']);

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: TaskStatusSchema,
  priority: z.number().int().min(1).max(3).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
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
