import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { client as ClientType } from '../client.js';

// ── Handlers (testable without MCP) ──

export async function handleListPages(c: typeof ClientType) {
  const meta = await c.get<{
    pages: Array<{ id: string; title: string; order: number; createdAt: string }>;
  }>('/api/meta');

  const pagesWithCounts = await Promise.all(
    meta.pages.map(async (p) => {
      try {
        const page = await c.get<{ nodes: unknown[] }>(`/api/pages/${encodeURIComponent(p.id)}`);
        return { ...p, taskCount: page.nodes.length };
      } catch {
        return { ...p, taskCount: -1 };
      }
    }),
  );

  return { pages: pagesWithCounts };
}

export async function handleGetPage(c: typeof ClientType, params: { page_id: string }) {
  const meta = await c.get<{
    pages: Array<{ id: string; title: string }>;
  }>('/api/meta');
  const pageMeta = meta.pages.find((p) => p.id === params.page_id);
  if (!pageMeta) throw new Error(`page not found: ${params.page_id}`);

  const page = await c.get<{
    nodes: Array<{ id: string; title: string; status: string; parentId?: string; description?: string; x?: number; y?: number }>;
    edges: Array<{ from: string; to: string }>;
  }>(`/api/pages/${encodeURIComponent(params.page_id)}`);

  return {
    page: { id: pageMeta.id, title: pageMeta.title },
    tasks: page.nodes,
    edges: page.edges,
  };
}

export async function handleCreatePage(c: typeof ClientType, params: { title: string }) {
  const result = await c.post<{
    page: { id: string; title: string; order: number; createdAt: string };
    meta: unknown;
  }>('/api/pages', { title: params.title });

  return { page: result.page };
}

export async function handleMergePages(
  c: typeof ClientType,
  params: { source_page_id: string; target_page_id: string },
) {
  if (params.source_page_id === params.target_page_id) {
    throw new Error('source and target are the same page');
  }

  // 备份两页
  await Promise.allSettled([
    c.post(`/api/pages/${encodeURIComponent(params.source_page_id)}/backup`),
    c.post(`/api/pages/${encodeURIComponent(params.target_page_id)}/backup`),
  ]);

  const source = await c.get<{ nodes: Array<{ id: string }>; version?: number }>(
    `/api/pages/${encodeURIComponent(params.source_page_id)}`,
  );
  const nodeIds = source.nodes.map((n) => n.id);

  let moveResult: {
    movedNodes: number;
    movedEdges: number;
    autoIncludedChildren: number;
    lostEdges: number;
    droppedParentLinks: number;
  } = { movedNodes: 0, movedEdges: 0, autoIncludedChildren: 0, lostEdges: 0, droppedParentLinks: 0 };

  if (nodeIds.length > 0) {
    moveResult = await c.post<typeof moveResult>(
      `/api/pages/${encodeURIComponent(params.source_page_id)}/move-nodes`,
      {
        targetPageId: params.target_page_id,
        nodeIds,
      },
    );
  }

  const meta = await c.get<{ revision: number }>('/api/meta');
  await c.delete(`/api/pages/${encodeURIComponent(params.source_page_id)}`, {
    expectedRevision: meta.revision,
  });

  return moveResult;
}

// ── MCP Registration ──

export function registerPageTools(server: McpServer, c: typeof ClientType) {
  server.registerTool(
    'todograph_list_pages',
    {
      title: 'List all pages',
      description:
        '列出 TodoGraph 工作区中所有页面，返回每个页面的 id、标题、排序、任务数量。用于了解工作区全貌，是大多数操作的第一步。',
      inputSchema: {},
    },
    async () => {
      const result = await handleListPages(c);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'todograph_get_page',
    {
      title: 'Get page details',
      description:
        '获取指定页面的完整数据，包括所有任务节点（id, title, status, parentId, description, x, y）和依赖边（from, to）。修改页面内容前必须先调用此工具了解当前状态。',
      inputSchema: { page_id: z.string().min(1).describe('页面 ID') },
    },
    async ({ page_id }) => {
      const result = await handleGetPage(c, { page_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'todograph_create_page',
    {
      title: 'Create a new page',
      description:
        '新建一个页面。页面是任务的容器，不同页面可以按主题/阶段组织任务。title 长度 1-100 字符。',
      inputSchema: { title: z.string().min(1).max(100).describe('页面标题') },
    },
    async ({ title }) => {
      const result = await handleCreatePage(c, { title });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'todograph_merge_pages',
    {
      title: 'Merge two pages',
      description:
        '合并两个页面：将源页的所有任务迁移到目标页，然后删除源页。内部调用 move-nodes + delete API。至少保留一个页面。注意：跨页依赖边会丢失，子节点自动跟随父节点迁移。',
      inputSchema: {
        source_page_id: z.string().min(1).describe('要合并的源页面 ID（此页将被删除）'),
        target_page_id: z.string().min(1).describe('目标页面 ID（任务迁入此页）'),
      },
    },
    async ({ source_page_id, target_page_id }) => {
      const result = await handleMergePages(c, { source_page_id, target_page_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
