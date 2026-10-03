import { expect, test } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium', 'Mobile status area');
  await openIsolatedWorkspace(page, testInfo);
});

test('mobile exposed canvas and workspace share the same composed background', async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const photo = new Image();
    photo.src = '/bg-1.jpg';
    await photo.decode();
    document.documentElement.style.setProperty('--bg-url', 'url("/bg-1.jpg")');
    document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
  });
  for (const [theme, label] of [
    ['glass-dark', '玻璃·深色'], ['glass-light', '玻璃·浅色'],
    ['default-dark', '经典·深色'], ['default-light', '经典·浅色'],
    ['muted-warm', '暖素'], ['muted-cool', '冷素'], ['muted-dark', '素色·深色'],
  ]) {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.locator('[data-mobile-more-header]').getByTitle('切换主题').click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    // Move the content surface away to expose the viewport backdrop. The same
    // pixels must remain, including blur, brightness and theme tint.
    // Exclude the viewport's fractional-device-pixel side boundary, where a
    // transformed layer can round differently (Pixel 7 uses a 2.625 scale).
    const clip = { x: 1, y: 0, width: page.viewportSize()!.width - 2, height: 20 };
    const covered = await page.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`${theme}-covered-edge.png`) });
    const workspace = page.locator('.mobile-workspace-shell');
    await workspace.evaluate((element) => { (element as HTMLElement).style.transform = 'translateY(48px)'; });
    expect((await workspace.boundingBox())!.y).toBe(48);
    const exposed = await page.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`${theme}-exposed-edge.png`) });
    await workspace.evaluate((element) => { (element as HTMLElement).style.removeProperty('transform'); });
    expect(covered.equals(exposed), `${theme} must not change the edge's rendered colors when the canvas is exposed`).toBe(true);
    await expect(page.locator('html')).toHaveCSS('background-image', 'none');
    await page.screenshot({ path: testInfo.outputPath(`${theme}-root-background.png`), animations: 'disabled' });
  }
});

test('mobile NATIVE-103 home-screen edge treatment is invisible and preserves safe-area controls', async ({ page }, testInfo) => {
  // Emulate only the iOS launch signal, not the system compositor or its blur.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  });
  await page.reload();
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  const edgeElement = page.locator('.ios-status-bar-edge');
  await expect(edgeElement).toHaveCount(1);
  await expect(edgeElement).toHaveAttribute('aria-hidden', 'true');
  await expect(edgeElement).toHaveText('');
  await expect(edgeElement).toHaveCSS('position', 'fixed');
  // WebKit's fixed-container sampler ignores pointer-events. Temporarily do
  // that for DOM hit testing and verify the hit node itself owns fixed layout.
  const hit = await edgeElement.evaluate((element) => {
    const edge = element as HTMLElement;
    edge.style.pointerEvents = 'auto';
    try {
      const node = document.elementFromPoint(window.innerWidth / 2, 5)!;
      return { sameNode: node === edge, position: getComputedStyle(node).position };
    } finally { edge.style.removeProperty('pointer-events'); }
  });
  expect(hit).toEqual({ sameNode: true, position: 'fixed' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').content)).toBe('none');

  for (const inset of [59, 0]) {
    await page.evaluate((value) => {
      document.documentElement.style.setProperty('--safe-area-inset-top', `${value}px`);
    }, inset);
    for (const tab of ['任务', '依赖图', '更多']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      const chrome = page.locator('.mobile-top-chrome:visible');
      const top = await chrome.evaluate((element) => {
        const control = element.querySelector('button')!;
        return { y: element.getBoundingClientRect().y, controlY: control.getBoundingClientRect().y,
          background: getComputedStyle(element).backgroundColor };
      });
      expect(top.y).toBe(0);
      expect(top.controlY).toBeGreaterThanOrEqual(inset + 24);
      expect(top.background).toBe('rgba(0, 0, 0, 0)');
      const edge = await edgeElement.evaluate((element) => {
        const style = getComputedStyle(element);
        return { pointerEvents: style.pointerEvents, clip: style.backgroundClip, filter: style.backdropFilter };
      });
      expect(edge).toEqual({ pointerEvents: 'none', clip: 'text', filter: 'none' });
      await page.screenshot({ path: testInfo.outputPath(`home-screen-${inset}-${tab}.png`), animations: 'disabled' });
    }
  }

  // The compatibility layer must not paint a new dark strip in the page.
  const clip = { x: 0, y: 0, width: page.viewportSize()!.width, height: 20 };
  const withEdge = await page.screenshot({ clip, animations: 'disabled' });
  await edgeElement.evaluate((element) => { (element as HTMLElement).style.display = 'none'; });
  const withoutEdge = await page.screenshot({ clip, animations: 'disabled' });
  expect(withEdge.equals(withoutEdge), 'top-edge pixels must remain unchanged').toBe(true);
  await edgeElement.evaluate((element) => { (element as HTMLElement).style.removeProperty('display'); });

  await page.getByRole('button', { name: '任务', exact: true }).click();
  await page.locator('input[placeholder^="新任务"]').fill('顶部兼容层不阻断编辑');
  await page.locator('input[placeholder^="新任务"]').press('Enter');
  await expect(page.locator('[data-task-title]').filter({ hasText: '顶部兼容层不阻断编辑' })).toBeVisible();
});

test('mobile browser tabs do not enable the home-screen edge treatment', async ({ page }, testInfo) => {
  await expect(page.locator('.ios-status-bar-edge')).toBeHidden();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').content)).toBe('none');
  await page.screenshot({ path: testInfo.outputPath('browser-tab-top.png'), animations: 'disabled' });
});
