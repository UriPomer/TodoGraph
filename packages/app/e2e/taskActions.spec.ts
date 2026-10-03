import { expect, test, type Locator, type Page } from '@playwright/test';
import { addTask, openIsolatedWorkspace } from './support';

test.beforeEach(async ({ page }, info) => { await openIsolatedWorkspace(page, info); });

async function swipe(page: Page, row: Locator, dx: number, cancel = false) {
  const title = row.locator('[data-task-title]');
  await title.click({ trial: true });
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + Math.min(24, box!.width / 2);
  const y = box!.y + box!.height / 2;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx / 2, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

async function pageData(page: Page) {
  const meta = await (await page.request.get('/api/meta')).json() as { activePageId: string };
  return await (await page.request.get(`/api/pages/${meta.activePageId}`)).json() as {
    version: number; nodes: Array<{ id: string; status: string; title: string }>;
  };
}

for (const mode of ['page', 'checklist']) test(`GEST-015 right swipe advances todo to doing to done, undo restores one step, and done stays done (${mode})`, async ({ page }, info) => {
  test.skip(info.project.name !== 'android-chromium', 'Moving touch uses Chromium CDP; no synthetic swipe substitute');
  if (mode === 'checklist') {
    await page.getByRole('button', { name: '切换到清单模式' }).click();
    await expect(page.getByRole('button', { name: '切换到页面模式' })).toBeEnabled();
  }
  const added = await addTask(page, `右滑逐步推进 ${Date.now()}`);
  const id = await added.getAttribute('data-task-id');
  const row = page.locator(`[data-task-id="${id}"]`);
  const status = row.locator('[data-status]');
  await expect(status).toHaveAttribute('data-status', 'todo');
  await swipe(page, row, 96);
  await expect(status).toHaveAttribute('data-status', 'doing');
  await expect(page.getByText('已开始', { exact: true })).toBeVisible();
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('doing');
  await page.screenshot({ path: info.outputPath('right-swipe-start.png') });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(status).toHaveAttribute('data-status', 'todo');
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('todo');
  await swipe(page, row, 96);
  await expect(status).toHaveAttribute('data-status', 'doing');

  await swipe(page, row, 96);
  await expect(page.getByText('已完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(1);
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('done');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(status).toHaveAttribute('data-status', 'doing');
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('doing');
  await swipe(page, row, 96);
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('done');
  const expandDone = page.getByRole('button', { name: '展开已完成任务' });
  if (await expandDone.isVisible()) await expandDone.click();
  await expect(status).toHaveAttribute('data-status', 'done');
  const version = (await pageData(page)).version;
  await swipe(page, row, 96);
  await expect(status).toHaveAttribute('data-status', 'done');
  // Observe beyond the 250ms autosave delay: a completed task must not mutate again.
  await page.waitForTimeout(400);
  expect((await pageData(page)).version).toBe(version);
  await page.reload();
  await expect(expandDone).toBeVisible();
  await expandDone.click();
  await expect(status).toHaveAttribute('data-status', 'done');
  await info.attach('persisted-page', { body: JSON.stringify(await pageData(page)), contentType: 'application/json' });
});

test('GEST-008/GEST-015 cancelled and short swipes do nothing, left swipe deletes and undo restores', async ({ page }, info) => {
  test.skip(info.project.name !== 'android-chromium');
  const added = await addTask(page, `手势取消与删除 ${Date.now()}`);
  const id = await added.getAttribute('data-task-id');
  const row = page.locator(`[data-task-id="${id}"]`);
  await expect.poll(async () => (await pageData(page)).nodes.some(node => node.id === id)).toBe(true);
  const version = (await pageData(page)).version;
  for (const dx of [48, -48, 96, -96]) {
    await swipe(page, row, dx, Math.abs(dx) === 96);
    await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'todo');
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
  }
  await page.waitForTimeout(400);
  expect((await pageData(page)).version).toBe(version);
  await swipe(page, row, -96);
  await expect(row).toHaveCount(0);
  await expect(page.getByText('已删除', { exact: true })).toBeVisible();
  await expect.poll(async () => (await pageData(page)).nodes.some(node => node.id === id)).toBe(false);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(row.locator('[data-status]')).toHaveAttribute('data-status', 'todo');
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('todo');
  await page.screenshot({ path: info.outputPath('swipe-delete-restored.png') });
});

test('GEST-015 right swipe cannot complete a parent with unfinished children', async ({ page }, info) => {
  test.skip(info.project.name !== 'android-chromium');
  const parent = await addTask(page, `父任务右滑保护 ${Date.now()}`);
  const id = await parent.getAttribute('data-task-id');
  await parent.getByTitle('添加子任务').click();
  await parent.getByPlaceholder('输入子任务名称…').fill('仍未完成的子任务');
  await parent.getByPlaceholder('输入子任务名称…').press('Enter');
  await swipe(page, parent, 96);
  await expect(parent.locator('[data-status]').first()).toHaveAttribute('data-status', 'doing');
  await swipe(page, parent, 96);
  await expect(page.getByText('无法完成', { exact: true })).toBeVisible();
  await expect(parent.locator('[data-status]').first()).toHaveAttribute('data-status', 'doing');
  await expect.poll(async () => (await pageData(page)).nodes.find(node => node.id === id)?.status).toBe('doing');
  await page.screenshot({ path: info.outputPath('parent-completion-blocked.png') });
});

test('GEST-009 undo is a compact frosted capsule, clears mobile navigation in portrait and landscape, and stays usable', async ({ page }, info) => {
  test.setTimeout(60_000);
  const mobile = info.project.name !== 'desktop-chromium';
  const viewports = mobile ? [{ width: 390, height: 844 }, { width: 667, height: 375 }] : [{ width: 1280, height: 800 }];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const theme of ['glass-dark', 'glass-light']) {
      await page.locator('html').evaluate((element, theme) => element.setAttribute('data-theme', theme), theme);
      const row = await addTask(page, `检查撤销胶囊长标题的截断与可读性 ${theme} ${viewport.width} ${Date.now()}`);
      const status = row.locator('[data-status]');
      await status.click();
      await status.click();
      const undo = page.getByRole('button', { name: '撤销', exact: true });
      await expect(undo).toHaveCount(1);
      const toast = undo.locator('xpath=ancestor::li[1]');
      await expect(toast).toBeVisible();
      await toast.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      const box = (await toast.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(360);
      expect(box.height).toBeLessThanOrEqual(76);
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16);
      const glass = await toast.evaluate(el => {
        const css = getComputedStyle(el);
        return { background: css.backgroundColor, blur: css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter') };
      });
      expect(glass.blur).toContain('blur(');
      expect(glass.background).toMatch(/^rgba\(/);
      const alpha = Number(glass.background.split(',').at(-1)!.replace(')', ''));
      expect(alpha).toBeLessThanOrEqual(0.85);
      expect(alpha).toBeGreaterThanOrEqual(0.45);
      const buttonBox = (await undo.boundingBox())!;
      expect(buttonBox.height).toBeGreaterThanOrEqual(40);
      if (mobile) {
        const nav = (await page.locator('nav[data-mobile-chrome]').boundingBox())!;
        expect(nav.y - box.y - box.height).toBeGreaterThanOrEqual(12);
        expect(nav.y - box.y - box.height).toBeLessThanOrEqual(32);
        expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
      }
      await page.screenshot({ path: info.outputPath(`undo-${theme}-${viewport.width}.png`), animations: 'disabled' });
      await undo.click();
      await expect(status).toHaveAttribute('data-status', 'doing');
      await expect(undo).toHaveCount(0);
    }
  }
});
