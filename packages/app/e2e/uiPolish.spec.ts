import { expect, test, type Page } from '@playwright/test';
import { addTask, openIsolatedWorkspace, taskRow } from './support';

async function assertHierarchyAlignment(page: Page, maxExpanderX: number, screenshotPath: string) {
  const suffix = Date.now();
  const parentTitle = `层级对齐父任务 ${suffix}`;
  const childTitle = `层级对齐子任务 ${suffix}`;
  const leafTitle = `层级对齐同级任务 ${suffix}`;
  const parent = await addTask(page, parentTitle);
  await parent.getByTitle('添加子任务').click();
  await page.getByPlaceholder('输入子任务名称…').fill(childTitle);
  await page.getByPlaceholder('输入子任务名称…').press('Enter');
  const child = taskRow(page, childTitle);
  await expect(child).toBeVisible();
  const leaf = await addTask(page, leafTitle);

  const parentStatus = await parent.locator('button[title^="点击切换状态"]').boundingBox();
  const leafStatus = await leaf.locator('button[title^="点击切换状态"]').boundingBox();
  const childStatus = await child.locator('button[title^="点击切换状态"]').boundingBox();
  const expander = await parent.locator('button[title="折叠"]').boundingBox();
  expect(parentStatus).not.toBeNull();
  expect(leafStatus).not.toBeNull();
  expect(childStatus).not.toBeNull();
  expect(expander).not.toBeNull();
  expect(Math.abs(parentStatus!.x - leafStatus!.x)).toBeLessThan(0.5);
  expect(childStatus!.x - leafStatus!.x).toBeCloseTo(16, 0);
  expect(expander!.x).toBeLessThan(maxExpanderX);
  await child.getByTitle('添加子任务').click();
  const childInput = page.getByPlaceholder('输入子任务名称…');
  const inputBox = await childInput.boundingBox();
  const grandchildTitle = `层级对齐孙任务 ${suffix}`;
  await childInput.fill(grandchildTitle);
  await childInput.press('Enter');
  const grandchildTitleBox = await taskRow(page, grandchildTitle).locator('[data-task-title-slot]').boundingBox();
  expect(Math.abs(inputBox!.x - grandchildTitleBox!.x), 'new-child input aligns with its resulting title').toBeLessThan(0.5);
  await leaf.getByTitle('添加描述').click();
  const descriptionBox = await leaf.locator('textarea').boundingBox();
  const titleBox = await leaf.locator('[data-task-title-slot]').boundingBox();
  expect(Math.abs(descriptionBox!.x - titleBox!.x), 'description starts at the title column').toBeLessThan(0.5);
  await leaf.locator('textarea').fill('对齐回归描述');
  await leaf.locator('textarea').press('Escape');
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

test.beforeEach(async ({ page }, testInfo) => {
  const desktopCase = testInfo.title.startsWith('desktop');
  if (desktopCase && testInfo.project.name !== 'desktop-chromium') test.skip();
  const androidCase = testInfo.title.startsWith('Android');
  if (androidCase && testInfo.project.name !== 'android-chromium') test.skip();
  const mobileCase = testInfo.title.startsWith('mobile') || androidCase;
  if (mobileCase && testInfo.project.name === 'desktop-chromium') test.skip();
  await openIsolatedWorkspace(page, testInfo);
});

test('task long titles stay fully readable without clipping', async ({ page }, testInfo) => {
  const title = `长标题完整阅读 ${'复杂任务与父子层级 '.repeat(8)} ${'VeryLongUnbrokenText'.repeat(4)}`;
  const row = await addTask(page, title);
  const text = row.locator('[data-task-title]');
  await expect(text).toHaveCSS('white-space', 'normal');
  await expect(text).toHaveCSS('overflow-wrap', 'anywhere');
  const geometry = await text.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, scrollHeight: element.scrollHeight, width: rect.width,
      scrollWidth: element.scrollWidth, right: rect.right, viewport: window.innerWidth };
  });
  expect(geometry.height).toBeGreaterThan(32);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  await page.screenshot({ path: testInfo.outputPath('readable-long-title.png'), fullPage: true });
});

