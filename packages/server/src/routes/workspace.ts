import {
  MetaSchema,
  MAX_PAGE_TITLE_LENGTH,
  PageDataSchema,
  SYSTEM_HIERARCHY_PAGE_ID,
  validateDependencyEdges,
  validateTaskHierarchy,
  type AllTasksItem,
  type AllTasksResponse,
  type Meta,
} from '@todograph/shared';
import { isDAG, readyTasks } from '@todograph/core';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  MetaVersionConflictError,
  NodeOverlapError,
  TaskTitleTooLongError,
  type WorkspaceRepository,
  VersionConflictError,
} from '../repositories/Repository.js';
import { generateWorkspaceMarkdown } from '../markdown.js';
import { getAuthenticatedUserId, hasAuthenticatedScope } from '../auth.js';
import { executeTaskCommand } from '../application/taskCommands.js';
import { moveNodesBetweenPages } from '../application/workspaceMoves.js';

interface Opts {
  getRepo: (userId: string) => WorkspaceRepository;
}

const MoveNodesBodySchema = z.object({
  targetPageId: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).min(1),
  expectedSourceVersion: z.number().int().min(0).optional(),
  expectedTargetVersion: z.number().int().min(0).optional(),
});

const TaskCommandBodySchema = z.discriminatedUnion('type', [
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

const CreatePageBodySchema = z.object({
  title: z.string().max(MAX_PAGE_TITLE_LENGTH),
  expectedRevision: z.number().int().min(0).optional(),
});

const PatchPageBodySchema = z.object({
  title: z.string().max(MAX_PAGE_TITLE_LENGTH).optional(),
  activate: z.boolean().optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

const ReorderBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  expectedRevision: z.number().int().min(0).optional(),
});

const DeletePageBodySchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
});

const RestoreBackupBodySchema = z.object({
  backupName: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/, 'invalid backup name')
    .optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

const RestoreTrashBodySchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
});

const MergePageBodySchema = z.object({
  targetPageId: z.string().min(1),
});

const WorkspaceImportSchema = z.object({
  exportedAt: z.string(),
  meta: MetaSchema,
  pages: z.record(PageDataSchema),
});

/**
 * /api/all-tasks 的内存缓存。
 *
 * 命中条件：缓存的 meta.activePageId + pages 列表完全一致，
 * 且所有页面文件的 mtime 不晚于缓存时记录的值 —— 这样
 * AI/用户直接改磁盘上的 JSON 文件也能在下次请求时被发现。
 */
interface AllTasksCache {
  key: string; // meta 摘要：activePageId + pages.id.order
  mtimes: Map<string, number>;
  response: AllTasksResponse;
}

const allCacheByUser = new Map<string, AllTasksCache | null>();

