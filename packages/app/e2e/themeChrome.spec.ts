import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { THEMES } from '../src/features/theme/themes';
import { openIsolatedWorkspace } from './support';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

async function selectTheme(page: Page, label: string) {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.locator('[data-mobile-more-header]').getByTitle('切换主题').click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(page.getByRole('menu')).toBeHidden();
}

// Read the browser's composited pixels, independently of the wallpaper sampler.
// A single system color can match the mean edge, not each pixel of a photograph.
async function inspectEdge(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
  const png = await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css', animations: 'disabled' });
  const result = await page.evaluate(async base64 => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const bandHeight = document.documentElement.dataset.appSurface === 'auth' ? 2 : 8;
    const pixels = context.getImageData(1, 0, image.width - 2, bandHeight).data;
    const edge = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) edge[c]! += pixels[i + c]! / (pixels.length / 4);
    }
    const root = document.documentElement;
    const color = getComputedStyle(root).backgroundColor;
    const status = getComputedStyle(document.querySelector('.ios-status-bar-edge')!).backgroundColor;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = document.querySelector('meta[name="theme-color"]')!.getAttribute('content')!;
    context.fillRect(0, 0, 1, 1);
    const meta = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    const rgb = color.match(/[\d.]+/g)!.map(Number);
    return { edge, color, status, meta, maximumDifference: Math.max(...edge.map((v, c) => Math.abs(v - rgb[c]!))),
      metaDifference: Math.max(...meta.map((v, c) => Math.abs(v - rgb[c]!))) };
  }, png.toString('base64'));
  await info.attach(name, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect.soft(result.maximumDifference, `${name}: exported color must match rendered edge`).toBeLessThanOrEqual(3);
  expect.soft(result.status, `${name}: iOS sampling strip must match canvas`).toBe(result.color);
  expect.soft(result.metaDifference, `${name}: browser theme-color must match canvas`).toBe(0);
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'Mobile chrome color contract');
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.setViewportSize({ width: 440, height: 894 });
});

for (let photo = 1; photo <= 6; photo++) {
  test(`NATIVE-104 theme colors match rendered wallpaper ${photo}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    // Route before the first navigation to avoid reusing WebKit's decoded image.
    await page.route('**/bg-*.jpg', route => route.fulfill({ path: path.join(publicDir, `bg-${photo}.jpg`), contentType: 'image/jpeg' }));
    await openIsolatedWorkspace(page, info);
    await expect.poll(() => page.locator('html').evaluate(el => (el as HTMLElement).style.getPropertyValue('--wallpaper-edge-color'))).not.toBe('');
    for (const theme of photo === 1 ? THEMES : THEMES.filter(t => t.id.startsWith('glass'))) {
      await selectTheme(page, theme.label);
      for (const tab of ['任务', '依赖图', '更多']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await inspectEdge(page, info, `photo-${photo}-${theme.id}-${tab}`);
      }
    }
  });
}

test('NATIVE-104 every theme matches its login surface after session exit', async ({ page, context }, info) => {
  // Clear only this isolated browser context; the shared E2E session stays valid.
  await context.clearCookies();
  await page.goto('/');
  for (const theme of THEMES) {
    await page.evaluate(id => localStorage.setItem('todograph.theme', id), theme.id);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-app-surface', 'auth');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await inspectEdge(page, info, `auth-${theme.id}`);
  }
});

test('NATIVE-104 loading and failed wallpaper keep the same solid edge in both glass themes', async ({ page }, info) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/bg-*.jpg', async route => { await pending; await route.abort(); });
  await openIsolatedWorkspace(page, info, 'domcontentloaded');
  for (const theme of THEMES.filter(t => t.id.startsWith('glass'))) {
    await selectTheme(page, theme.label);
    // WebKit screenshot capture waits for pending image loads. Inspect the
    // paint layers while the response is held, then capture the failed state.
    const layers = await page.locator('.bg-sharp, .bg-matte').evaluateAll(elements => elements.map(el => getComputedStyle(el).display));
    expect.soft(layers, `loading-${theme.id}: no tint over the fallback canvas`).toEqual(['none', 'none']);
  }
  release();
  await page.waitForLoadState('load');
  for (const theme of THEMES.filter(t => t.id.startsWith('glass'))) {
    await selectTheme(page, theme.label);
    await inspectEdge(page, info, `failed-${theme.id}`);
  }
});
