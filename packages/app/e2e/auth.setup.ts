import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHILD_DEFAULT_H,
  CHILD_DEFAULT_W,
  GROUP_PADDING_X,
  GROUP_PADDING_Y,
  computeGroupSize,
  type Edge,
  type Meta,
  type PageData,
  type PageInfo,
  type Task,
  type TaskStatus,
} from '@todograph/shared';
import { expect, type Page, test as setup } from '@playwright/test';
import { E2E_SANDBOX_TITLE } from './support';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.resolve(appRoot, '../test-results/.auth/user.json');

interface SeedTask {
  key: string;
  title: string;
  status?: TaskStatus;
  description?: string;
  children?: SeedTask[];
}

interface SeedPage {
  title: string;
  prefix: string;
  roots: SeedTask[];
  dependencies: Array<[string, string]>;
}

const PROJECT_OVERVIEW: SeedPage = {
  title: '项目总览',
  prefix: 'overview',
  roots: [
    {
      key: 'planning', title: '产品规划', status: 'doing', description: '目标、范围与交付节奏。', children: [
        { key: 'research', title: '用户调研', status: 'doing', children: [
          { key: 'interviews', title: '访谈记录', status: 'done' },
          { key: 'personas', title: '用户画像', status: 'doing' },
        ] },
        { key: 'scope', title: '范围基线', children: [
          { key: 'in-scope', title: '本期范围' },
          { key: 'deferred', title: '后续迭代' },
        ] },
        { key: 'milestones', title: '里程碑安排' },
      ],
    },
    {
      key: 'client', title: '客户端实施', status: 'doing', children: [
        { key: 'ios', title: 'iOS 端', status: 'doing', children: [
          { key: 'ios-ui', title: '任务列表交互', status: 'done' },
          { key: 'ios-insets', title: '系统安全区' },
        ] },
        { key: 'android', title: 'Android 端', status: 'doing', children: [
          { key: 'android-auth', title: '会话恢复' },
          { key: 'android-keyboard', title: '键盘避让' },
        ] },
        { key: 'desktop', title: '桌面端适配' },
      ],
    },
    {
      key: 'quality', title: '质量保障', children: [
        { key: 'automation', title: '自动化回归', status: 'doing', children: [
          { key: 'list-flow', title: '列表主流程' },
          { key: 'save-flow', title: '保存与恢复' },
        ] },
        { key: 'accessibility', title: '键盘与无障碍' },
        { key: 'devices', title: '设备回归' },
      ],
    },
  ],
  dependencies: [
    ['interviews', 'personas'],
    ['in-scope', 'ios-ui'],
    ['ios-insets', 'list-flow'],
    ['android-auth', 'save-flow'],
  ],
};

const CLIENT_REFACTOR: SeedPage = {
  title: '客户端重构',
  prefix: 'client',
  roots: [
    {
      key: 'data', title: '数据层', status: 'doing', children: [
        { key: 'api', title: '任务 API', status: 'doing', children: [
          { key: 'version', title: '版本冲突处理', status: 'done' },
          { key: 'drafts', title: '草稿恢复' },
        ] },
        { key: 'cache', title: '页面缓存', status: 'doing', children: [
          { key: 'cache-restore', title: '即时还原', status: 'done' },
          { key: 'cache-expiry', title: '会话清理' },
        ] },
        { key: 'errors', title: '错误反馈' },
      ],
    },
    {
      key: 'gestures', title: '移动端交互', status: 'doing', children: [
        { key: 'list', title: '列表手势', status: 'doing', children: [
          { key: 'long-press', title: '长按排序' },
          { key: 'swipe', title: '左右滑动撤销' },
        ] },
        { key: 'description', title: '描述编辑', children: [
          { key: 'description-edit', title: '阅读与编辑' },
          { key: 'description-clear', title: '清空与取消' },
        ] },
        { key: 'theme', title: '主题适配', status: 'done' },
      ],
    },
    {
      key: 'desktop', title: '桌面体验', children: [
        { key: 'selection', title: '文本选择与编辑', status: 'doing' },
        { key: 'keyboard', title: '键盘导航' },
        { key: 'window', title: '窗口状态保存', status: 'done' },
      ],
    },
  ],
  dependencies: [
    ['version', 'drafts'],
    ['long-press', 'swipe'],
    ['description-edit', 'description-clear'],
  ],
};

