import { expect, test, type Page } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium');
  await openIsolatedWorkspace(page, info);
  const meta = await (await page.request.get('/api/meta')).json();
  const current = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
  const result = await page.request.put(`/api/pages/${meta.activePageId}`, {
    data: {
      expectedVersion: current.version,
      nodes: ['a', 'b', 'c'].map((id, index) => ({
        id,
        title: `图任务 ${id}`,
        status: 'todo',
        x: index * 250,
        y: index * 100,
        width: 180,
      })),
      edges: [],
    },
  });
  expect(result.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(page.locator('.graph-viewport-restoring')).toHaveCount(0);
});

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
async function savedPage(page: Page) {
  const meta = await (await page.request.get('/api/meta')).json();
  return (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
}
async function selectPair(page: Page) {
  await node(page, 'a').getByTitle('双击编辑标题').click();
  await node(page, 'b')
    .getByTitle('双击编辑标题')
    .click({ modifiers: ['Control'] });
  await expect(node(page, 'a')).toHaveClass(/selected/);
  await expect(node(page, 'b')).toHaveClass(/selected/);
}

test('GEST-101/DROP-005 a multi-node drag commits one movement and one undo restores both nodes', async ({
  page,
}, info) => {
  await selectPair(page);
  await page.locator('.graph-surface').focus();
  await page.keyboard.press('Escape');
  await expect(node(page, 'a')).toHaveClass(/selected/);
  await expect(node(page, 'b')).toHaveClass(/selected/);
  const before = (await savedPage(page)).nodes;
  const box = (await node(page, 'a').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 86, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const after = (await savedPage(page)).nodes;
      return ['a', 'b'].every(
        (id) =>
          after.find((n: { id: string }) => n.id === id).y !==
          before.find((n: { id: string }) => n.id === id).y,
      );
    })
    .toBe(true);
  const moved = (await savedPage(page)).nodes;
  const movement = (id: string) => {
    const original = before.find((n: { id: string }) => n.id === id);
    const current = moved.find((n: { id: string }) => n.id === id);
    return { x: current.x - original.x, y: current.y - original.y };
  };
  expect(movement('a')).toEqual(movement('b'));
  expect(movement('c')).toEqual({ x: 0, y: 0 });
  expect(moved.some((n: { parentId?: string }) => n.parentId)).toBe(false);
  await page.getByTitle('撤销 (⌘Z)', { exact: true }).click();
  await expect
    .poll(async () => {
      const restored = (await savedPage(page)).nodes;
      return ['a', 'b'].every(
        (id) =>
          restored.find((n: { id: string }) => n.id === id).y ===
            before.find((n: { id: string }) => n.id === id).y &&
          restored.find((n: { id: string }) => n.id === id).x ===
            before.find((n: { id: string }) => n.id === id).x,
      );
    })
    .toBe(true);
  await info.attach('persisted-multi-drag', {
    body: JSON.stringify(await savedPage(page)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('graph-multi-drag-undo.png') });
});

test('GEST-101 graph grouping and automatic layout persist, and selected tasks move to a new page through the UI', async ({
  page,
}, info) => {
  await selectPair(page);
  await page.getByRole('button', { name: /归入新分组/ }).click();
  const dialog = page.getByText('分组名称', { exact: true }).locator('..');
  await dialog.locator('input').fill('图中的分组');
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect
    .poll(async () => {
      const data = await savedPage(page);
      const parent = data.nodes.find((n: { title: string }) => n.title === '图中的分组');
      return (
        parent && data.nodes.filter((n: { parentId?: string }) => n.parentId === parent.id).length
      );
    })
    .toBe(2);
  const beforeLayout = (await savedPage(page)).nodes;
  await page.getByRole('button', { name: '自动布局', exact: true }).click();
  await expect
    .poll(async () => {
      const after = (await savedPage(page)).nodes;
      return after.some((n: { id: string; x: number; y: number }) => {
        const original = beforeLayout.find((item: { id: string }) => item.id === n.id);
        return n.x !== original.x || n.y !== original.y;
      });
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const surface = (await page.locator('.graph-surface').boundingBox())!;
      const boxes = await Promise.all(['a', 'b', 'c'].map((id) => node(page, id).boundingBox()));
      return boxes.every(
        (box) =>
          box &&
          box.x >= surface.x &&
          box.y >= surface.y &&
          box.x + box.width <= surface.x + surface.width &&
          box.y + box.height <= surface.y + surface.height,
      );
    })
    .toBe(true);
  await page.keyboard.press('Escape');
  await node(page, 'c').getByTitle('双击编辑标题').click();
  await page.getByRole('button', { name: '移到页面', exact: true }).click();
  const moveDialog = page
    .locator('p')
    .filter({ hasText: /^移到页面$/ })
    .locator('..');
  await moveDialog.locator('input').fill(`图移动目标 ${Date.now()}`);
  await moveDialog.getByRole('button', { name: '确定', exact: true }).click();
  await expect
    .poll(async () => (await savedPage(page)).nodes.map((n: { id: string }) => n.id))
    .toEqual(['c']);
  await page.reload();
  await expect(node(page, 'c')).toBeVisible();
  await info.attach('persisted-graph-target', {
    body: JSON.stringify(await savedPage(page)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('graph-group-layout-move.png') });
});

test('GEST-101 keyboard creation and a connection dropped on blank space preserve dependency direction', async ({
  page,
}, info) => {
  await node(page, 'a').getByTitle('双击编辑标题').click();
  await page.keyboard.press('Enter');
  const input = page.getByPlaceholder('新任务标题…');
  await expect(input).toBeFocused();
  await input.fill('键盘新任务');
  await input.press('Enter');
  await expect.poll(async () => (await savedPage(page)).nodes.length).toBe(4);
  const source = (await node(page, 'c').locator('.react-flow__handle.source').boundingBox())!;
  const pane = (await page.locator('.graph-surface').boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 120, { steps: 8 });
  await page.mouse.up();
  await expect(input).toBeFocused();
  await input.fill('连线创建任务');
  await input.press('Enter');
  await expect
    .poll(async () => {
      const data = await savedPage(page);
      const created = data.nodes.find((n: { title: string }) => n.title === '连线创建任务');
      return Boolean(
        created &&
        data.edges.some(
          (edge: { from: string; to: string }) => edge.from === 'c' && edge.to === created.id,
        ),
      );
    })
    .toBe(true);
  await info.attach('persisted-graph-connection', {
    body: JSON.stringify(await savedPage(page)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('graph-create-connection.png') });
});
