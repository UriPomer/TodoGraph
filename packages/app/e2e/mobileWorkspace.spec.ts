import { expect, test, type Page } from '@playwright/test';
import { addTask, openIsolatedWorkspace, taskRow, taskStatusButton } from './support';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium');
  await openIsolatedWorkspace(page, testInfo);
});

async function pullToCreate(page: Page) {
  const heading = page.locator('[data-mobile-task-section="ready"] h3');
  const box = await heading.boundingBox();
  const point = { id: 1, x: box!.x + 5, y: box!.y + box!.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + 220 }] });
  await expect(page.getByText('松手新建', { exact: true })).toBeVisible();
  return { cdp, heading, initialY: box!.y, point };
}

test('pull-to-create clears the previous distance before the next tap', async ({ page }, testInfo) => {
  const input = page.locator('input[placeholder^="新任务"]');
  const { cdp, heading, point } = await pullToCreate(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(input).toBeFocused();
  await heading.click();
  await expect(input).not.toBeFocused();
  await page.touchscreen.tap(point.x, point.y);
  await expect(input).not.toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('mobile-pull-repeat.png'), fullPage: true });
});

for (const interruption of ['blur', 'second finger'] as const) {
  test(`pull-to-create cancels on ${interruption} without opening the keyboard`, async ({ page }, testInfo) => {
    const { cdp, heading, initialY, point } = await pullToCreate(page);
    if (interruption === 'blur') {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    } else {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
        { ...point, y: point.y + 220 }, { id: 2, x: page.viewportSize()!.width - 10, y: 10 },
      ] });
    }
    await expect.poll(async () => Math.abs((await heading.boundingBox())!.y - initialY)).toBeLessThan(0.5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('input[placeholder^="新任务"]')).not.toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`mobile-pull-cancel-${interruption.replace(' ', '-')}.png`), fullPage: true });
  });
}

