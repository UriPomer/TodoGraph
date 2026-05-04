import {
  MetaSchema,
  PageDataSchema,
  placeMovedNodesOnTarget,
  type AllTasksItem,
  type AllTasksResponse,
  type Meta,
  type MoveNodesResponse,
  type PageData,
  type Task,
} from '@todograph/shared';
import { isDAG } from '@todograph/core';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { WorkspaceRepository } from '../repositories/Repository.js';

interface Opts {
  getRepo: (userId: string) => WorkspaceRepository;
}

const MoveNodesBodySchema = z.object({
  targetPageId: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).min(1),
});

const CreatePageBodySchema = z.object({
  title: z.string(),
});

const PatchPageBodySchema = z.object({
  title: z.string().optional(),
  activate: z.boolean().optional(),
});

const ReorderBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

const UpdateSettingsBodySchema = z.object({
  mergeHoverMs: z.number().int().min(0).max(5000).optional(),
  ungroupConfirmMs: z.number().int().min(0).max(5000).optional(),
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

  // ---- meta ----
  app.get('/api/meta', async (req) => {
    const repo = getRepo(req.session.userId!);
    return repo.loadMeta();
  });

  app.patch('/api/meta/settings', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
    const parsed = UpdateSettingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    await repo.updateSettings(parsed.data);
    return { ok: true };
  });

  // ---- pages ----
  app.get<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
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
    const repo = getRepo(req.session.userId!);
    const parsed = PageDataSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    if (!isDAG(parsed.data)) {
      reply.status(400);
      return { ok: false, error: 'graph contains a cycle' };
    }
    await repo.savePage(req.params.id, parsed.data);
    invalidateAll();
    return { ok: true };
  });

  app.post('/api/pages', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
    const parsed = CreatePageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    const info = await repo.createPage(parsed.data.title);
    invalidateAll();
    return info;
  });

  app.delete<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
    try {
      await repo.deletePage(req.params.id);
      invalidateAll();
      return { ok: true };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.patch<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
    const parsed = PatchPageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      if (parsed.data.title !== undefined) {
        await repo.renamePage(req.params.id, parsed.data.title);
        invalidateAll();
      }
      if (parsed.data.activate) {
        await repo.setActivePage(req.params.id);
      }
      return { ok: true };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.post('/api/pages/reorder', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
    const parsed = ReorderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'invalid payload', issues: parsed.error.issues };
    }
    try {
      await repo.reorderPages(parsed.data.ids);
      invalidateAll();
      return { ok: true };
    } catch (err) {
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ---- 自动备份：拷贝当前页面文件到 backups/ 目录 ----
  app.post<{ Params: { id: string } }>('/api/pages/:id/backup', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
    try {
      await repo.createBackup(req.params.id);
      return { ok: true };
    } catch (err) {
      reply.status(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ---- 跨页转移：自动带上整棵子树 ----
  app.post<{ Params: { id: string } }>('/api/pages/:id/move-nodes', async (req, reply) => {
    const repo = getRepo(req.session.userId!);
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
      const resp = await moveNodesBetweenPages(repo, sourceId, targetPageId, nodeIds);
      invalidateAll();
      return resp;
    } catch (err) {
      reply.status(400);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ---- 全局任务聚合：左侧列表用 ----
  app.get('/api/all-tasks', async (req): Promise<AllTasksResponse> => {
    const userId = req.session.userId!;
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
        for (const n of pd.nodes) {
          tasks.push({ ...n, _pageId: p.id, _pageTitle: p.title });
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
): Promise<MoveNodesResponse> {
  const [source, target] = await Promise.all([repo.loadPage(sourceId), repo.loadPage(targetId)]);

  const byIdSrc = new Map(source.nodes.map((n) => [n.id, n]));
  // 自动带上整棵子树：遍历每个选中节点的所有后代
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

  // 坐标归一化：根节点若有 parentId 但 parentId 不在 toMove 中，转成世界坐标；
  //             parentId 在 toMove 中的节点保留相对坐标。
  //             真正的 root（无 parentId）保持世界坐标不变。
  let droppedParentLinks = 0;
  const movedNodes: Task[] = [];
  for (const id of toMove) {
    const n = byIdSrc.get(id)!;
    if (n.parentId && !toMove.has(n.parentId)) {
      // 这个节点的父不跟着走 —— 把相对坐标沿祖先链递归累加成世界坐标，再清空 parentId
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

  // Edges：只保留"两端都在 toMove 里"的 —— 其它全部丢失
  const movedEdges = source.edges.filter((e) => toMove.has(e.from) && toMove.has(e.to));
  const lostEdges = source.edges.filter(
    (e) =>
      (toMove.has(e.from) && !toMove.has(e.to)) || (!toMove.has(e.from) && toMove.has(e.to)),
  ).length;

  // 目标页不允许重名 id
  const targetIds = new Set(target.nodes.map((n) => n.id));
  for (const n of movedNodes) {
    if (targetIds.has(n.id)) {
      throw new Error(`node id conflict: ${n.id} already exists on target page`);
    }
  }

  const newSource: PageData = {
    nodes: source.nodes.filter((n) => !toMove.has(n.id)),
    edges: source.edges.filter((e) => !toMove.has(e.from) && !toMove.has(e.to)),
  };
  const placedMovedNodes = placeMovedNodesOnTarget(target.nodes, movedNodes);
  const newTarget: PageData = {
    nodes: [...target.nodes, ...placedMovedNodes],
    edges: [...target.edges, ...movedEdges],
  };

  // DAG 校验（两页分别验证）
  if (!isDAG(newSource) || !isDAG(newTarget)) {
    throw new Error('resulting page would contain a cycle');
  }

  await repo.savePage(sourceId, newSource);
  await repo.savePage(targetId, newTarget);

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

// 静默未使用的 MetaSchema 以便未来需要（当前仓库返回的就是 Meta 类型，不需要再 parse）
void MetaSchema;
