import { expect, test } from '@playwright/test';
import { addTask } from './support';

test.describe('PRODUCT-LOCAL: free local workspace', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('local data survives reload without any API server and the second page opens Pro', async ({ page }, testInfo) => {
    await page.route('**/*', route => new URL(route.request().url()).pathname.startsWith('/api/') ? route.abort() : route.continue());
    await page.goto('/');
    await page.getByRole('button', { name: '在本机使用', exact: true }).click();
    await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
    if (testInfo.project.name !== 'desktop-chromium') await page.getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.getByText('仅本地', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    if (testInfo.project.name !== 'desktop-chromium') await page.getByRole('button', { name: '任务', exact: true }).click();
    await addTask(page, '无需服务器保存');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('[data-task-title]').filter({ hasText: '无需服务器保存' })).toBeVisible();
    await page.getByRole('button', { name: /新页面|新建页面/ }).filter({ visible: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'TodoGraph Pro' })).toBeVisible();
    await expect(page.getByText('购买尚未配置', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('local-free-pro.png'), fullPage: true });
    await testInfo.attach('local-persistence', {
      body: JSON.stringify({ behavior: 'PRODUCT-LOCAL', task: '无需服务器保存', api: 'all requests aborted', reload: true }),
      contentType: 'application/json',
    });
  });
});

test('PRODUCT-PRO: server-issued Pro enables pages and persistent custom appearance', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  if (testInfo.project.name !== 'desktop-chromium') await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('button', { name: 'TodoGraph Pro', exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '切换主题' }).filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: /自定义外观/ }).click();
  const dialog = page.getByRole('dialog', { name: '自定义外观' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('材质不透明度').fill('75');
  await dialog.getByLabel('模糊强度').fill('24');
  // A small real PNG, uploaded through the same file input as user images.
  await dialog.getByLabel('背景图片').setInputFiles({
    name: 'custom.png', mimeType: 'image/png',
    buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 80, height: 80 } }),
  });
  await dialog.getByRole('button', { name: '应用外观', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-custom-wallpaper', 'true');
  await expect.poll(() => page.locator('html').evaluate(el => el.style.getPropertyValue('--custom-material-alpha'))).toBe('0.75');
  await page.screenshot({ path: testInfo.outputPath('pro-custom-appearance.png'), fullPage: true });
});

test('PRODUCT-LIMIT: server rejects free page creation/import and ignores client Pro claims', async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const registered = await context.request.post('http://127.0.0.1:5184/api/auth/register', {
      data: { username: `free-${Date.now()}`, password: 'FreeTest1234', registrationKey: 'todograph-e2e' },
    });
    expect(registered.ok()).toBeTruthy();
    const meta = await (await context.request.get('http://127.0.0.1:5184/api/meta')).json();
    const denied = await context.request.post('http://127.0.0.1:5184/api/pages', {
      data: { title: '绕过界面', expectedRevision: meta.revision, plan: 'pro' },
    });
    expect(denied.status()).toBe(403);
    const exported = await (await context.request.get('http://127.0.0.1:5184/api/workspace/export.json')).json();
    exported.meta.pages.push({ id: 'extra-free-page', title: '绕过导入', order: 9, createdAt: new Date().toISOString() });
    exported.pages['extra-free-page'] = { nodes: [], edges: [] };
    const deniedImport = await context.request.post('http://127.0.0.1:5184/api/workspace/import', { data: exported });
    expect(deniedImport.status()).toBe(403);
    expect((await (await context.request.get('http://127.0.0.1:5184/api/meta')).json()).pages).toEqual(meta.pages);
    await testInfo.attach('server-quota-results', { body: JSON.stringify({ creation: denied.status(), import: deniedImport.status(), originalPages: meta.pages }), contentType: 'application/json' });
    await page.goto('http://127.0.0.1:5184/');
    await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  } finally { await context.close(); }
});
