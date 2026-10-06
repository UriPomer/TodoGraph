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
    await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    // Move the content surface away to expose the viewport backdrop. The same
    // pixels must remain, including blur, brightness and theme tint.
    // Exclude the viewport's fractional-device-pixel side boundary, where a
    // transformed layer can round differently (Pixel 7 uses a 2.625 scale).
    // Below the 59px safe area + 8px fixed color band, above controls at 75px.
    const clip = { x: 1, y: 68, width: page.viewportSize()!.width - 2, height: 4 };
    const covered = await page.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`${theme}-covered-edge.png`) });
    const workspace = page.locator('.mobile-workspace-shell');
    await workspace.evaluate((element) => { (element as HTMLElement).style.transform = 'translateY(200px)'; });
    expect((await workspace.boundingBox())!.y).toBe(200);
    const exposed = await page.screenshot({ clip, animations: 'disabled', path: testInfo.outputPath(`${theme}-exposed-edge.png`) });
    await workspace.evaluate((element) => { (element as HTMLElement).style.removeProperty('transform'); });
    const delta = await page.evaluate(async ([before, after]) => {
      const decode = async (png: string) => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [a, b] = await Promise.all([decode(before!), decode(after!)]);
      let maximum = 0, sum = 0;
      for (let index = 0; index < a.length; index += 1) {
        if (index % 4 === 3) continue;
        const difference = Math.abs(a[index]! - b[index]!);
        maximum = Math.max(maximum, difference);
        sum += difference;
      }
      return { maximum, mean: sum / (a.length * .75) };
    }, [covered.toString('base64'), exposed.toString('base64')]);
    // Fractional device pixels can differ by 1–2 channel steps after compositing;
    // bound the mean as well so a uniform tint cannot pass as rounding noise.
    await testInfo.attach(`${theme}-edge-delta`, { body: JSON.stringify(delta), contentType: 'application/json' });
    expect(delta.maximum, `${theme} must preserve the exposed edge's rendered colors`).toBeLessThanOrEqual(2);
    expect(delta.mean, `${theme} must not introduce a tinted strip`).toBeLessThan(.25);
    await expect(page.locator('html')).toHaveCSS('background-image', 'none');
    await page.screenshot({ path: testInfo.outputPath(`${theme}-root-background.png`), animations: 'disabled' });
  }
});

test('mobile NATIVE-103 glass home-screen status area preserves wallpaper and safe-area controls', async ({ page }, testInfo) => {
  // Emulate only the iOS launch signal, not the system compositor or its blur.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  });
  await page.reload();
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
  const edgeElement = page.locator('.ios-status-bar-edge');
  await expect(edgeElement).toHaveCount(1);
  await expect(edgeElement).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').content)).toBe('none');

  for (const theme of ['glass-dark', 'glass-light']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    // The native extension accepts a solid color, matched to the wallpaper's
    // top edge. This empty text-clipped element must not cover any page pixels.
    await expect(edgeElement).toHaveCSS('display', 'block');
    await expect(edgeElement).toHaveCSS('background-clip', 'text');
    await expect(edgeElement).toHaveCSS('pointer-events', 'none');
    await expect(edgeElement).toBeEmpty();
    await expect.poll(() => edgeElement.evaluate(element => getComputedStyle(element).backgroundColor))
      .toBe(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor));
    for (const inset of [59, 0]) {
      await page.evaluate((value) => {
        document.documentElement.style.setProperty('--safe-area-inset-top', `${value}px`);
      }, inset);
      for (const tab of ['任务', '依赖图', '更多']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
        const chrome = page.locator('.mobile-top-chrome:visible');
        const top = await chrome.evaluate((element) => {
          const control = element.querySelector('button')!;
          return { y: element.getBoundingClientRect().y, controlY: control.getBoundingClientRect().y,
            background: getComputedStyle(element).backgroundColor };
        });
        expect(top.y).toBe(0);
        expect(top.controlY).toBeGreaterThanOrEqual(inset);
        expect(top.background).toBe('rgba(0, 0, 0, 0)');
        const fixedTopColors = await page.evaluate(() => {
          return Array.from(document.querySelectorAll<HTMLElement>('body *')).filter(element => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            // WebKit also samples full-screen translucent dimming layers at
            // negative z-index. A wallpaper tint must not publish a flat color
            // that the browser can extend over the photo in its obscured inset.
            return !element.classList.contains('ios-status-bar-edge') && style.position === 'fixed' && style.display !== 'none'
              && box.top <= 4 && box.bottom > 10
              && box.width >= window.innerWidth * .9 && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
          }).map(element => element.className);
        });
        expect(fixedTopColors, 'No additional fixed color layer may cover the wallpaper').toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`home-screen-${theme}-${inset}-${tab}.png`), animations: 'disabled' });
      }
    }
  }

  // Solid themes return to the card color; glass returns to the photo color.
  for (const theme of ['default-dark', 'default-light', 'glass-dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await expect(edgeElement).toHaveCSS('display', 'block');
  }

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
