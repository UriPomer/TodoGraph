import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }, testInfo) => {
  const platform = testInfo.project.name.startsWith('android') ? 'a' : 'i';
  const username = `e2e-${platform}-${testInfo.workerIndex}-${Date.now().toString(36)}`;
  const response = await page.request.post('/api/auth/register', {
    data: {
      username,
      password: 'Gesture1234',
      registrationKey: 'todograph-e2e',
      remember: false,
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.locator('[data-task-id]').first()).toBeVisible();
});

test('GEST-002/GEST-003 long press drags twice without editing or scrolling', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright exposes low-level moving touch input only through Chromium CDP');
  const row = page.locator('[data-task-id]').first();
  const title = row.locator('[data-task-title]');
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + Math.min(20, box!.width / 2);
  const y = box!.y + box!.height / 2;
  const cdp = await page.context().newCDPSession(page);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(420);
    await expect(page.locator('.fixed.pointer-events-none.z-50')).toBeVisible();
    await expect(row.locator('input')).toHaveCount(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 24 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
  }
});

test('double tap edits the title while a single tap does not', async ({ page }) => {
  const row = page.locator('[data-task-id]').first();
  const title = row.locator('[data-task-title]');
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + Math.min(20, box!.width / 2);
  const y = box!.y + box!.height / 2;

  await page.touchscreen.tap(x, y);
  await expect(row.locator('input')).toHaveCount(0);
  await page.touchscreen.tap(x, y);
  await expect(row.locator('input')).toBeFocused();
});
