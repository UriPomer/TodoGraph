import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';

import { handleListPages, handleGetPage, handleCreatePage, handleMergePages } from '../src/tools/pages.js';
import { handleCreateTask, handleCreateTasks, handleUpdateTask } from '../src/tools/tasks.js';
import { handleManageDependencies, handleGetRecommendations } from '../src/tools/dependencies.js';
import { handleAutoLayout } from '../src/tools/layout.js';

// buildApp and client are imported dynamically in beforeAll after env vars are set,
// because both auth.ts (MCP_API_KEY/MCP_USER_ID) and client.ts (TODOGRAPH_API_BASE)
// read those env vars at module-load time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildApp: (opts: any) => Promise<FastifyInstance>;
let client: typeof import('../src/client.js').client;

describe('MCP tools integration', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `todograph-mcp-test-${Date.now()}`);

    // Set env vars BEFORE importing modules that capture them at load time
    process.env.MCP_API_KEY = 'test-key';
    process.env.MCP_USER_ID = 'u1';

    const serverMod = await import('../../../packages/server/src/app.js');
    buildApp = serverMod.buildApp;

    app = await buildApp({
      dataDir,
      registrationKey: 'test',
      sessionSecret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 5173;
    baseUrl = `http://127.0.0.1:${port}`;

    process.env.TODOGRAPH_API_BASE = baseUrl;
    process.env.TODOGRAPH_API_KEY = 'test-key';
    const clientMod = await import('../src/client.js');
    client = clientMod.client;
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  describe('pages', () => {
    it('list_pages returns seeded pages', async () => {
      const result = await handleListPages(client);
      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.pages[0]).toHaveProperty('id');
      expect(result.pages[0]).toHaveProperty('title');
      expect(result.pages[0]).toHaveProperty('taskCount');
    });

    it('create_page and get_page', async () => {
      const created = await handleCreatePage(client, { title: 'MCP测试页' });
      expect(created.page.title).toBe('MCP测试页');

      const page = await handleGetPage(client, { page_id: created.page.id });
      expect(page.page.title).toBe('MCP测试页');
      expect(page.tasks).toEqual([]);
      expect(page.edges).toEqual([]);
    });

    it('merge_pages moves all tasks and deletes source', async () => {
      const src = await handleCreatePage(client, { title: '源页' });
      const tgt = await handleCreatePage(client, { title: '目标页' });

      await handleCreateTask(client, { page_id: src.page.id, title: '任务A' });
      await handleCreateTask(client, { page_id: src.page.id, title: '任务B' });

      const result = await handleMergePages(client, {
        source_page_id: src.page.id,
        target_page_id: tgt.page.id,
      });

      expect(result.movedNodes).toBe(2);

      const tgtPage = await handleGetPage(client, { page_id: tgt.page.id });
      expect(tgtPage.tasks.length).toBe(2);
    });
  });

  describe('tasks', () => {
    let pageId: string;

    beforeEach(async () => {
      const created = await handleCreatePage(client, { title: `任务测试-${Date.now()}` });
      pageId = created.page.id;
    });

    it('create_task with depends_on', async () => {
      const a = await handleCreateTask(client, { page_id: pageId, title: 'A' });
      const b = await handleCreateTask(client, {
        page_id: pageId,
        title: 'B',
        depends_on: [a.task.id],
      });

      const page = await handleGetPage(client, { page_id: pageId });
      const edge = page.edges.find((e) => e.from === a.task.id && e.to === b.task.id);
      expect(edge).toBeDefined();
    });

    it('create_tasks batch with edges', async () => {
      const result = await handleCreateTasks(client, {
        page_id: pageId,
        tasks: [
          { title: '设计' },
          { title: '后端' },
          { title: '前端' },
          { title: '联调' },
        ],
        edges: [
          { from: 0, to: 1 },
          { from: 0, to: 2 },
          { from: 1, to: 3 },
          { from: 2, to: 3 },
        ],
      });

      expect(result.created.length).toBe(4);
      expect(result.edgesCreated).toBe(4);

      const page = await handleGetPage(client, { page_id: pageId });
      expect(page.tasks.length).toBe(4);
      expect(page.edges.length).toBe(4);
    });

    it('create_tasks rejects self-loop edges', async () => {
      const result = await handleCreateTasks(client, {
        page_id: pageId,
        tasks: [{ title: 'X' }, { title: 'Y' }],
        edges: [{ from: 0, to: 0 }],
      });

      expect(result.edgesCreated).toBe(0);
      expect(result.rejectedEdges?.length).toBe(1);
      expect(result.rejectedEdges?.[0].reason).toBe('self-loop');
    });

    it('create_tasks rejects cycle', async () => {
      await expect(
        handleCreateTasks(client, {
          page_id: pageId,
          tasks: [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }],
          edges: [
            { from: 0, to: 1 },
            { from: 1, to: 2 },
            { from: 2, to: 0 },
          ],
        }),
      ).rejects.toThrow('cycle');

      const page = await handleGetPage(client, { page_id: pageId });
      expect(page.tasks.length).toBe(0);
    });

    it('update_task changes fields', async () => {
      const t = await handleCreateTask(client, { page_id: pageId, title: '旧标题' });

      const updated = await handleUpdateTask(client, {
        page_id: pageId,
        task_id: t.task.id,
        title: '新标题',
        status: 'doing',
      });

      expect(updated.task.title).toBe('新标题');
      expect(updated.task.status).toBe('doing');
    });

    it('update_task throws on nonexistent task', async () => {
      await expect(
        handleUpdateTask(client, { page_id: pageId, task_id: 'nope', title: 'x' }),
      ).rejects.toThrow('task not found');
    });
  });

  describe('dependencies', () => {
    let pageId: string;
    let taskA: { id: string };
    let taskB: { id: string };
    let taskC: { id: string };

    beforeEach(async () => {
      const created = await handleCreatePage(client, { title: `依赖测试-${Date.now()}` });
      pageId = created.page.id;
      taskA = (await handleCreateTask(client, { page_id: pageId, title: 'A' })).task;
      taskB = (await handleCreateTask(client, { page_id: pageId, title: 'B' })).task;
      taskC = (await handleCreateTask(client, { page_id: pageId, title: 'C' })).task;
    });

    it('add and remove edges', async () => {
      const r1 = await handleManageDependencies(client, {
        page_id: pageId,
        add: [{ from: taskA.id, to: taskB.id }],
      });
      expect(r1.added).toBe(1);

      const page = await handleGetPage(client, { page_id: pageId });
      expect(page.edges).toHaveLength(1);

      const r2 = await handleManageDependencies(client, {
        page_id: pageId,
        remove: [{ from: taskA.id, to: taskB.id }],
      });
      expect(r2.removed).toBe(1);

      const page2 = await handleGetPage(client, { page_id: pageId });
      expect(page2.edges).toHaveLength(0);
    });

    it('rejects duplicate edge', async () => {
      await handleManageDependencies(client, {
        page_id: pageId,
        add: [{ from: taskA.id, to: taskB.id }],
      });
      const r2 = await handleManageDependencies(client, {
        page_id: pageId,
        add: [{ from: taskA.id, to: taskB.id }],
      });
      expect(r2.added).toBe(0);
      expect(r2.rejected?.[0].reason).toBe('duplicate');
    });

    it('rejects cycle via server', async () => {
      await handleManageDependencies(client, {
        page_id: pageId,
        add: [
          { from: taskA.id, to: taskB.id },
          { from: taskB.id, to: taskC.id },
        ],
      });

      await expect(
        handleManageDependencies(client, {
          page_id: pageId,
          add: [{ from: taskC.id, to: taskA.id }],
        }),
      ).rejects.toThrow('cycle');
    });
  });

  describe('recommendations', () => {
    it('returns recommendations with correct priority', async () => {
      const page = await handleCreatePage(client, { title: `推荐测试-${Date.now()}` });
      const pageId = page.page.id;

      const a = await handleCreateTask(client, { page_id: pageId, title: '已完成', status: 'done' });
      const b = await handleCreateTask(client, { page_id: pageId, title: '可开始' });
      const c = await handleCreateTask(client, { page_id: pageId, title: '进行中', status: 'doing' });

      await handleManageDependencies(client, {
        page_id: pageId,
        add: [
          { from: a.task.id, to: b.task.id },
          { from: a.task.id, to: c.task.id },
        ],
      });

      const result = await handleGetRecommendations(client, { page_id: pageId });
      expect(result.recommendations.length).toBe(2);
      expect(result.recommendations[0].task.id).toBe(c.task.id);
      expect(result.recommendations[0].task.status).toBe('doing');
      expect(result.summary).toContain('ready');
    });

    it('returns recommendations across all pages when no page_id', async () => {
      const result = await handleGetRecommendations(client, {});
      expect(Array.isArray(result.recommendations)).toBe(true);
      expect(typeof result.summary).toBe('string');
    });
  });

  describe('auto_layout', () => {
    it('returns positions for all tasks', async () => {
      const page = await handleCreatePage(client, { title: `布局测试-${Date.now()}` });
      const pageId = page.page.id;

      await handleCreateTask(client, { page_id: pageId, title: 'A' });
      await handleCreateTask(client, { page_id: pageId, title: 'B' });

      const result = await handleAutoLayout(client, { page_id: pageId });
      expect(result.positions.length).toBe(2);
      expect(result.positions[0]).toHaveProperty('task_id');
      expect(result.positions[0]).toHaveProperty('x');
      expect(result.positions[0]).toHaveProperty('y');
      expect(result.layoutInfo.direction).toBe('LR');
      expect(result.layoutInfo.nodesCount).toBe(2);
    });

    it('handles empty page', async () => {
      const page = await handleCreatePage(client, { title: `空页-${Date.now()}` });
      const result = await handleAutoLayout(client, { page_id: page.page.id });
      expect(result.positions).toEqual([]);
      expect(result.layoutInfo.nodesCount).toBe(0);
    });
  });
});