const RELEASE_CHECKLIST: SeedPage = {
  title: '上线准备',
  prefix: 'release',
  roots: [
    {
      key: 'acceptance', title: '发布验收', status: 'doing', children: [
        { key: 'automation', title: '自动化回归', status: 'doing', children: [
          { key: 'desktop-flow', title: '桌面流程' },
          { key: 'mobile-flow', title: '移动流程' },
        ] },
        { key: 'manual', title: '人工抽查' },
        { key: 'failure', title: '故障注入' },
      ],
    },
    {
      key: 'deployment', title: '构建与部署', children: [
        { key: 'artifact', title: '构建产物核对', status: 'done' },
        { key: 'migration', title: '数据迁移检查' },
        { key: 'release-notes', title: '版本说明' },
      ],
    },
    {
      key: 'operations', title: '上线保障', status: 'doing', children: [
        { key: 'monitoring', title: '监控与告警' },
        { key: 'rollback', title: '回滚预案', status: 'doing', children: [
          { key: 'data-restore', title: '数据恢复步骤' },
          { key: 'version-rollback', title: '版本回退步骤' },
        ] },
        { key: 'ownership', title: '值班联系人' },
      ],
    },
  ],
  dependencies: [
    ['desktop-flow', 'manual'],
    ['migration', 'artifact'],
    ['monitoring', 'ownership'],
    ['data-restore', 'version-rollback'],
  ],
};

const HIERARCHY_LIST: SeedPage = {
  title: '清单',
  prefix: 'list',
  roots: [
    {
      key: 'experience', title: '产品体验改进', status: 'doing', children: [
        { key: 'task-flow', title: '任务流程', status: 'doing', children: [
          { key: 'long-press', title: '长按排序', status: 'done' },
          { key: 'undo', title: '滑动撤销' },
        ] },
        { key: 'navigation', title: '页面导航' },
        { key: 'view-restore', title: '视图恢复', status: 'done' },
      ],
    },
    {
      key: 'engineering', title: '研发协作', children: [
        { key: 'contracts', title: '接口契约', status: 'doing', children: [
          { key: 'conflicts', title: '冲突处理' },
          { key: 'recovery', title: '错误恢复' },
        ] },
        { key: 'review', title: '代码审查' },
        { key: 'docs', title: '发布文档' },
      ],
    },
    {
      key: 'personal', title: '个人效率', children: [
        { key: 'today', title: '今日清单' },
        { key: 'planning', title: '项目规划' },
        { key: 'archive', title: '归档整理', status: 'done' },
      ],
    },
  ],
  dependencies: [],
};

function measureTree(node: SeedTask): { w: number; h: number } {
  if (!node.children?.length) return { w: CHILD_DEFAULT_W, h: CHILD_DEFAULT_H };
  let x = GROUP_PADDING_X;
  const children = node.children.map((child) => {
    const size = measureTree(child);
    const position = { x, y: GROUP_PADDING_Y, ...size };
    x += size.w + 48;
    return position;
  });
  return computeGroupSize(children);
}

function flattenSeedPage(prefix: string, roots: SeedTask[]): Task[] {
  const nodes: Task[] = [];
  const append = (seed: SeedTask, parentId: string | undefined, x: number, y: number) => {
    const id = `${prefix}-${seed.key}`;
    nodes.push({
      id,
      title: seed.title,
      status: seed.status ?? 'todo',
      x,
      y,
      ...(parentId ? { parentId } : {}),
      ...(seed.description ? { description: seed.description } : {}),
    });
    let childX = GROUP_PADDING_X;
    for (const child of seed.children ?? []) {
      append(child, id, childX, GROUP_PADDING_Y);
      childX += measureTree(child).w + 48;
    }
  };

  let rootY = 0;
  for (const root of roots) {
    append(root, undefined, 0, rootY);
    rootY += measureTree(root).h + 120;
  }
  return nodes;
}

function seedPageData(seed: SeedPage): PageData {
  const edges: Edge[] = seed.dependencies.map(([from, to]) => ({
    from: `${seed.prefix}-${from}`,
    to: `${seed.prefix}-${to}`,
  }));
  return { nodes: flattenSeedPage(seed.prefix, seed.roots), edges };
}

async function readMeta(page: Page): Promise<Meta> {
  const response = await page.request.get('/api/meta');
  expect(response.ok(), `load workspace meta returned ${response.status()}`).toBeTruthy();
  return await response.json() as Meta;
}

async function readPage(page: Page, pageId: string): Promise<PageData> {
  const response = await page.request.get(`/api/pages/${pageId}`);
  expect(response.ok(), `load fixture page ${pageId} returned ${response.status()}`).toBeTruthy();
  return await response.json() as PageData;
}

