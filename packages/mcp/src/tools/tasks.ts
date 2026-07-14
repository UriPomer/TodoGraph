import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dagre from 'dagre';
import {
  resolveNodeOverlaps,
  type PageData,
  type Task,
  type TaskStatus,
} from '@todograph/shared';
import type { client as ClientType } from '../client.js';
import { backupBeforeMutation } from './backup.js';
import { textResult } from './result.js';

function generateId(): string {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

type Layoutable = Task;
type Page = PageData;

const pagePath = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}`;
const loadPage = (c: typeof ClientType, pageId: string) => c.get<Page>(pagePath(pageId));
async function savePage(c: typeof ClientType, pageId: string, page: Page) {
  await backupBeforeMutation(c, pageId);
  await c.put(pagePath(pageId), {
    nodes: page.nodes,
    edges: page.edges,
    expectedVersion: page.version,
  });
}

/** 对已有节点+新节点跑 dagre LR 布局，把坐标写入新节点 */
function layoutNodes(
  allNodes: Layoutable[],
  newNodeIds: Set<string>,
  edges: Array<{ from: string; to: string }>,
): void {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });

  const seen = new Set<string>();
  for (const n of allNodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (newNodeIds.has(n.id)) {
      g.setNode(n.id, { width: n.width ?? DEFAULT_W, height: DEFAULT_H });
    } else {
      // Pin 已有节点位置，dagre 只排新节点
      const w = n.width ?? DEFAULT_W;
      const h = DEFAULT_H;
      g.setNode(n.id, { width: w, height: h, x: (n.x ?? 0) + w / 2, y: (n.y ?? 0) + h / 2, fixed: true });
    }
  }
  for (const e of edges) g.setEdge(e.from, e.to);

  dagre.layout(g);

  // 只写回新节点的坐标
  for (const n of allNodes) {
    if (newNodeIds.has(n.id)) {
      const p = g.node(n.id);
      if (p) {
        n.x = Math.round(p.x - (n.width ?? DEFAULT_W) / 2);
        n.y = Math.round(p.y - DEFAULT_H / 2);
      }
    }
  }
}

const DEFAULT_W = 180, DEFAULT_H = 56;

export async function handleDeleteTasks(
  c: typeof ClientType,
  params: {
    page_id: string;
    task_ids: string[];
  },
) {
  const page = await loadPage(c, params.page_id);

  const ids = new Set(params.task_ids);
  const removed: string[] = [];
  const removedNodes = new Map(page.nodes.map((node) => [node.id, node]));
  const releasedIds: string[] = [];
  const keptNodes = page.nodes.filter((n) => {
    if (ids.has(n.id)) {
      removed.push(n.id);
      return false;
    }
    return true;
  }).map((node) => {
    if (!node.parentId || !ids.has(node.parentId)) return node;
    let x = node.x ?? 0;
    let y = node.y ?? 0;
    let parentId: string | undefined = node.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = removedNodes.get(parentId);
      if (!parent) break;
      x += parent.x ?? 0;
      y += parent.y ?? 0;
      parentId = parent.parentId;
    }
    releasedIds.push(node.id);
    return { ...node, parentId: undefined, x, y };
  });
  const keptEdges = page.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));

  if (removed.length === 0) {
    return { removed: 0, warning: 'none of the requested task_ids were found' };
  }

  const repaired = resolveNodeOverlaps(keptNodes, {
    changedIds: releasedIds,
    pinnedIds: releasedIds,
  }).nodes;
  await savePage(c, params.page_id, { ...page, nodes: repaired, edges: keptEdges });

  return { removed: removed.length, removedIds: removed };
}

export async function handleCreateTask(
  c: typeof ClientType,
  params: {
    page_id: string;
    title: string;
    status?: TaskStatus;
    description?: string;
    depends_on?: string[];
  },
) {
  const page = await loadPage(c, params.page_id);

  const newId = generateId();
  const newNode: Layoutable = {
    id: newId,
    title: params.title,
    status: params.status ?? 'todo',
    ...(params.description ? { description: params.description } : {}),
  };

  const newEdges = [...page.edges];
  const existingIds = new Set(page.nodes.map((node) => node.id));
  const rejectedDependencies: string[] = [];
  for (const depId of new Set(params.depends_on ?? [])) {
    if (existingIds.has(depId)) newEdges.push({ from: depId, to: newId });
    else rejectedDependencies.push(depId);
  }

  // Dagre 布局 + 碰撞避免
  const newIdSet = new Set([newId]);
  const existing = resolveNodeOverlaps(page.nodes).nodes;
  const all: Layoutable[] = [...existing, newNode];
  layoutNodes(all, newIdSet, newEdges);
  const resolved = resolveNodeOverlaps(all, { changedIds: [newId], pinnedIds: [newId], gap: 48 }).nodes;
  const savedNode = resolved.find((node) => node.id === newId)!;

  await savePage(c, params.page_id, { ...page, nodes: resolved, edges: newEdges });

  return {
    task: {
      id: newId,
      title: params.title,
      status: params.status ?? 'todo',
      x: savedNode.x,
      y: savedNode.y,
    },
    ...(rejectedDependencies.length ? { rejectedDependencies } : {}),
  };
}

export async function handleCreateTasks(
  c: typeof ClientType,
  params: {
    page_id: string;
    tasks: Array<{ title: string; status?: TaskStatus; description?: string }>;
    edges?: Array<{ from: number; to: number }>;
  },
) {
  const page = await loadPage(c, params.page_id);

  const ids = params.tasks.map(() => generateId());
  const newNodes: Layoutable[] = params.tasks.map((t, i) => ({
    id: ids[i]!,
    title: t.title,
    status: t.status ?? 'todo',
    ...(t.description ? { description: t.description } : {}),
  }));

  const newEdges = [...page.edges];
  const rejectedEdges: Array<{ from: number; to: number; reason: string }> = [];

  const edgeKeys = new Set<string>();
  if (params.edges) {
    for (const e of params.edges) {
      if (e.from === e.to) {
        rejectedEdges.push({ from: e.from, to: e.to, reason: 'self-loop' });
        continue;
      }
      if (e.from < 0 || e.from >= ids.length || e.to < 0 || e.to >= ids.length) {
        rejectedEdges.push({ from: e.from, to: e.to, reason: 'index out of range' });
        continue;
      }
      const key = `${e.from}:${e.to}`;
      if (edgeKeys.has(key)) {
        rejectedEdges.push({ from: e.from, to: e.to, reason: 'duplicate' });
        continue;
      }
      edgeKeys.add(key);
      newEdges.push({ from: ids[e.from]!, to: ids[e.to]! });
    }
  }

  // Dagre 自动布局 + 碰撞避免
  const newNodeIds = new Set(ids);
  const existingNodes = resolveNodeOverlaps(page.nodes).nodes;
  const allNodes: Layoutable[] = [...existingNodes, ...newNodes];
  layoutNodes(allNodes, newNodeIds, newEdges);
  const resolved = resolveNodeOverlaps(allNodes, {
    changedIds: ids,
    pinnedIds: ids,
    gap: 48,
  }).nodes;

  try {
    await savePage(c, params.page_id, { ...page, nodes: resolved, edges: newEdges });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg.includes('cycle')) {
      throw new Error(`graph contains a cycle — some edges were rejected. Review the edges array.`);
    }
    throw err;
  }

  return {
    created: ids.map((id) => resolved.find((node) => node.id === id)!).map((n) => ({
      id: n.id,
      title: n.title ?? '',
      status: n.status ?? 'todo',
      x: n.x,
      y: n.y,
    })),
    edgesCreated: params.edges ? params.edges.length - rejectedEdges.length : 0,
    ...(rejectedEdges.length > 0 ? { rejectedEdges } : {}),
  };
}

export async function handleUpdateTask(
  c: typeof ClientType,
  params: {
    page_id: string;
    task_id: string;
    title?: string;
    status?: TaskStatus;
    description?: string;
    x?: number;
    y?: number;
  },
) {
  const page = await loadPage(c, params.page_id);

  const repaired = resolveNodeOverlaps(page.nodes).nodes;
  const idx = repaired.findIndex((n) => n.id === params.task_id);
  if (idx === -1) throw new Error(`task not found: ${params.task_id}`);
  if (params.title === undefined && params.status === undefined && params.description === undefined &&
      params.x === undefined && params.y === undefined) throw new Error('no fields to update');

  const node = repaired[idx]!;
  const updated: typeof node = { ...node };
  if (params.title !== undefined) updated.title = params.title;
  if (params.status !== undefined) updated.status = params.status;
  if (params.description !== undefined) updated.description = params.description;
  if (params.x !== undefined) updated.x = params.x;
  if (params.y !== undefined) updated.y = params.y;

  const newNodes = [...repaired];
  newNodes[idx] = updated;
  const resolved = resolveNodeOverlaps(newNodes, {
    changedIds: [updated.id],
    pinnedIds: [updated.id],
    gap: 48,
  }).nodes;
  const savedNode = resolved.find((candidate) => candidate.id === updated.id)!;

  await savePage(c, params.page_id, { ...page, nodes: resolved });

  return { task: savedNode };
}

export function registerTaskTools(server: McpServer, c: typeof ClientType) {
  server.registerTool(
    'todograph_delete_tasks',
    {
      title: 'Delete tasks',
      description:
        '按 ID 删除一个或多个任务。同时自动移除与这些任务相关的所有依赖边（入边和出边）。删除后不会自动重新布局，如需调整布局请调用 auto_layout。删除前会自动备份。',
      inputSchema: {
        page_id: z.string().min(1).describe('页面 ID'),
        task_ids: z.array(z.string().min(1)).min(1).max(100).describe('要删除的任务 ID 列表'),
      },
    },
    async (params) => textResult(await handleDeleteTasks(c, params)),
  );

  server.registerTool(
    'todograph_restore_backup',
    {
      title: 'Restore page from backup',
      description:
        '从最新备份恢复页面数据。每次经由 MCP 的写操作（创建/更新/删除任务、管理依赖、合并页面）都会在操作前自动备份。此工具恢复最近一次备份的状态。注意：恢复后页面版本号会发生变化，前端会自动检测刷新。',
      inputSchema: {
        page_id: z.string().min(1).describe('要恢复备份的页面 ID'),
      },
    },
    async (params) => {
      const result = await c.post<{ ok: boolean; data?: unknown; error?: string }>(`/api/pages/${encodeURIComponent(params.page_id)}/restore`);
      if (!result.ok) throw new Error(result.error ?? 'restore failed');
      return textResult({ restored: true, data: result.data });
    },
  );

  server.registerTool(
    'todograph_create_task',
    {
      title: 'Create a single task',
      description:
        '在指定页面创建一个新任务。可选设置 depends_on（已有任务 id 列表），创建后自动建立依赖边。status 默认为 "todo"。',
      inputSchema: {
        page_id: z.string().min(1).describe('页面 ID'),
        title: z.string().min(1).max(200).describe('任务标题'),
        status: z.enum(['todo', 'doing', 'done']).optional().describe('状态，默认 todo'),
        description: z.string().max(4000).optional().describe('任务描述'),
        depends_on: z.array(z.string().min(1)).optional().describe('依赖的已有任务 id 列表'),
      },
    },
    async (params) => textResult(await handleCreateTask(c, params)),
  );

  server.registerTool(
    'todograph_create_tasks',
    {
      title: 'Create multiple tasks with dependencies',
      description:
        '批量创建任务并自由定义依赖图。tasks 数组中每个元素按其在数组中的索引（0, 1, 2...）被 edges 引用。edges 中的 from/to 都是 tasks 数组的索引编号。例如 edges: [{from: 0, to: 1}] 表示第 0 个任务完成后才能做第 1 个。服务端自动拒绝产生环的边。',
      inputSchema: {
        page_id: z.string().min(1).describe('页面 ID'),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              status: z.enum(['todo', 'doing', 'done']).optional(),
              description: z.string().max(4000).optional(),
            }),
          )
          .min(1)
          .max(50)
          .describe('要创建的任务列表，1-50 个'),
        edges: z
          .array(z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }))
          .optional()
          .describe('依赖边：from/to 都是 tasks 数组索引'),
      },
    },
    async (params) => textResult(await handleCreateTasks(c, params)),
  );

  server.registerTool(
    'todograph_update_task',
    {
      title: 'Update a task',
      description:
        '更新任务的属性。可以同时更新多个字段（title, status, description, x, y）。修改坐标（x, y）通常配合 auto_layout 的结果使用。status 可选值: todo, doing, done。',
      inputSchema: {
        page_id: z.string().min(1).describe('页面 ID'),
        task_id: z.string().min(1).describe('任务 ID'),
        title: z.string().min(1).max(200).optional().describe('新标题'),
        status: z.enum(['todo', 'doing', 'done']).optional().describe('新状态'),
        description: z.string().max(4000).optional().describe('新描述'),
        x: z.number().optional().describe('X 坐标'),
        y: z.number().optional().describe('Y 坐标'),
      },
    },
    async (params) => textResult(await handleUpdateTask(c, params)),
  );
}
