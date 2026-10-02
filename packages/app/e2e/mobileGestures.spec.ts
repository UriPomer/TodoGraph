import { expect, test } from '@playwright/test';
import { addTask, openIsolatedWorkspace } from './support';

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop-chromium') test.skip();
  if (testInfo.title.includes('long press') && testInfo.project.name !== 'android-chromium') test.skip();
  await openIsolatedWorkspace(page, testInfo);
});

test('GEST-002/GEST-003 long press repeats, blocks scrolling, and cancels when a second finger joins', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'Playwright exposes low-level moving touch input only through Android Chromium CDP');
  for (let index = 0; index < 18; index += 1) {
    await addTask(page, `长按滚动夹具 ${index} ${Date.now()}`);
  }
  const row = page.locator('[data-task-id]').first();
  const title = row.locator('[data-task-title]');
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + Math.min(20, box!.width / 2);
  const y = box!.y + box!.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const scrollArea = page.locator('.mobile-list-glass > div').first();
  await expect.poll(() => scrollArea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scrollTop = await scrollArea.evaluate((element) => element.scrollTop);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(420);
    await expect(page.locator('.fixed.pointer-events-none.z-50')).toBeVisible();
    await expect(row.locator('input')).toHaveCount(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 24 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
    await expect.poll(() => scrollArea.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  }

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x, y }] });
  await page.waitForTimeout(420);
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x, y }, { id: 2, x: page.viewportSize()!.width - 10, y: 10 }],
  });
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
});

test('GEST-002 long press clears its pressed row when release is retargeted outside the row', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'android-chromium', 'Playwright exposes low-level moving touch input only through Android Chromium CDP');
  const row = await addTask(page, `长按行外释放回归 ${Date.now()}`);
  const title = row.locator('[data-task-title]');
  const box = await title.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + Math.min(20, box!.width / 2);
  const y = box!.y + box!.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const dragOverlay = page.locator('.fixed.pointer-events-none.z-50');

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 71, x, y }] });
  await page.waitForTimeout(420);
  await expect(dragOverlay).toBeVisible();
  await expect(row).toHaveClass(/opacity-25/);

  await page.evaluate(({ id, x: clientX, y: clientY }) => {
    const touch = new Touch({ identifier: id, target: document.body, clientX, clientY });
    document.dispatchEvent(new TouchEvent('touchend', {
      changedTouches: [touch],
      targetTouches: [],
      touches: [],
      bubbles: true,
      cancelable: true,
    }));
  }, { id: 71, x, y });
  await expect(dragOverlay).toHaveCount(0);
  await expect(row).not.toHaveClass(/opacity-25/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 72, x, y }] });
  await page.waitForTimeout(420);
  await expect(dragOverlay).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(dragOverlay).toHaveCount(0);
  await expect(row).not.toHaveClass(/opacity-25/);
  await page.screenshot({ path: testInfo.outputPath('mobile-long-press-release-cleanup.png'), fullPage: true });
});

test('double tap edits the title while a single tap does not', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium');
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

test('GEST-002 long press cancels when the window loses focus', async ({ page }, testInfo) => {
  const row = await addTask(page, `长按失焦取消 ${Date.now()}`);
  const box = await row.locator('[data-task-title]').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box!.x + 10, y: box!.y + box!.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(row).toHaveAttribute('data-pressed', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(row).not.toHaveAttribute('data-pressed', 'true');
  await page.waitForTimeout(420);
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
  await expect(row).not.toHaveClass(/opacity-25/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.screenshot({ path: testInfo.outputPath('mobile-long-press-blur-cleanup.png'), fullPage: true });
});