async function saveSeedPage(page: Page, pageId: string, seed: SeedPage): Promise<void> {
  const current = await readPage(page, pageId);
  const response = await page.request.put(`/api/pages/${pageId}`, {
    data: { ...seedPageData(seed), expectedVersion: current.version ?? 0 },
  });
  expect(response.ok(), `seed page ${seed.title} returned ${response.status()}`).toBeTruthy();
}

async function createPage(page: Page, meta: Meta, title: string): Promise<{ page: PageInfo; meta: Meta }> {
  const response = await page.request.post('/api/pages', {
    data: { title, expectedRevision: meta.revision },
  });
  expect(response.ok(), `create page ${title} returned ${response.status()}`).toBeTruthy();
  return await response.json() as { page: PageInfo; meta: Meta };
}

async function seedWorkspace(page: Page): Promise<void> {
  let meta = await readMeta(page);
  const overview = meta.pages.find((entry) => entry.kind !== 'hierarchy');
  const hierarchy = meta.pages.find((entry) => entry.kind === 'hierarchy');
  expect(overview).toBeTruthy();
  expect(hierarchy).toBeTruthy();

  const rename = await page.request.patch(`/api/pages/${overview!.id}`, {
    data: { title: PROJECT_OVERVIEW.title, expectedRevision: meta.revision },
  });
  expect(rename.ok(), `rename overview page returned ${rename.status()}`).toBeTruthy();
  meta = (await rename.json() as { meta: Meta }).meta;
  await saveSeedPage(page, overview!.id, PROJECT_OVERVIEW);
  await saveSeedPage(page, hierarchy!.id, HIERARCHY_LIST);

  const createdPages: Array<{ page: PageInfo; meta: Meta; seed?: SeedPage }> = [];
  for (const seed of [CLIENT_REFACTOR, RELEASE_CHECKLIST]) {
    const created = await createPage(page, meta, seed.title);
    meta = created.meta;
    createdPages.push({ ...created, seed });
    await saveSeedPage(page, created.page.id, seed);
  }
  const sandbox = await createPage(page, meta, E2E_SANDBOX_TITLE);
  meta = sandbox.meta;

  const activate = await page.request.patch(`/api/pages/${sandbox.page.id}`, {
    data: { activate: true, expectedRevision: meta.revision },
  });
  expect(activate.ok(), `activate E2E sandbox returned ${activate.status()}`).toBeTruthy();
  meta = (await activate.json() as { meta: Meta }).meta;
  expect(meta.pages.map((entry) => entry.title)).toEqual(expect.arrayContaining([
    '清单', PROJECT_OVERVIEW.title, CLIENT_REFACTOR.title, RELEASE_CHECKLIST.title, E2E_SANDBOX_TITLE,
  ]));

  const pageData = await Promise.all([
    readPage(page, overview!.id),
    readPage(page, hierarchy!.id),
    ...createdPages.map(({ page: info }) => readPage(page, info.id)),
  ]);
  expect(pageData.reduce((count, data) => count + data.nodes.length, 0)).toBeGreaterThanOrEqual(60);
  expect(pageData[0]!.edges.length).toBeGreaterThanOrEqual(4);
  const overviewNodes = new Map(pageData[0]!.nodes.map((node) => [node.id, node]));
  expect(overviewNodes.get('overview-personas')?.parentId).toBe('overview-research');
  expect(overviewNodes.get('overview-research')?.parentId).toBe('overview-planning');
  expect(pageData[1]!.nodes.find((node) => node.id === 'list-undo')?.parentId).toBe('list-task-flow');

  await page.goto('/');
  for (const title of [PROJECT_OVERVIEW.title, CLIENT_REFACTOR.title, RELEASE_CHECKLIST.title, E2E_SANDBOX_TITLE]) {
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  }
}

setup('register E2E user with multi-page, nested task data', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '注册' }).click();
  await page.locator('input[autocomplete="username"]').fill('e2e-test-user');
  await page.locator('input[autocomplete="new-password"]').fill('Gesture1234');
  await page.getByPlaceholder('如不需要则留空').fill('todograph-e2e');
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  // Keep the mounted workspace's autosave out of API fixture writes.
  await page.close();
  await seedWorkspace(await context.newPage());
  await mkdir(path.dirname(authFile), { recursive: true });
  await context.storageState({ path: authFile });
});
