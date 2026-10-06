import { expect, test, type Page } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

const photograph = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><path fill="#ee8844" d="M0 0h400v200H0z"/><path fill="#4488ee" d="M0 200h400v600H0z"/></svg>';
const canvasColor = (page: Page) => page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor);

test('NATIVE-103 system canvas follows the visible wallpaper crop and theme, then resets on logout', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'Mobile wallpaper chrome');
  await page.route('**/bg-*.jpg', route => route.fulfill({ contentType: 'image/svg+xml', body: photograph }));
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await openIsolatedWorkspace(page, info);
  const report = [];
  for (const [width, height, source] of [[390, 844, [238, 136, 68]], [700, 390, [68, 136, 238]], [390, 844, [238, 136, 68]]] as const) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: '更多', exact: true }).click();
    for (const [theme, label] of [['glass-dark', '玻璃·深色'], ['glass-light', '玻璃·浅色']] as const) {
      await page.locator('[data-mobile-more-header]').getByTitle('切换主题').click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await expect(page.getByRole('menu')).toBeHidden();
      const expected = source.map((channel, i) => Math.round(theme === 'glass-dark' ? channel * .32 + [10, 10, 11][i]! * .2 : channel * .324 + 255 * .64));
      await expect.poll(async () => {
        const rgb = (await canvasColor(page)).match(/[\d.]+/g)!.map(Number);
        return Math.max(...expected.map((channel, i) => Math.abs(channel - rgb[i]!)));
      }).toBeLessThanOrEqual(2);
      const color = await canvasColor(page);
      await expect(page.locator('.ios-status-bar-edge')).toHaveCSS('background-color', color);
      await expect(page.locator('.ios-status-bar-edge')).toHaveCSS('display', 'block');
      report.push({ width, height, theme, expected, color });
      await page.screenshot({ path: info.outputPath(`${width}-${theme}.png`), animations: 'disabled' });
    }
  }
  await page.locator('[data-mobile-more-header]').getByTitle('切换主题').click();
  await page.getByRole('menuitem', { name: '经典·深色', exact: true }).click();
  await expect(page.getByRole('menu')).toBeHidden();
  const solidColor = await canvasColor(page);
  await expect(page.locator('.ios-status-bar-edge')).toHaveCSS('background-color', solidColor);
  expect(solidColor).not.toBe(report.at(-1)!.color);
  await page.locator('[data-mobile-more-header]').getByTitle('切换主题').click();
  await page.getByRole('menuitem', { name: '玻璃·深色', exact: true }).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-app-surface', 'auth');
  await expect.poll(() => canvasColor(page)).toBe('rgb(30, 29, 32)');
  await expect(page.locator('.bg-sharp')).toBeHidden();
  await info.attach('wallpaper-canvas-lifecycle', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});

test('NATIVE-103 unavailable wallpaper keeps a usable theme canvas', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'Mobile wallpaper chrome');
  await page.route('**/bg-*.jpg', route => route.abort());
  await openIsolatedWorkspace(page, info);
  await expect.poll(() => canvasColor(page)).toBe('rgb(30, 29, 32)');
  await expect(page.getByRole('button', { name: '更多', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('unavailable-wallpaper.png'), animations: 'disabled' });
});
