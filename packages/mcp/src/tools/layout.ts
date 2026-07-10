import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import dagre from 'dagre';
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

  const DEFAULT_W = 180;
  const DEFAULT_H = 56;

  for (const n of page.nodes) {
    g.setNode(n.id, { width: n.width ?? DEFAULT_W, height: DEFAULT_H });
  }
  for (const e of page.edges) {
    g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  const positions = page.nodes.map((n) => {
    const p = g.node(n.id);
    if (!p) return { task_id: n.id, x: n.x ?? 0, y: n.y ?? 0 };
    const w = n.width ?? DEFAULT_W;
    const h = DEFAULT_H;
    return {
      task_id: n.id,
      x: Math.round(p.x - w / 2),
      y: Math.round(p.y - h / 2),
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