test('NAV-001/NAV-002/NAV-003/NAV-008 checklist stays list-only, folds Done, and restores the graph tab', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: '依赖图' }).click();
  await expect(page.locator('main[data-mobile-tab="graph"]')).toBeVisible();
  let switchRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/api/pages/system-hierarchy')) {
      switchRequests += 1;
    }
  });
  await page.route('**/api/pages/system-hierarchy', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const modeButton = page.getByRole('button', { name: '切换到清单模式' });
  const switchRequest = page.waitForRequest((request) =>
    request.method() === 'PATCH' && new URL(request.url()).pathname.endsWith('/api/pages/system-hierarchy'),
  );
  await modeButton.click();
  await expect(modeButton).toBeDisabled();
  await switchRequest;
  await expect(page.locator('main[data-mobile-tab="list"]')).toBeVisible();
  await expect.poll(() => switchRequests).toBe(1);
  await expect(page.locator('[data-mobile-task-section="blocked"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '依赖图' })).toBeDisabled();

  const title = `清单已完成事项 ${Date.now()}`;
  const row = await addTask(page, title);
  const status = taskStatusButton(row);
  await status.click();
  await status.click();
  await expect(taskRow(page, title)).toHaveCount(0);
  await page.getByRole('button', { name: '展开已完成任务' }).click();
  await expect(taskRow(page, title)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-checklist-done.png'), fullPage: true });

  await page.getByRole('button', { name: '切换到页面模式' }).click();
  await expect(page.locator('main[data-mobile-tab="graph"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '依赖图' })).toBeEnabled();
});

test('NAV-004/NAV-005 mobile page creation, page switching, cross-page split, and More panel work together', async ({ page }, testInfo) => {
  const metaResponse = await page.request.get('/api/meta');
  const initialMeta = await metaResponse.json() as {
    activePageId: string;
    pages: Array<{ id: string; title: string }>;
  };
  const initialTitle = initialMeta.pages.find((item) => item.id === initialMeta.activePageId)?.title;
  expect(initialTitle).toBeTruthy();

  const pageTitle = `端到端页面 ${Date.now()}`;
  await page.getByRole('button', { name: '新建页面' }).click();
  await page.getByPlaceholder('输入页面名称').fill(pageTitle);
  await page.getByRole('button', { name: '确定' }).click();
  await expect(page.getByRole('button', { name: '选择页面' })).toContainText(pageTitle);

  const crossPageTitle = `其他页面可做 ${Date.now()}`;
  await addTask(page, crossPageTitle);
  await page.getByRole('button', { name: '选择页面' }).click();
  await page.getByRole('menuitem', { name: initialTitle! }).click();
  await expect(page.getByRole('button', { name: '选择页面' })).toContainText(initialTitle!);
  await expect(page.locator('main[data-mobile-tab="list"]')).toBeVisible();
  await expect(page.locator('[data-mobile-task-section="ready"]').getByText(crossPageTitle)).toHaveCount(0);
  await expect(page.getByText('其他页面可做', { exact: true })).toBeVisible();

  const split = page.locator('[data-list-split="adjustable"]');
  await expect(split).toBeVisible();
  const initialBox = await split.boundingBox();
  const handleBox = await split.locator('span').first().boundingBox();
  expect(initialBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  const x = handleBox!.x + handleBox!.width / 2;
  const y = handleBox!.y + handleBox!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 56 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await split.boundingBox())?.y ?? 0).toBeLessThan(initialBox!.y - 30);

  await page.getByRole('button', { name: '更多' }).click();
  await expect(page.locator('main[data-mobile-tab="more"]')).toBeVisible();
  await expect(page.getByText('账号与数据')).toBeVisible();
  await expect(page.getByText('AI Agent 接入')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-more-panel.png'), fullPage: true });

  await page.getByRole('button', { name: '任务' }).click();
  await expect(page.locator('main[data-mobile-tab="list"]')).toBeVisible();
});

test('GEST-011/GEST-012/GEST-013 mobile description read, edit, cancel, and clear persist normalized text', async ({ page }) => {
  const title = `移动端描述任务 ${Date.now()}`;
  const row = await addTask(page, title);
  const rowId = await row.getAttribute('data-task-id');
  expect(rowId).toBeTruthy();
  const stableRow = page.locator(`[data-task-id="${rowId}"]`);
  const descriptionButton = stableRow.locator('[data-task-action="description"]');
  const savedDescription = '移动端描述已规范化';

  await descriptionButton.click();
  await stableRow.getByPlaceholder('添加描述...').fill(`  ${savedDescription}  `);
  await descriptionButton.click();
  await descriptionButton.click();
  const descriptionView = stableRow.locator('[data-task-description-view]');
  await expect(descriptionView).toContainText(savedDescription);
  const descriptionBox = await descriptionView.boundingBox();
  expect(descriptionBox).not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  const touchX = descriptionBox!.x + descriptionBox!.width / 2;
  const touchY = descriptionBox!.y + descriptionBox!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY }] });
  await page.waitForTimeout(420);
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const editor = stableRow.getByPlaceholder('添加描述...');
  if (!await editor.count()) await descriptionView.click();
  await expect(editor).toBeVisible();
  await editor.fill('临时草稿');
  await editor.press('Escape');
  await descriptionButton.click();
  await expect(stableRow.locator('[data-task-description-view]')).toContainText(savedDescription);

  await stableRow.locator('[data-task-description-view]').click();
  await stableRow.getByPlaceholder('添加描述...').fill('  \n  ');
  await descriptionButton.click();
  const metaResponse = await page.request.get('/api/meta');
  const meta = await metaResponse.json() as { activePageId: string };
  await expect.poll(async () => {
    const response = await page.request.get(`/api/pages/${meta.activePageId}`);
    const data = await response.json() as { nodes: Array<{ id: string; description?: string }> };
    return data.nodes.find((node) => node.id === rowId)?.description ?? null;
  }).toBe(null);
});