export const workspaceRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const { getRepo } = opts;
  const getCache = (userId: string) => allCacheByUser.get(userId) ?? null;
  const setCache = (userId: string, cache: AllTasksCache | null) => {
    if (cache === null) allCacheByUser.delete(userId);
    else allCacheByUser.set(userId, cache);
  };
  const invalidateAll = () => {
    allCacheByUser.clear();
  };

  app.get('/api/meta', async (req) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    return repo.loadMeta();
  });

  app.get<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    try {
      return await repo.loadPage(req.params.id);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        reply.status(404);
        return { ok: false, error: 'page not found' };
      }
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const body = req.body as Record<string, unknown> | null;
    const expectedVersion = typeof body?.expectedVersion === 'number' ? body.expectedVersion : undefined;
    const parsed = PageDataSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    const dependencies = validateDependencyEdges(parsed.data.nodes, parsed.data.edges);
    if (!dependencies.valid) {
      reply.status(400);
      return { ok: false, error: 'invalid dependency', ...dependencies };
    }
    if (!isDAG(parsed.data)) {
      reply.status(400);
      return { ok: false, error: 'graph contains a cycle' };
    }
    const hierarchy = validateTaskHierarchy(parsed.data.nodes);
    if (!hierarchy.valid) {
      reply.status(400);
      return {
        ok: false,
        error: 'invalid task hierarchy',
        reason: hierarchy.reason,
        taskId: hierarchy.taskId,
      };
    }
    try {
      const newVersion = await repo.savePage(req.params.id, parsed.data, expectedVersion);
      invalidateAll();
      return { ok: true, version: newVersion };
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverVersion: err.serverVersion };
      }
      if (err instanceof TaskTitleTooLongError) {
        reply.status(400);
        return {
          ok: false,
          error: 'task title too long',
          taskId: err.taskId,
          maxLength: err.maxLength,
        };
      }
      if (err instanceof NodeOverlapError) {
        reply.status(422);
        return {
          ok: false,
          code: 'node-overlap',
          error: err.message,
          conflicts: err.conflicts,
        };
      }
      throw err;
    }
  });

  app.post('/api/pages', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = CreatePageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      const result = await repo.createPage(parsed.data.title, parsed.data.expectedRevision);
      invalidateAll();
      return result;
    } catch (err) {
      if (err instanceof MetaVersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverRevision: err.serverRevision };
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = DeletePageBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      const nextMeta = await repo.deletePage(req.params.id, parsed.data.expectedRevision);
      invalidateAll();
      return { ok: true, meta: nextMeta };
    } catch (err) {
      if (err instanceof MetaVersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverRevision: err.serverRevision };
      }
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.patch<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = PatchPageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      let nextMeta: Meta | null = null;
      if (parsed.data.title !== undefined) {
        nextMeta = await repo.renamePage(req.params.id, parsed.data.title, parsed.data.expectedRevision);
        invalidateAll();
      }
      if (parsed.data.activate) {
        nextMeta = await repo.setActivePage(
          req.params.id,
          nextMeta?.revision ?? parsed.data.expectedRevision,
        );
      }
      return { ok: true, meta: nextMeta };
    } catch (err) {
      if (err instanceof MetaVersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverRevision: err.serverRevision };
      }
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post('/api/pages/reorder', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = ReorderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      await repo.reorderPages(parsed.data.ids, parsed.data.expectedRevision);
      invalidateAll();
      const nextMeta = await repo.loadMeta();
      return { ok: true, meta: nextMeta };
    } catch (err) {
      if (err instanceof MetaVersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverRevision: err.serverRevision };
      }
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>('/api/pages/:id/backup', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    try {
      await repo.createBackup(req.params.id);
      return { ok: true };
    } catch (err) {
      reply.status(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>('/api/pages/:id/commands', async (req, reply) => {
    const parsed = TaskCommandBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    if (parsed.data.type === 'delete_tasks' && !hasAuthenticatedScope(req, 'destructive')) {
      reply.status(403);
      return { ok: false, error: '此 API key 没有 destructive 权限' };
    }
    const repo = getRepo(getAuthenticatedUserId(req));
    try {
      const result = await executeTaskCommand(repo, req.params.id, parsed.data);
      invalidateAll();
      return result;
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverVersion: err.serverVersion };
      }
      if (err instanceof TaskTitleTooLongError) {
        reply.status(400);
        return { ok: false, error: 'task title too long', taskId: err.taskId, maxLength: err.maxLength };
      }
      if (err instanceof NodeOverlapError) {
        reply.status(422);
        return { ok: false, code: 'node-overlap', error: err.message, conflicts: err.conflicts };
      }
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>('/api/pages/:id/backups', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    try {
      return { backups: await repo.listBackups(req.params.id) };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>('/api/pages/:id/restore', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = RestoreBackupBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      const data = parsed.data.backupName
        ? await repo.restoreBackup(req.params.id, parsed.data.backupName, parsed.data.expectedVersion)
        : await repo.restoreLatestBackup(req.params.id, parsed.data.expectedVersion);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, serverVersion: err.serverVersion };
      }
      const e = err as NodeJS.ErrnoException;
      reply.status(e.code === 'ENOENT' ? 404 : 400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get('/api/trash/pages', async (req) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    return { pages: await repo.listTrashedPages() };
  });

  app.post<{ Params: { name: string } }>('/api/trash/pages/:name/restore', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = RestoreTrashBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      return { ok: true, ...(await repo.restoreTrashedPage(req.params.name, parsed.data.expectedRevision)) };
    } catch (error) {
      if (error instanceof MetaVersionConflictError) {
        reply.status(409);
        return { ok: false, error: error.message, serverRevision: error.serverRevision };
      }
      const code = (error as NodeJS.ErrnoException).code;
      reply.status(code === 'ENOENT' ? 404 : 400);
      return { ok: false, error: (error as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>('/api/pages/:id/move-nodes', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = MoveNodesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    const sourceId = req.params.id;
    const { targetPageId, nodeIds } = parsed.data;
    if (sourceId === targetPageId) {
      reply.status(400);
      return { ok: false, error: 'source and target are the same page' };
    }
    try {
      const resp = await moveNodesBetweenPages(
        repo,
        sourceId,
        targetPageId,
        nodeIds,
        parsed.data.expectedSourceVersion,
        parsed.data.expectedTargetVersion,
      );
      invalidateAll();
      return resp;
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { ok: false, error: err.message, pageId: err.pageId, serverVersion: err.serverVersion };
      }
      if (err instanceof NodeOverlapError) {
        reply.status(422);
        return { ok: false, code: 'node-overlap', error: err.message, conflicts: err.conflicts };
      }
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>('/api/pages/:id/merge', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = MergePageBodySchema.safeParse(req.body);
    if (!parsed.success || parsed.data.targetPageId === req.params.id) {
      reply.status(400);
      return { ok: false, error: 'invalid merge target' };
    }
    try {
      const initialMeta = await repo.loadMeta();
      if (req.params.id === SYSTEM_HIERARCHY_PAGE_ID) throw new Error('system page cannot be merged');
      if (!initialMeta.pages.some((page) => page.id === req.params.id)) throw new Error('source page not found');
      if (!initialMeta.pages.some((page) => page.id === parsed.data.targetPageId)) throw new Error('target page not found');
      if (initialMeta.pages.length <= 1) throw new Error('last page cannot be merged');
      // Recovery points are server-side preconditions so a client disconnect cannot skip them.
      await Promise.all([repo.createBackup(req.params.id), repo.createBackup(parsed.data.targetPageId)]);
      const source = await repo.loadPage(req.params.id);
      const nodeIds = source.nodes.map((node) => node.id);
      const moved = nodeIds.length > 0
        ? await moveNodesBetweenPages(repo, req.params.id, parsed.data.targetPageId, nodeIds)
        : { movedNodes: 0, movedEdges: 0, autoIncludedChildren: 0, lostEdges: 0, droppedParentLinks: 0 };
      const meta = await repo.loadMeta();
      await repo.deletePage(req.params.id, meta.revision);
      invalidateAll();
      return moved;
    } catch (error) {
      if (error instanceof VersionConflictError) {
        reply.status(409);
        return { ok: false, error: error.message, pageId: error.pageId, serverVersion: error.serverVersion };
      }
      if (error instanceof MetaVersionConflictError) {
        reply.status(409);
        return { ok: false, error: error.message, serverRevision: error.serverRevision };
      }
      reply.status(400);
      return { ok: false, error: (error as Error).message };
    }
  });

  app.get('/api/all-tasks', async (req): Promise<AllTasksResponse> => {
    const userId = getAuthenticatedUserId(req);
    const repo = getRepo(userId);
    const meta = await repo.loadMeta();
    const key = cacheKeyFromMeta(meta);
    const mtimes = await repo.listPageMtimes();
    const cached = getCache(userId);
    if (
      cached &&
      cached.key === key &&
      mtimes.every((m) => m.mtimeMs !== null && (cached.mtimes.get(m.pageId) ?? -1) >= m.mtimeMs)
    ) {
      return cached.response;
    }
    const tasks: AllTasksItem[] = [];
    const errors: NonNullable<AllTasksResponse['errors']> = [];
    for (const p of meta.pages) {
      try {
        const pd = await repo.loadPage(p.id);
        const readySet = new Set(readyTasks(pd).map((task) => task.id));
        for (const n of pd.nodes) {
          tasks.push({ ...n, _pageId: p.id, _pageTitle: p.title, _ready: readySet.has(n.id) });
        }
      } catch (err) {
        app.log.warn({ pageId: p.id, err }, 'skipping page in all-tasks aggregation');
        errors.push({ pageId: p.id, message: (err as Error).message });
      }
    }
    const response: AllTasksResponse = { tasks, ...(errors.length > 0 ? { errors } : {}) };
    const mtimesMap = new Map<string, number>();
    for (const m of mtimes) {
      if (m.mtimeMs !== null) mtimesMap.set(m.pageId, m.mtimeMs);
    }
    if (errors.length === 0) setCache(userId, { key, mtimes: mtimesMap, response });
    return response;
  });

  app.get('/api/workspace/markdown', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const meta = await repo.loadMeta();
    const md = await generateWorkspaceMarkdown(meta.pages, (id) => repo.loadPage(id));
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `inline; filename="TodoGraph-${new Date().toISOString().slice(0, 10)}.md"`);
    return md;
  });

  app.get('/api/workspace/export.json', async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const data = await repo.exportWorkspace();
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="TodoGraph-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return data;
  });

  app.post('/api/workspace/import', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const repo = getRepo(getAuthenticatedUserId(req));
    const parsed = WorkspaceImportSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      const meta = await repo.importWorkspace(parsed.data);
      invalidateAll();
      return { ok: true, meta };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });
};

function cacheKeyFromMeta(meta: Meta): string {
  return (
    meta.activePageId +
    '|' +
    meta.pages
      .map((p) => `${p.id}:${p.order}:${p.title}:${p.kind ?? 'graph'}`)
      .sort()
      .join(',')
  );
}

