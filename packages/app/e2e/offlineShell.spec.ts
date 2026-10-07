import { expect, test } from '@playwright/test';
import { addTask } from './support';

test('PRODUCT-OFFLINE: production app and tasks reload while the network is unavailable', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('offline-'));
  await page.goto('/');
  const local = page.getByRole('button', { name: '在本机使用', exact: true });
  if (await local.isVisible()) await local.click();
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await addTask(page, '断网重新打开仍然存在');
  await page.waitForTimeout(600);
  // Closing every HTTP socket also exercises WebKit without its emulated-offline navigation bug.
  await page.request.post('/__e2e_network', { data: { offline: true } });
  try {
  await page.reload();
  await expect(page.locator('[data-task-title]').filter({ hasText: '断网重新打开仍然存在' })).toBeVisible();
  await addTask(page, '断网新增任务');
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.locator('[data-task-title]').filter({ hasText: '断网新增任务' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('offline-reload.png'), fullPage: true });
  await testInfo.attach('offline-production-result', { body: JSON.stringify({ productionBuild: true, serviceWorker: true, networkFailure: 'all application HTTP sockets closed', reloads: 2, tasks: 2 }), contentType: 'application/json' });
  } finally { await page.request.post('/__e2e_network', { data: { offline: false } }); }
});
