import { expect, test } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

// Separate contexts keep WebKit's decoded-image cache from retaining a previous
// real photo under the same fixture URL while the replacement response arrives.
for (const [pass, color] of ['#eeddbb', '#99bbff'].entries()) {
test(`NATIVE-103 loaded wallpaper ${color} paints continuously through the frosted top edge`, async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'Mobile filtered wallpaper');
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.setViewportSize({ width: 390, height: 844 });
  const samples = [];
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/bg-*.jpg', async route => {
      await ready;
      await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><path fill="${color}" d="M0 0h1920v1080H0z"/></svg>` });
    });
    await openIsolatedWorkspace(page, info, 'domcontentloaded');
    await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
    // Let the app paint before delivering the photo, like a slow phone launch.
    const response = page.waitForResponse(response => /\/bg-\d\.jpg$/.test(response.url()));
    release();
    await (await response).finished();
    await page.evaluate(async () => {
      const url = getComputedStyle(document.querySelector('.bg-sharp')!).backgroundImage.slice(5, -2);
      const image = new Image(); image.src = url; await image.decode();
      document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    });
    for (const theme of ['glass-dark', 'glass-light']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      const screenshot = await page.screenshot({ path: info.outputPath(`${pass}-${theme}-loaded.png`), scale: 'css', animations: 'disabled' });
      const result = await page.evaluate(async png => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        const rgb = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
        const middle = rgb(195, 600);
        const edges = [0, 2, 10, 25, 50].flatMap(y => [4, 195, 385].map(x => ({ x, y, rgb: rgb(x, y) })));
        const canvasColor = getComputedStyle(document.documentElement).backgroundColor;
        const statusColor = getComputedStyle(document.querySelector('.ios-status-bar-edge')!).backgroundColor;
        return { middle, edges, canvasColor, statusColor, maximumDifference: Math.max(...edges.flatMap(point => point.rgb.map((value, channel) => Math.abs(value - middle[channel]!)))) };
      }, screenshot.toString('base64'));
      samples.push({ pass, color, theme, ...result });
      await info.attach(`${pass}-${theme}-edge-colors`, { body: JSON.stringify(result), contentType: 'application/json' });
      expect.soft(result.maximumDifference, 'The uniform wallpaper must not pick up a separate dark/tinted top band').toBeLessThanOrEqual(2);
      expect(result.middle.reduce((sum, channel) => sum + channel, 0), 'the photo must have loaded').toBeGreaterThan(150);
      // Desktop WebKit cannot draw the native status bar. Verify the color we
      // supply to it against the independently rendered wallpaper pixels.
      expect(result.statusColor).toBe(result.canvasColor);
      const canvasRgb = result.canvasColor.match(/[\d.]+/g)!.map(Number);
      for (let channel = 0; channel < 3; channel += 1) {
        expect.soft(Math.abs(canvasRgb[channel]! - result.middle[channel]!), 'the system canvas must continue the wallpaper color instead of the card color').toBeLessThanOrEqual(2);
      }
      // Preserve the accepted glass palette: .4 brightness + .2 dark tint,
      // or .9 brightness + .64 white tint. Removing the top band must not
      // lighten/darken the whole wallpaper or make it opaque.
      const source = color.slice(1).match(/../g)!.map(channel => parseInt(channel, 16));
      const expected = source.map((channel, index) => theme === 'glass-dark'
        ? channel * .4 * .8 + [10, 10, 11][index]! * .2
        : channel * .9 * .36 + 255 * .64);
      for (let channel = 0; channel < 3; channel += 1) {
        expect.soft(Math.abs(result.middle[channel]! - expected[channel]!), `${theme} preserves the composed wallpaper color`).toBeLessThanOrEqual(2);
      }
    }
  await info.attach('wallpaper-edge-report', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
});
}