test('task rows align actions with and without dependencies', async ({ page }, testInfo) => {
  const meta = await (await page.request.get('/api/meta')).json();
  const pageId = meta.pages.find((entry: { title: string }) => entry.title === 'E2E 测试沙箱').id;
  const data = await (await page.request.get(`/api/pages/${pageId}`)).json();
  const saved = await page.request.put(`/api/pages/${pageId}`, { data: {
    nodes: [{ id: 'source', title: '独立前置任务', status: 'todo', x: 0, y: 0 }, { id: 'blocked', title: '依赖中的任务', status: 'todo', x: 400, y: 0 }],
    edges: [{ from: 'source', to: 'blocked' }], expectedVersion: data.version,
  } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  const blocked = taskRow(page, '依赖中的任务');
  await expect(blocked.locator('span[title^="还有 1 个前置"]')).toBeVisible();
  await expect.poll(() => page.locator('[data-task-action="description"]').evaluateAll((buttons) =>
    Math.abs(buttons[0]!.getBoundingClientRect().x - buttons[1]!.getBoundingClientRect().x),
  ), { message: 'optional dependency count must not shift actions' }).toBeLessThan(0.5);
  await page.screenshot({ path: testInfo.outputPath('task-row-dependency-alignment.png'), fullPage: true });
});

test('desktop hovering a task preserves the frosted background without a spotlight', async ({ page }, testInfo) => {
  const row = page.locator('[data-task-id]').first();
  await row.hover();
  await expect(page.locator('.bg-matte')).toHaveCSS('mask-image', 'none');
  await page.screenshot({ path: testInfo.outputPath('desktop-frosted-hover.png'), fullPage: true });
  await page.mouse.move(1, 1);
  await expect(page.locator('.bg-matte')).toHaveCSS('mask-image', 'none');
});

test('desktop clicks stay still, dragged text selects, and another click clears it', async ({ page }, testInfo) => {
  const titleText = `桌面拖选回归 ${Date.now()}`;
  const input = page.locator('input[placeholder^="新任务"]');
  await input.fill(titleText);
  await input.press('Enter');
  const row = page.locator('[data-task-id]').filter({
    has: page.locator('[data-task-title]', { hasText: titleText }),
  });
  await expect(row).toHaveCount(1);
  const taskId = await row.getAttribute('data-task-id');
  expect(taskId).toBeTruthy();
  const stableRow = page.locator(`[data-task-id="${taskId}"]`);
  const surface = stableRow.locator('[data-task-drag-surface]');
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();

  const startX = surfaceBox!.x + 2;
  const y = surfaceBox!.y + surfaceBox!.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + 10, y + 1);
  await page.mouse.up();
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);

  const title = stableRow.locator('[data-task-title]');
  const titleBox = await title.boundingBox();
  expect(titleBox).not.toBeNull();
  const titleY = titleBox!.y + titleBox!.height / 2;
  await page.mouse.move(titleBox!.x + 2, titleY);
  await page.mouse.down();
  await page.mouse.move(titleBox!.x + Math.min(36, titleBox!.width - 1), titleY);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');

  await page.locator('[data-mobile-task-section="ready"] h3').click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await title.dblclick();
  await expect(stableRow.locator('input')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await page.screenshot({ path: testInfo.outputPath('desktop-task-edit.png'), fullPage: true });
  await assertHierarchyAlignment(page, 26, testInfo.outputPath('desktop-task-hierarchy-alignment.png'));
});

test('desktop NAV-001/NAV-002/NAV-003 page mode always shows both list and graph, checklist shows only list', async ({ page }, testInfo) => {
  for (const width of [1440, 880, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.split-pane-left')).toBeVisible();
    await expect(page.locator('.react-flow')).toBeVisible();
    await expect(page.locator('[data-desktop-header]')).toBeVisible();
    await expect(page.locator('nav[data-mobile-chrome]')).toBeHidden();
    await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '依赖图视图', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '切换到清单模式' }).click();
    await expect(page.locator('.react-flow')).toHaveCount(0);
    await expect(page.locator('[data-mobile-task-section="ready"]')).toBeVisible();
    await page.getByRole('button', { name: '切换到页面模式' }).click();
    await expect(page.locator('.split-pane-left')).toBeVisible();
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`desktop-page-dual-view-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => localStorage.setItem('todograph.splitLeftWidth', '720'));
  await page.reload();
  await expect(page.locator('.split-pane-left')).toBeVisible();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect.poll(async () => (await page.locator('.react-flow').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(279);
  await page.getByRole('button', { name: '项目总览', exact: true }).click();
  await expect(page.locator('.split-pane-left')).toBeVisible();
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.setViewportSize({ width: 393, height: 852 });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.locator('main[data-mobile-tab="more"]')).toBeVisible();
  await page.setViewportSize({ width: 880, height: 900 });
  await expect(page.locator('[data-desktop-header]')).toBeVisible();
  await expect(page.locator('.split-pane-left')).toBeVisible();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(page.locator('[data-mobile-more-header]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('desktop-after-mobile-more.png'), fullPage: true });
});

test('mobile themes preserve the background, list spacing, swipe affordance, and top chrome', async ({ page }, testInfo) => {
  const titleText = `移动端超长任务标题用于检查滑动边界 ${'长标题'.repeat(8)} ${Date.now()}`;
  await addTask(page, titleText);

  const listSurface = page.locator('.mobile-list-glass');
  const workspaceSurface = page.locator('.mobile-workspace-shell');
  for (const [theme, label] of [['glass-dark', '玻璃·深色'], ['glass-light', '玻璃·浅色'], ['default-light', '经典·浅色'], ['muted-warm', '暖素'], ['muted-cool', '冷素']]) {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.locator('[data-mobile-more-header]').getByTitle('切换主题').click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    await expect(workspaceSurface).toHaveCSS('background-image', 'none');
    const background = await workspaceSurface.evaluate((element) => getComputedStyle(element).backgroundColor);
    const color = background.match(/[\d.]+/g)!.map(Number);
    const alpha = color[3] ?? 1;
    const glass = theme!.startsWith('glass');
    if (glass) {
      expect(alpha, `${theme} tint must let at least 60% of the photo through`).toBeGreaterThan(0);
      expect(alpha).toBeLessThanOrEqual(0.4);
      await expect(page.locator('.bg-sharp')).toHaveCSS('display', 'block');
      await expect(page.locator('.bg-matte')).toHaveCSS('mask-image', 'none');
      const sample = { x: page.viewportSize()!.width - 20, y: page.viewportSize()!.height - 160, width: 10, height: 10 };
      const renderBackground = async (index: number) => {
        await page.evaluate(async (value) => {
          const photo = new Image();
          photo.src = `/bg-${value}.jpg`;
          await photo.decode();
          document.documentElement.style.setProperty('--bg-url', `url('/bg-${value}.jpg')`);
        }, index);
        return page.screenshot({ clip: sample, animations: 'disabled' });
      };
      const firstPhoto = await renderBackground(1);
      const secondPhoto = await renderBackground(2);
      expect(firstPhoto.equals(secondPhoto), `${theme} background images must affect actual screen pixels`).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`mobile-${theme}-background-list.png`), fullPage: true });
      await page.getByRole('button', { name: '依赖图', exact: true }).click();
      await expect(page.locator('main[data-mobile-tab="graph"]')).toBeVisible();
      await expect(workspaceSurface).toHaveCSS('background-color', background);
      await page.screenshot({ path: testInfo.outputPath(`mobile-${theme}-background-graph.png`), fullPage: true });
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await expect(page.locator('[data-mobile-surface="theme-aware"]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(page.locator('main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      expect(await page.locator('main').evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
      await page.screenshot({ path: testInfo.outputPath(`mobile-${theme}-background-more.png`), fullPage: true });
      await page.getByRole('button', { name: '任务', exact: true }).click();
      await page.getByRole('button', { name: '切换到清单模式' }).click();
      await expect(page.getByRole('button', { name: '切换到页面模式' })).toBeEnabled();
      await expect(workspaceSurface).toHaveCSS('background-color', background);
      await page.getByRole('button', { name: '切换到页面模式' }).click();
      await expect(page.getByRole('button', { name: '切换到清单模式' })).toBeEnabled();
    } else {
      expect(alpha, `${theme} keeps its solid theme surface`).toBe(1);
      expect(color[0], `${theme} uses light theme tokens`).toBeGreaterThan(180);
      await expect(page.locator('.bg-sharp')).toHaveCSS('display', 'none');
    }
  }
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'glass-light'));

  const row = page.locator('[data-mobile-task-section="ready"] [data-task-id]').filter({
    has: page.locator('[data-task-title]', { hasText: titleText }),
  });
  await expect(row.locator('[data-task-title]')).toHaveCSS('white-space', 'normal');
  const statusBox = await row.locator('button[title^="点击切换状态"]').boundingBox();
  expect(statusBox).not.toBeNull();
  expect(statusBox!.x).toBeLessThan(64);
  const gradient = await row.locator('[data-swipe-action="complete"]').evaluate((element) => getComputedStyle(element, '::before').maskImage);
  expect(gradient).toContain('gradient');
  const toolbar = page.locator('.mobile-top-chrome').first();
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCSS('border-bottom-width', '0px');
  await expect(toolbar.locator('xpath=..')).toHaveCSS('border-bottom-width', '0px');
  const [toolbarColor, listColorAtSeam] = await Promise.all([
    toolbar.evaluate((element) => getComputedStyle(element).backgroundColor),
    listSurface.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  await expect(page.locator('main[data-mobile-tab="list"]')).toBeVisible();
  expect(toolbarColor).toBe(listColorAtSeam);
  const toolbarTopPadding = await toolbar.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop));
  expect(toolbarTopPadding).toBeGreaterThanOrEqual(24);
  await page.screenshot({ path: testInfo.outputPath('mobile-glass-light-list.png'), fullPage: true });
  await assertHierarchyAlignment(page, 20, testInfo.outputPath('mobile-task-hierarchy-alignment.png'));

  await page.getByRole('button', { name: '更多' }).click();
  const moreSurface = page.locator('[data-mobile-surface="theme-aware"]');
  await expect(moreSurface).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('mobile-light-more-panel.png'), fullPage: true });
});

test('Android GEST-008/GEST-009 swipe completion and deletion can both be undone above bottom navigation', async ({ page }, testInfo) => {
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'glass-light'));
  const titleText = `移动端滑动撤销回归 ${Date.now()}`;
  const sourceRow = await addTask(page, titleText);
  const taskId = await sourceRow.getAttribute('data-task-id');
  expect(taskId).toBeTruthy();
  const row = page.locator(`[data-task-id="${taskId}"]`);
  const cdp = await page.context().newCDPSession(page);

  const swipe = async (direction: 1 | -1, cancel = false) => {
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + Math.min(120, box!.width / 2);
    const y = box!.y + box!.height / 2;
    const action = direction > 0 ? 'complete' : 'delete';
    const hint = row.locator(`[data-swipe-action="${action}"]`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + direction * 48, y }] });
    await expect(hint).toHaveAttribute('data-active', 'true');
    await expect(hint).toHaveAttribute('data-armed', 'false');
    await expect(hint).toHaveText('');
    await expect(hint.locator('svg')).toHaveCSS('border-radius', '50%');
    const hintBox = await hint.boundingBox();
    const iconBox = await hint.locator('svg').boundingBox();
    expect(Math.abs(iconBox!.y + iconBox!.height / 2 - hintBox!.y - hintBox!.height / 2)).toBeLessThan(0.5);
    const veil = await hint.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return { mask: style.maskImage, blur: style.backdropFilter };
    });
    expect(veil.mask, 'the blur itself must fade, not just its background tint').toContain('gradient');
    expect(veil.blur).toContain('blur');
    const theme = await page.locator('html').getAttribute('data-theme');
    await page.screenshot({ path: testInfo.outputPath(`${theme}-swipe-${action}-partial.png`), fullPage: true, animations: 'disabled' });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + direction * 96, y }] });
    await expect(hint).toHaveAttribute('data-armed', 'true');
    await page.screenshot({ path: testInfo.outputPath(`${theme}-swipe-${action}-armed.png`), fullPage: true, animations: 'disabled' });
    const top = Math.max(0, box!.y - 32);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-swipe-${action}-detail.png`), animations: 'disabled',
      clip: { x: 0, y: top, width: page.viewportSize()!.width, height: Math.min(128, page.viewportSize()!.height - top) },
    });
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    if (cancel) {
      await expect(hint).toHaveAttribute('data-active', 'false');
      await expect(hint).toHaveCSS('opacity', '0');
      await expect(row).toBeVisible();
      await expect(row.locator('button[title^="点击切换状态"]')).toHaveAttribute('data-status', 'todo');
    }
  };

  for (const theme of ['glass-dark', 'glass-light']) {
    await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), theme);
    await swipe(1, true);
    await swipe(-1, true);
  }
  await swipe(1);
  const undo = page.getByRole('button', { name: '撤销' });
  await expect(undo).toBeVisible();
  await expect(page.locator(`[data-mobile-task-section="ready"] [data-task-id="${taskId}"]`)).toHaveCount(0);
  const toastBox = await undo.last().boundingBox();
  const navigationBox = await page.locator('nav[data-mobile-chrome="theme-aware"]').boundingBox();
  expect(toastBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(toastBox!.y + toastBox!.height).toBeLessThan(navigationBox!.y);
  await page.screenshot({ path: testInfo.outputPath('mobile-glass-light-undo-toast.png'), fullPage: true });

  await undo.last().click();
  await expect(row).toBeVisible();
  await swipe(-1);
  await expect(row).toHaveCount(0);
  await expect(undo.last()).toBeVisible();
  await undo.last().click();
  await expect(row).toBeVisible();
});
