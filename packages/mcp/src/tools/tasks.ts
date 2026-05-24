import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dagre from 'dagre';
import type { client as ClientType } from '../client.js';

// ── Helpers ──

function generateId(): string {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 写操作前静默备份，失败不阻断主流程 */
async function backupBeforeMutation(c: typeof ClientType, pageId: string): Promise<void> {
  try {
    await c.post(`/api/pages/${encodeURIComponent(pageId)}/backup`);
  } catch { /* 静默 */ }
}

interface Layoutable {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  title?: string;
  status?: string;
  description?: string;
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

// ── Collision avoidance ──

interface CollisionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectsOverlap(a: CollisionRect, b: CollisionRect, gap: number): boolean {
  return (
    a.x - gap < b.x + b.w + gap &&
    a.x + a.w + gap > b.x - gap &&
    a.y - gap < b.y + b.h + gap &&
    a.y + a.h + gap > b.y - gap
  );
}

/** 把新节点作为一个整体，从 (0,0) 开始螺旋搜索不跟已有节点碰撞的位置 */
function avoidCollision(
  newRects: CollisionRect[],
  existingRects: CollisionRect[],
  step = 24,
  gap = 48,
  maxRing = 60,
): { dx: number; dy: number } {
  if (clusterFits(newRects, existingRects, 0, 0, gap)) return { dx: 0, dy: 0 };

  for (let ring = 1; ring <= maxRing; ring++) {
    const candidates: Array<{ dx: number; dy: number; d2: number }> = [];
    for (let x = -ring; x <= ring; x++) {
      for (let y = -ring; y <= ring; y++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
        candidates.push({ dx: x * step, dy: y * step, d2: x * x + y * y });
      }
    }
    candidates.sort((a, b) => a.d2 - b.d2 || a.dy - b.dy || a.dx - b.dx);
    for (const c of candidates) {
      if (clusterFits(newRects, existingRects, c.dx, c.dy, gap)) {
        return { dx: c.dx, dy: c.dy };
      }
    }
  }

  return { dx: 0, dy: 0 };
}

function clusterFits(
  newRects: CollisionRect[],
  existingRects: CollisionRect[],
  dx: number,
  dy: number,
  gap: number,
): boolean {
  const shifted = newRects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  for (const s of shifted) {
    for (const e of existingRects) {
      if (rectsOverlap(s, e, gap)) return false;
    }
  }
  for (let i = 0; i < shifted.length; i++) {
    for (let j = i + 1; j < shifted.length; j++) {
      if (rectsOverlap(shifted[i]!, shifted[j]!, gap)) return false;
    }
  }
  return true;
}

const DEFAULT_W = 180, DEFAULT_H = 48;

function buildRects(nodes: Layoutable[]): CollisionRect[] {
  return nodes.map((n) => ({
    id: n.id,
    x: n.x ?? 0,
    y: n.y ?? 0,
    w: n.width ?? DEFAULT_W,
    h: DEFAULT_H,
  }));
}

// ── Handlers ──

export async function handleCreateTask(
  c: typeof ClientType,
  params: {
    page_id: string;
    title: string;
    status?: string;
    description?: string;
    depends_on?: string[];
  },
) {
  const page = await c.get<{
    nodes: Array<{ id: string; title: string }>;
    edges: Array<{ from: string; to: string }>;
    version?: number;
  }>(`/api/pages/${encodeURIComponent(params.page_id)}`);

  const newId = generateId();
  const newNode: Layoutable = {
    id: newId,
    title: params.title,
    status: params.status ?? 'todo',
    ...(params.description ? { description: params.description } : {}),
  };

  const allNodes: Layoutable[] = [...page.nodes as Layoutable[], newNode];
  const newEdges = [...page.edges];

  if (params.depends_on && params.depends_on.length > 0) {
    const existingIds = new Set(page.nodes.map((n) => n.id));
    for (const depId of params.depends_on) {
      if (!existingIds.has(depId)) continue;
      if (depId === newId) continue;
      newEdges.push({ from: depId, to: newId });
    }
  }

  // Dagre 布局 + 碰撞避免
  const newIdSet = new Set([newId]);
  const existing: Layoutable[] = page.nodes as Layoutable[];
  const all: Layoutable[] = [...existing, newNode];
  layoutNodes(all, newIdSet, newEdges);

  const { dx, dy } = avoidCollision(buildRects([newNode]), buildRects(existing));
  if (dx !== 0 || dy !== 0) {
    newNode.x = (newNode.x ?? 0) + dx;
    newNode.y = (newNode.y ?? 0) + dy;
  }

  await backupBeforeMutation(c, params.page_id);
  await c.put(`/api/pages/${encodeURIComponent(params.page_id)}`, {
    nodes: all,
    edges: newEdges,
    expectedVersion: page.version,
  });

  return { task: { id: newId, title: params.title, status: params.status ?? 'todo', x: newNode.x, y: newNode.y } };
}

export async function handleCreateTasks(
  c: typeof ClientType,
  params: {
    page_id: string;
    tasks: Array<{ title: string; status?: string; description?: string }>;
    edges?: Array<{ from: number; to: number }>;
  },
) {
  const page = await c.get<{
    nodes: Array<{ id: string }>;
    edges: Array<{ from: string; to: string }>;
    version?: number;
  }>(`/api/pages/${encodeURIComponent(params.page_id)}`);

  const ids = params.tasks.map(() => generateId());
  const newNodes: Layoutable[] = params.tasks.map((t, i) => ({
    id: ids[i]!,
    title: t.title,
    status: t.status ?? 'todo',
    ...(t.description ? { description: t.description } : {}),
  }));

  const newEdges = [...page.edges];
  const rejectedEdges: Array<{ from: number; to: number; reason: string }> = [];

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
      newEdges.push({ from: ids[e.from]!, to: ids[e.to]! });
    }
  }

  // Dagre 自动布局 + 碰撞避免
  const newNodeIds = new Set(ids);
  const existingNodes: Layoutable[] = page.nodes as Layoutable[];
  const allNodes: Layoutable[] = [...existingNodes, ...newNodes];
  layoutNodes(allNodes, newNodeIds, newEdges);

  // 新节点作为一个集群，避免与已有节点重叠
  const existingRects = buildRects(existingNodes);
  const newRects = buildRects(newNodes);
  const { dx, dy } = avoidCollision(newRects, existingRects);
  if (dx !== 0 || dy !== 0) {
    for (const n of newNodes) {
      n.x = (n.x ?? 0) + dx;
      n.y = (n.y ?? 0) + dy;
    }
    allNodes.length = 0;
    allNodes.push(...existingNodes, ...newNodes);
  }

  try {
    await c.put(`/api/pages/${encodeURIComponent(params.page_id)}`, {
      nodes: allNodes,
      edges: newEdges,
      expectedVersion: page.version,
    });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (msg.includes('cycle')) {
      throw new Error(`graph contains a cycle — some edges were rejected. Review the edges array.`);
    }
    throw err;
  }

  return {
    created: newNodes.map((n) => ({
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
    status?: string;
    description?: string;
    x?: number;
    y?: number;
  },
) {
  const page = await c.get<{
    nodes: Array<{
      id: string; title: string; status: string; parentId?: string;
      description?: string; x?: number; y?: number;
    }>;
    edges: Array<{ from: string; to: string }>;
    version?: number;
  }>(`/api/pages/${encodeURIComponent(params.page_id)}`);

  const idx = page.nodes.findIndex((n) => n.id === params.task_id);
  if (idx === -1) throw new Error(`task not found: ${params.task_id}`);

  const node = page.nodes[idx]!;
  const updated: typeof node = { ...node };
  if (params.title !== undefined) updated.title = params.title;
  if (params.status !== undefined) updated.status = params.status;
  if (params.description !== undefined) updated.description = params.description;
  if (params.x !== undefined) updated.x = params.x;
  if (params.y !== undefined) updated.y = params.y;

  const newNodes = [...page.nodes];
  newNodes[idx] = updated;

  await c.put(`/api/pages/${encodeURIComponent(params.page_id)}`, {
    nodes: newNodes,
    edges: page.edges,
    expectedVersion: page.version,
  });

  return { task: updated };
}

// ── MCP Registration ──

export function registerTaskTools(server: McpServer, c: typeof ClientType) {
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
    async (params) => {
      const result = await handleCreateTask(c, params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
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
    async (params) => {
      const result = await handleCreateTasks(c, params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
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
    async (params) => {
      const result = await handleUpdateTask(c, params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
