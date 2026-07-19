import {
  MetaSchema,
  MAX_PAGE_TITLE_LENGTH,
  PageDataSchema,
  placeMovedNodesOnTarget,
  resolveNodeOverlaps,
  validateDependencyEdges,
  validateTaskHierarchy,
  type AllTasksItem,
  type AllTasksResponse,
  type Meta,
  type MoveNodesResponse,
  type PageData,
  type Task,
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
import { getAuthenticatedUserId } from '../auth.js';
import { executeTaskCommand } from '../application/taskCommands.js';

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
        ? await repo.restoreBackup(req.params.id, parsed.data.backupName)
        : await repo.restoreLatestBackup(req.params.id);
      return { ok: true, data };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      reply.status(e.code === 'ENOENT' ? 404 : 400);
      return { ok: false, error: (err as Error).message };
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
      mtimes.every((m) => (cached.mtimes.get(m.pageId) ?? -1) >= m.mtimeMs)
    ) {
      return cached.response;
    }
    const tasks: AllTasksItem[] = [];
    for (const p of meta.pages) {
      try {
        const pd = await repo.loadPage(p.id);
        const readySet = new Set(readyTasks(pd).map((task) => task.id));
        for (const n of pd.nodes) {
          tasks.push({ ...n, _pageId: p.id, _pageTitle: p.title, _ready: readySet.has(n.id) });
        }
      } catch (err) {
        app.log.warn({ pageId: p.id, err }, 'skipping page in all-tasks aggregation');
      }
    }
    const response: AllTasksResponse = { tasks };
    const mtimesMap = new Map<string, number>();
    for (const m of mtimes) mtimesMap.set(m.pageId, m.mtimeMs);
    setCache(userId, { key, mtimes: mtimesMap, response });
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
      .map((p) => `${p.id}:${p.order}:${p.title}`)
      .sort()
      .join(',')
  );
}

async function moveNodesBetweenPages(
  repo: WorkspaceRepository,
  sourceId: string,
  targetId: string,
  userSelected: string[],
  expectedSourceVersion?: number,
  expectedTargetVersion?: number,
): Promise<MoveNodesResponse> {
  const [source, target] = await Promise.all([repo.loadPage(sourceId), repo.loadPage(targetId)]);

  const byIdSrc = new Map(source.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const n of source.nodes) {
    if (n.parentId) {
      const arr = childrenOf.get(n.parentId);
      if (arr) arr.push(n.id);
      else childrenOf.set(n.parentId, [n.id]);
    }
  }
  const toMove = new Set<string>();
  const userSet = new Set<string>();
  for (const id of userSelected) {
    if (!byIdSrc.has(id)) continue;
    userSet.add(id);
    collectSubtree(id, childrenOf, toMove);
  }
  if (toMove.size === 0) {
    throw new Error('no valid nodes to move');
  }
  const autoIncludedChildren = toMove.size - userSet.size;

  let droppedParentLinks = 0;
  const movedNodes: Task[] = [];
  for (const id of toMove) {
    const n = byIdSrc.get(id)!;
    if (n.parentId && !toMove.has(n.parentId)) {
      let wx = n.x ?? 0;
      let wy = n.y ?? 0;
      let ancestorId: string | undefined = n.parentId;
      const seen = new Set<string>([n.id]);
      while (ancestorId && !seen.has(ancestorId)) {
        seen.add(ancestorId);
        const ancestor = byIdSrc.get(ancestorId);
        if (!ancestor) break;
        wx += ancestor.x ?? 0;
        wy += ancestor.y ?? 0;
        if (!ancestor.parentId || toMove.has(ancestor.parentId)) break;
        ancestorId = ancestor.parentId;
      }
      const copy: Task = {
        ...n,
        x: wx,
        y: wy,
      };
      delete copy.parentId;
      droppedParentLinks++;
      movedNodes.push(copy);
    } else {
      movedNodes.push(n);
    }
  }

  const movedEdges = source.edges.filter((e) => toMove.has(e.from) && toMove.has(e.to));
  const lostEdges = source.edges.filter(
    (e) =>
      (toMove.has(e.from) && !toMove.has(e.to)) || (!toMove.has(e.from) && toMove.has(e.to)),
  ).length;

  const targetIds = new Set(target.nodes.map((n) => n.id));
  for (const n of movedNodes) {
    if (targetIds.has(n.id)) {
      throw new Error(`node id conflict: ${n.id} already exists on target page`);
    }
  }

  const newSource: PageData = {
    nodes: resolveNodeOverlaps(source.nodes.filter((n) => !toMove.has(n.id))).nodes,
    edges: source.edges.filter((e) => !toMove.has(e.from) && !toMove.has(e.to)),
  };
  const safeTargetNodes = resolveNodeOverlaps(target.nodes).nodes;
  const placedMovedNodes = placeMovedNodesOnTarget(safeTargetNodes, movedNodes);
  const newTarget: PageData = {
    nodes: [...safeTargetNodes, ...placedMovedNodes],
    edges: [...target.edges, ...movedEdges],
  };

  if (!isDAG(newSource) || !isDAG(newTarget)) {
    throw new Error('resulting page would contain a cycle');
  }

  await repo.savePages([
    { pageId: sourceId, data: newSource, expectedVersion: expectedSourceVersion ?? source.version },
    { pageId: targetId, data: newTarget, expectedVersion: expectedTargetVersion ?? target.version },
  ]);

  return {
    movedNodes: toMove.size,
    movedEdges: movedEdges.length,
    autoIncludedChildren,
    lostEdges,
    droppedParentLinks,
  };
}

function collectSubtree(rootId: string, childrenOf: Map<string, string[]>, out: Set<string>): void {
  if (out.has(rootId)) return;
  out.add(rootId);
  for (const child of childrenOf.get(rootId) ?? []) {
    collectSubtree(child, childrenOf, out);
  }
}
