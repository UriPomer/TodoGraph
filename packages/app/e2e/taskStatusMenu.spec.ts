import { expect, test, type Page } from '@playwright/test';
import { addTask, openIsolatedWorkspace } from './support';

test.beforeEach(async ({ page }, info) => { await openIsolatedWorkspace(page, info); });

async function savedStatus(page: Page, id: string) {
  const meta = await (await page.request.get('/api/meta')).json();
  const data = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
  return data.nodes.find((node: { id: string }) => node.id === id)?.status;
}

for (const surface of ['page-list', 'checklist', 'graph']) {
  test(`GEST-016 only doing opens a status menu; reset, undo and completion persist (${surface})`, async ({ page }, info) => {
    if (surface === 'checklist') {
      await page.getByRole('button', { name: '切换到清单模式' }).click();
      await expect(page.getByRole('button', { name: '切换到页面模式' })).toBeEnabled();
    }
    const added = await addTask(page, `状态回退 ${surface} ${Date.now()}`);
    const id = (await added.getAttribute('data-task-id'))!;
    if (surface === 'graph' && info.project.name !== 'desktop-chromium') await page.getByRole('button', { name: '依赖图', exact: true }).click();
    const row = surface === 'graph' ? page.locator(`.react-flow__node[data-id="${id}"]`) : page.locator(`[data-task-id="${id}"]`);
    const status = row.locator('[data-status]');
    await status.click();
    await expect(status).toHaveAttribute('data-status', 'doing');
    await expect(page.getByRole('menuitem', { name: '回到未开始', exact: true })).toHaveCount(0);
    await status.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await expect(status).toHaveAttribute('data-status', 'doing');
    expect(await menu.evaluate(el => getComputedStyle(el).backdropFilter)).toContain('blur');
    const reset = menu.getByRole('menuitem', { name: '回到未开始', exact: true });
    expect((await reset.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath('doing-status-menu.png'), animations: 'disabled' });
    await page.mouse.click(1, 1);
    await expect(menu).toHaveCount(0);
    await expect(status).toHaveAttribute('data-status', 'doing');
    await status.click();
    await expect(menu).toBeVisible();
    await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(status).toBeFocused();
    await status.click();
    await reset.click();
    await expect(status).toHaveAttribute('data-status', 'todo');
    await expect.poll(() => savedStatus(page, id)).toBe('todo');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(status).toHaveAttribute('data-status', 'doing');
    await expect.poll(() => savedStatus(page, id)).toBe('doing');
    await status.click();
    await reset.click();
    await expect.poll(() => savedStatus(page, id)).toBe('todo');
    await page.reload();
    if (surface === 'graph' && info.project.name !== 'desktop-chromium') await page.getByRole('button', { name: '依赖图', exact: true }).click();
    await expect(status).toHaveAttribute('data-status', 'todo');
    await status.click();
    await status.click();
    await menu.getByRole('menuitem', { name: '标记完成', exact: true }).click();
    await expect.poll(() => savedStatus(page, id)).toBe('done');
    if (surface !== 'graph') await page.getByRole('button', { name: '展开已完成任务' }).click();
    await expect(status).toHaveAttribute('data-status', 'done');
    await status.click();
    await expect(status).toHaveAttribute('data-status', 'todo');
    await expect(menu).toHaveCount(0);
    await expect.poll(() => savedStatus(page, id)).toBe('todo');
    await info.attach('persisted-status', { body: JSON.stringify({ id, status: await savedStatus(page, id) }), contentType: 'application/json' });
  });
}

test('GEST-016 a parent with unfinished children can reset but cannot complete from the menu', async ({ page }, info) => {
  const parent = await addTask(page, `父任务回退 ${Date.now()}`);
  const id = (await parent.getAttribute('data-task-id'))!;
  await parent.getByTitle('添加子任务').click();
  await parent.getByPlaceholder('输入子任务名称…').fill('尚未开始的子任务');
  await parent.getByPlaceholder('输入子任务名称…').press('Enter');
  const status = parent.locator('[data-status]').first();
  await status.click();
  await status.click();
  await page.getByRole('menuitem', { name: '标记完成', exact: true }).click();
  await expect(page.getByText('无法完成', { exact: true })).toBeVisible();
  await expect(status).toHaveAttribute('data-status', 'doing');
  await status.click();
  await page.getByRole('menuitem', { name: '回到未开始', exact: true }).click();
  await expect(status).toHaveAttribute('data-status', 'todo');
  await expect.poll(() => savedStatus(page, id)).toBe('todo');
  await page.screenshot({ path: info.outputPath('parent-reset.png') });
});

test('GEST-016 group detail status menu closes without closing the dialog and persists reset', async ({ page }, info) => {
  const meta = await (await page.request.get('/api/meta')).json();
  const original = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
  const result = await page.request.put(`/api/pages/${meta.activePageId}`, { data: {
    expectedVersion: original.version, edges: [], nodes: [
      { id: 'group', title: '任务组状态回退', status: 'doing', x: 0, y: 0 },
      ...Array.from({ length: 11 }, (_, i) => ({ id: `child-${i}`, title: `任务组子任务 ${i}`, status: i === 0 ? 'doing' : 'todo', parentId: 'group', x: 24 + i % 2 * 200, y: 60 + Math.floor(i / 2) * 70 })),
    ],
  } });
  expect(result.ok()).toBe(true);
  await page.reload();
  if (info.project.name !== 'desktop-chromium') await page.getByRole('button', { name: '依赖图', exact: true }).click();
  await page.getByRole('button', { name: '展开全部 11 个节点' }).first().click();
  const dialog = page.getByRole('dialog');
  const child = dialog.locator('article').filter({ has: page.getByRole('heading', { name: '任务组子任务 0', exact: true }) });
  const status = child.locator('[data-status]');
  expect((await status.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await status.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menu').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(status).toBeFocused();
  await status.click();
  await page.getByRole('menuitem', { name: '回到未开始', exact: true }).click();
  await expect(status).toHaveAttribute('data-status', 'todo');
  await expect(dialog).toBeVisible();
  await expect.poll(() => savedStatus(page, 'child-0')).toBe('todo');
  await page.screenshot({ path: info.outputPath('group-detail-reset.png') });
});
