import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { addTask, openIsolatedWorkspace } from './support';

const recoveryRequest = (url: string) => /\/api\/(pages\/[^/]+\/backups|trash\/pages)$/.test(new URL(url).pathname);

async function openSettings(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === 'desktop-chromium') await page.getByTitle('账号与数据安全').click();
  else await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('button', { name: '备份与恢复', exact: true })).toBeVisible();
}

async function leaveSettings(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === 'desktop-chromium') await page.getByRole('button', { name: '关闭账号与数据' }).click();
  else await page.getByRole('button', { name: '任务', exact: true }).click();
}

test.beforeEach(async ({ page }, testInfo) => { await openIsolatedWorkspace(page, testInfo); });

test('NAV-007 settings load recovery data only inside the backup subpage and preserve the page on return', async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'desktop-chromium') await page.setViewportSize({ width: 390, height: 500 });
  const recoveryReads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && recoveryRequest(request.url())) recoveryReads.push(new URL(request.url()).pathname);
  });
  for (let visit = 0; visit < 2; visit += 1) {
    await openSettings(page, testInfo);
    // Observe through the entry animation and effects, including fast responses.
    await page.waitForTimeout(300);
    expect(recoveryReads).toEqual([]);
    if (testInfo.project.name !== 'desktop-chromium') await expect(page.locator('main[data-mobile-tab="more"] > div')).toHaveCSS('animation-name', 'none');
    await expect(page.getByRole('button', { name: '备份与恢复', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前页备份' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`settings-home-${visit}.png`), animations: 'disabled' });
    if (visit === 0) await leaveSettings(page, testInfo);
  }
  if (testInfo.project.name !== 'desktop-chromium') {
    await page.locator('[data-mobile-surface="theme-aware"]').evaluate((element) => { element.scrollTop = 100; });
  }
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await expect(page.getByRole('heading', { name: '备份与恢复', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '当前页备份' })).toBeVisible();
  await expect(page.getByPlaceholder('当前密码', { exact: true })).toHaveCount(0);
  await expect.poll(() => recoveryReads.some((url) => url.endsWith('/backups'))).toBe(true);
  await expect.poll(() => recoveryReads.some((url) => url.endsWith('/trash/pages'))).toBe(true);
  await expect(page.getByRole('button', { name: '刷新备份' })).toBeEnabled();
  if (testInfo.project.name !== 'desktop-chromium') await expect.poll(() => page.locator('[data-mobile-surface="theme-aware"]').evaluate((element) => element.scrollTop)).toBe(0);
  if (testInfo.project.name !== 'desktop-chromium') await expect(page.getByRole('heading', { name: 'AI Agent 接入' })).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON' }).click();
  await (await downloaded).saveAs(testInfo.outputPath('workspace-export.json'));
  await expect(page.getByRole('status')).toContainText('JSON 已导出');
  await page.screenshot({ path: testInfo.outputPath('settings-backups.png'), fullPage: true });
  const readsBeforeReturn = recoveryReads.length;
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '备份与恢复', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '当前页备份' })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(recoveryReads).toHaveLength(readsBeforeReturn);
  await leaveSettings(page, testInfo);
  const meta = await (await page.request.get('/api/meta')).json() as { activePageId: string; pages: Array<{ id: string; title: string }> };
  expect(meta.pages.find((item) => item.id === meta.activePageId)?.title).toBe('E2E 测试沙箱');
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
});

test('backup subpage shows loading, supports retry, and can be left while requests are pending', async ({ page }, testInfo) => {
  let fail = true;
  await page.route('**/api/pages/*/backups', async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '备份服务暂不可用' }) });
    else await route.continue();
  });
  await openSettings(page, testInfo);
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('备份服务暂不可用');
  await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新备份' })).toBeEnabled();
  fail = false;
  await page.getByRole('button', { name: '刷新备份' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '刷新备份' })).toBeEnabled();
  await page.getByRole('button', { name: '返回设置', exact: true }).click();

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/trash/pages', async (route) => {
    await pending;
    await route.continue().catch(() => undefined); // Navigation may cancel the held request.
  });
  try {
    const started = page.waitForRequest('**/api/trash/pages');
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await started;
    await expect(page.getByRole('status')).toContainText('正在加载备份');
    await expect(page.getByRole('button', { name: '刷新备份' })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('settings-backups-loading.png'), fullPage: true });
    await page.getByRole('button', { name: '返回设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '备份与恢复', exact: true })).toBeVisible();
  } finally { release(); }
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: '当前页备份' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('backup catalog remains usable when trash fails and recovers after retry', async ({ page }, testInfo) => {
  const meta = await (await page.request.get('/api/meta')).json();
  expect((await page.request.post(`/api/pages/${meta.activePageId}/backup`)).ok()).toBe(true);
  let fail = true;
  await page.route('**/api/trash/pages', async route => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '回收站暂不可用' }) });
    else await route.continue();
  });
  await openSettings(page, testInfo);
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('回收站暂不可用');
  await expect(page.getByRole('combobox', { name: '当前页备份' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '恢复所选备份' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('independent-backup-catalog.png') });
  fail = false;
  await page.getByRole('button', { name: '刷新备份' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('回收站为空', { exact: true })).toBeVisible();
});

test('backup restore still persists the selected page after moving into settings', async ({ page }, testInfo) => {
  const meta = await (await page.request.get('/api/meta')).json() as { activePageId: string };
  const original = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json() as { nodes: Array<{ id: string; title: string }>; edges: unknown[] };
  expect((await page.request.post(`/api/pages/${meta.activePageId}/backup`)).ok()).toBe(true);
  const addedTitle = `恢复前临时任务 ${Date.now()}`;
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/pages/${meta.activePageId}` && response.ok());
  await addTask(page, addedTitle);
  await saved;
  await openSettings(page, testInfo);
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  const backups = page.getByRole('combobox', { name: '当前页备份' });
  await expect(backups).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '恢复所选备份' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复所选备份' })).toBeVisible();
  const restored = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json() as { nodes: Array<{ id: string; title: string }>; edges: unknown[] };
  // The visible graph may add missing layout coordinates; every backed-up field must survive.
  expect(restored.nodes).toMatchObject(original.nodes);
  expect(restored.edges).toEqual(original.edges);
  await leaveSettings(page, testInfo);
  await page.reload();
  await expect(page.getByText(addedTitle, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-task-title]').filter({ hasText: original.nodes[0]!.title })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-restored-page.png'), fullPage: true });
});
