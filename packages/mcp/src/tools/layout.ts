import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dagre from 'dagre';
import { computeNodeSizeMap, type Task } from '@todograph/shared';
import type { client as ClientType } from '../client.js';

// ── Handler ──

export async function handleAutoLayout(
  c: typeof ClientType,
  params: { page_id: string },
) {
  const page = await c.get<{
    nodes: Array<{
      id: string; title: string; status: string; parentId?: string;
      x?: number; y?: number; width?: number;
    }>;
    edges: Array<{ from: string; to: string }>;
  }>(`/api/pages/${encodeURIComponent(params.page_id)}`);

  if (page.nodes.length === 0) {
    return { positions: [], layoutInfo: { direction: 'LR', nodesCount: 0 } };
  }

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 20, marginy: 20 });

  const nodes = page.nodes as Task[];
  const roots = nodes.filter((node) => !node.parentId);
  const rootIds = new Set(roots.map((node) => node.id));
  const sizeMap = computeNodeSizeMap(nodes);

  for (const n of roots) {
    const size = sizeMap.get(n.id)!;
    g.setNode(n.id, { width: size.w, height: size.h });
  }
  for (const e of page.edges) {
    if (rootIds.has(e.from) && rootIds.has(e.to)) g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  const positions = page.nodes.map((n) => {
    const p = g.node(n.id);
    if (!p) return { task_id: n.id, x: n.x ?? 0, y: n.y ?? 0 };
    const size = sizeMap.get(n.id)!;
    return {
      task_id: n.id,
      x: Math.round(p.x - size.w / 2),
      y: Math.round(p.y - size.h / 2),
    };
  });

  return {
    positions,
    layoutInfo: { direction: 'LR', nodesCount: page.nodes.length },
  };
}

// ── MCP Registration ──

export function registerLayoutTools(server: McpServer, c: typeof ClientType) {
  server.registerTool(
    'todograph_auto_layout',
    {
      title: 'Auto-layout graph',
      description:
        '对指定页面的任务运行 dagre 自动布局算法（左→右层级布局）。返回每个节点的新坐标（x, y）。坐标以左上角为原点。拿到结果后，你需要调用 todograph_update_task 逐个更新每个任务的 x, y 坐标。注意：此工具只计算坐标，不修改数据。',
      inputSchema: {
        page_id: z.string().min(1).describe('页面 ID'),
      },
    },
    async ({ page_id }) => {
      const result = await handleAutoLayout(c, { page_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
