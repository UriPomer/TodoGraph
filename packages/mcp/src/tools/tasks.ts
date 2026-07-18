import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskStatus } from '@todograph/shared';
import type { client as ClientType } from '../client.js';
import { textResult } from './result.js';

function runCommand<T>(c: typeof ClientType, pageId: string, command: unknown): Promise<T> {
  return c.post<T>(`/api/pages/${encodeURIComponent(pageId)}/commands`, command);
}

export async function handleDeleteTasks(
  c: typeof ClientType,
  params: {
    page_id: string;
    task_ids: string[];
  },
) {
  return runCommand<{ removed: number; removedIds?: string[]; warning?: string }>(
    c,
    params.page_id,
    { type: 'delete_tasks', taskIds: params.task_ids },
  );
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
  return runCommand<{
    task: { id: string; title: string; status: TaskStatus; x?: number; y?: number };
    rejectedDependencies?: string[];
  }>(c, params.page_id, {
    type: 'create_task',
    title: params.title,
    status: params.status,
    description: params.description,
    dependsOn: params.depends_on,
  });
}

export async function handleCreateTasks(
  c: typeof ClientType,
  params: {
    page_id: string;
    tasks: Array<{ title: string; status?: TaskStatus; description?: string }>;
    edges?: Array<{ from: number; to: number }>;
  },
) {
  return runCommand<{
    created: Array<{ id: string; title: string; status: TaskStatus; x?: number; y?: number }>;
    edgesCreated: number;
    rejectedEdges?: Array<{ from: number; to: number; reason: string }>;
  }>(c, params.page_id, { type: 'create_tasks', tasks: params.tasks, edges: params.edges });
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
  return runCommand<{ task: { id: string; title?: string; status?: TaskStatus; x?: number; y?: number } }>(
    c,
    params.page_id,
    {
      type: 'update_task',
      taskId: params.task_id,
      title: params.title,
      status: params.status,
      description: params.description,
      x: params.x,
      y: params.y,
    },
  );
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
