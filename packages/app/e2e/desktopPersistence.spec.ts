import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addTask } from './support';

test('PRODUCT-DESKTOP: local data survives process restart and loopback port change', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'todograph-desktop-e2e-'));
  const launch = () => electron.launch({
    args: [path.resolve('out/main/index.js')],
    env: { ...process.env, TODOGRAPH_DATA_DIR: dataDir, TODOGRAPH_E2E: '1', ELECTRON_RENDERER_URL: '' },
  });
  let app = await launch();
  let firstOrigin = '';
  try {
    let page = await app.firstWindow();
    await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
    await addTask(page, '桌面重启保留');
    await expect.poll(() => page.evaluate(async () => {
      const response = await window.todograph!.deviceStorage.read('workspace');
      return JSON.stringify(response.value).includes('桌面重启保留');
    })).toBeTruthy();
    firstOrigin = new URL(page.url()).origin;
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    // The origin is deliberately random; no preference or data may depend on it.
    await expect(page.locator('[data-task-title]').filter({ hasText: '桌面重启保留' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('desktop-process-restart.png') });
    await testInfo.attach('desktop-origin-persistence', { body: JSON.stringify({ firstOrigin, secondOrigin: new URL(page.url()).origin, dataDir }), contentType: 'application/json' });
  } finally { await app.close(); }
});
