import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { client as ClientType } from '../client.js';
import { toolResult } from './result.js';

// ── Handlers ──

export async function handleManageDependencies(
  c: typeof ClientType,
  params: {
    page_id: string;
    add?: Array<{ from: string; to: string }>;
    remove?: Array<{ from: string; to: string }>;
  },
) {
  return c.post<{
    added: number;
    removed: number;
    rejected?: Array<{ from: string; to: string; reason: string }>;
  }>(`/api/pages/${encodeURIComponent(params.page_id)}/commands`, {
    type: 'manage_dependencies',
    add: params.add,
    remove: params.remove,
  });
}

export async function handleGetRecommendations(
  c: typeof ClientType,
  params: { page_id?: string },
) {
  const allTasks = await c.get<{
    tasks: Array<{
      id: string; title: string; status: string;
      _pageId: string; _pageTitle: string; _ready: boolean;
    }>;
  }>('/api/all-tasks');

  let tasks = allTasks.tasks;
  if (params.page_id) {
    tasks = tasks.filter((t) => t._pageId === params.page_id);
  }

  const ready = tasks.filter((t) => t._ready);
  const doing = ready.filter((t) => t.status === 'doing');
  const todo = ready.filter((t) => t.status === 'todo');

  const recommendations = [...doing, ...todo].map((t) => ({
    task: {
      id: t.id,
      title: t.title,
      status: t.status,
      pageId: t._pageId,
      pageTitle: t._pageTitle,
    },
    reason:
      t.status === 'doing'
        ? '当前正在进行中'
        : '所有依赖已完成，可以开始',
  }));

  const summary =
    recommendations.length === 0
      ? '当前没有 ready 任务。所有任务要么已完成，要么还有未完成的依赖。'
      : `当前有 ${ready.length} 个 ready 任务。${recommendations[0] ? `推荐优先做「${recommendations[0].task.title}」${recommendations[0].task.status === 'doing' ? '（正在进行中）' : ''}。` : ''}`;

  return { recommendations: recommendations.slice(0, 20), summary };
}

// ── MCP Registration ──

export function registerDependencyTools(server: McpServer, c: typeof ClientType) {
  server.registerTool(
    'todograph_manage_dependencies',
    {
      title: 'Manage task dependencies',
      description:
        '批量添加或移除任务之间的依赖边。add 数组添加 from→to 依赖（from 完成后 to 才可执行），remove 数组移除已有依赖。服务端自动拒绝产生环的操作并返回具体原因。from/to 是任务 id（不是索引），需要先通过 get_page 获取。',
      inputSchema: {
        page_id: z.string().min(1).describe('页面 ID'),
        add: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
          .optional()
          .describe('要添加的依赖边'),
        remove: z
          .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
          .optional()
          .describe('要移除的依赖边'),
      },
    },
    async (params) => toolResult(() => handleManageDependencies(c, params)),
  );

  server.registerTool(
    'todograph_get_recommendations',
    {
      title: 'Get task recommendations',
      description:
        '获取"下一步该做什么"推荐。返回当前所有 ready 任务（所有依赖已完成）并标注优先级：进行中的任务优先，可按 page_id 筛选特定页面。不传 page_id 则跨所有页面推荐。',
      inputSchema: {
        page_id: z.string().min(1).optional().describe('页面 ID，不传则跨所有页推荐'),
      },
    },
    async (params) => toolResult(() => handleGetRecommendations(c, params)),
  );
}
