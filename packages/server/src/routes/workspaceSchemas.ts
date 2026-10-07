import { MetaSchema, PageDataSchema, MAX_PAGE_TITLE_LENGTH } from '@todograph/shared';
import { z } from 'zod';

export const MoveNodesBodySchema = z.object({
  targetPageId: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).min(1),
  expectedSourceVersion: z.number().int().min(0).optional(),
  expectedTargetVersion: z.number().int().min(0).optional(),
});

export const TaskCommandBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delete_tasks'),
    taskIds: z.array(z.string().min(1)).min(1).max(100),
  }),
  z.object({
    type: z.literal('create_task'),
    title: z.string().min(1).max(200),
    status: z.enum(['todo', 'doing', 'done']).optional(),
    description: z.string().max(4000).optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('create_tasks'),
    tasks: z.array(z.object({
      title: z.string().min(1).max(200),
      status: z.enum(['todo', 'doing', 'done']).optional(),
      description: z.string().max(4000).optional(),
    })).min(1).max(50),
    edges: z.array(z.object({ from: z.number().int(), to: z.number().int() })).optional(),
  }),
  z.object({
    type: z.literal('update_task'),
    taskId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    status: z.enum(['todo', 'doing', 'done']).optional(),
    description: z.string().max(4000).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    type: z.literal('manage_dependencies'),
    add: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).optional(),
    remove: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).optional(),
  }),
]);

export const CreatePageBodySchema = z.object({
  title: z.string().max(MAX_PAGE_TITLE_LENGTH),
  expectedRevision: z.number().int().min(0).optional(),
});

export const PatchPageBodySchema = z.object({
  title: z.string().max(MAX_PAGE_TITLE_LENGTH).optional(),
  activate: z.boolean().optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

export const ReorderBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  expectedRevision: z.number().int().min(0).optional(),
});

export const DeletePageBodySchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
});

export const RestoreBackupBodySchema = z.object({
  backupName: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/, 'invalid backup name')
    .optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

export const RestoreTrashBodySchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
});

export const MergePageBodySchema = z.object({
  targetPageId: z.string().min(1),
});

export const WorkspaceImportSchema = z.object({
  exportedAt: z.string(),
  meta: MetaSchema,
  pages: z.record(PageDataSchema),
});
