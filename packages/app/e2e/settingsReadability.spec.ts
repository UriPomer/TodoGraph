import { expect, test, type Page } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

const detailBackground = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><path fill="white" d="M0 0h4v8H0z"/><path fill="black" d="M4 0h4v8H4z"/></pattern></defs><path fill="url(#p)" d="M0 0h390v844H0z"/></svg>').toString('base64')}`;

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'Mobile settings surfaces');
  await openIsolatedWorkspace(page, info);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
});

async function background(page: Page, theme: string, source: string) {
  await page.evaluate(async ({ theme, source }) => {
    const image = new Image(); image.src = source; await image.decode();
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.setProperty('--bg-url', `url("${source}")`);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }, { theme, source });
}

async function textContrast(page: Page) {
  const selector = '[data-mobile-more-header] h2, .settings-account p, .settings-account-status, [data-more-link] > span:nth-child(2) > span, .settings-intro, .settings-content label, .settings-content h3';
  const labels = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    const color = getComputedStyle(element).color;
    const label = element.textContent;
    (element as HTMLElement).style.color = 'transparent';
    return { label, color, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  const png = (await page.screenshot({ scale: 'css', animations: 'disabled' })).toString('base64');
  await page.locator(selector).evaluateAll(elements => elements.forEach(element => (element as HTMLElement).style.removeProperty('color')));
  return page.evaluate(async ({ png, labels }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const luminance = (rgb: number[]) => rgb.reduce((sum, value, i) => {
      const c = value / 255;
      return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]!;
    }, 0);
    return labels.map(label => {
      const [r, g, b, alpha = 1] = label.color.match(/[\d.]+/g)!.map(Number);
      let minimum = Infinity;
      for (let y = Math.ceil(label.y + 2); y < Math.min(canvas.height, label.y + label.height - 2); y += 3) {
        for (let x = Math.ceil(label.x + 2); x < Math.min(canvas.width, label.x + label.width - 2); x += 3) {
          const index = (y * canvas.width + x) * 4;
          const bg = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
          const fg = [r!, g!, b!].map((c, i) => c * alpha! + bg[i]! * (1 - alpha!));
          const a = luminance(bg), bLum = luminance(fg);
          minimum = Math.min(minimum, (Math.max(a, bLum) + .05) / (Math.min(a, bLum) + .05));
        }
      }
      return { label: label.label, minimum };
    });
  }, { png, labels });
}

test('NAV-007 settings text stays readable against the rendered glass background', async ({ page }, info) => {
  test.setTimeout(60_000); // Twelve backgrounds plus six subpage captures.
  const report = [];
  for (const theme of ['glass-dark', 'glass-light']) {
    for (const photo of [1, 2, 3, 4, 5, 6]) {
      await background(page, theme, `/bg-${photo}.jpg`);
      await page.screenshot({ path: info.outputPath(`more-${theme}-bg-${photo}.png`), scale: 'css', animations: 'disabled' });
      const contrast = await textContrast(page);
      report.push({ theme, photo, contrast });
      for (const item of contrast) expect.soft(item.minimum, `${theme} bg-${photo} ${item.label}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [panel, title] of [['security', '账号安全'], ['backups', '备份与恢复'], ['mcp', 'AI Agent 接入']] as const) {
      await page.getByRole('button', { name: title, exact: true }).click();
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
      await page.screenshot({ path: info.outputPath(`${panel}-${theme}.png`), scale: 'css', animations: 'disabled' });
      const contrast = await textContrast(page);
      report.push({ theme, page: panel, contrast });
      for (const item of contrast) expect.soft(item.minimum, `${theme} ${panel} ${item.label}`).toBeGreaterThanOrEqual(4.5);
      await page.getByRole('button', { name: '返回设置', exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
    }
  }
  await info.attach('rendered-text-contrast', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});

test('NAV-007 mobile backdrop actually blurs image detail', async ({ page }, info) => {
  await background(page, 'glass-dark', detailBackground);
  const screenshot = await page.screenshot({ path: info.outputPath('blurred-detail.png'), scale: 'css', animations: 'disabled' });
  const range = await page.evaluate(async png => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(32, 680, 320, 1).data;
    const red = Array.from(pixels).filter((_, i) => i % 4 === 0);
    return Math.max(...red) - Math.min(...red);
  }, screenshot.toString('base64'));
  await info.attach('background-detail-range', { body: JSON.stringify({ range }), contentType: 'application/json' });
  expect(range, 'sharp stripes must disappear into the frosted backdrop').toBeLessThan(8);
});

test('NAV-007 settings surfaces transmit detail without adding their own frosting', async ({ page }, info) => {
  // Expose sharp detail to distinguish local frosting from the shared wallpaper
  // blur, which the previous test verifies independently.
  await background(page, 'glass-dark', detailBackground);
  await page.addStyleTag({ content: '.bg-sharp { filter: brightness(.4) !important; }' });
  const menu = (await page.locator('[data-more-link]').first().boundingBox())!;
  const cardPng = await page.screenshot({ path: info.outputPath('settings-without-local-frost.png'), scale: 'css', animations: 'disabled' });
  const detail = await page.evaluate(async ({ png, menu }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const variation = (y: number) => {
      const pixels = ctx.getImageData(Math.ceil(menu.x + 24), Math.round(y), Math.floor(menu.width - 48), 1).data;
      const red = Array.from(pixels).filter((_, i) => i % 4 === 0);
      return Math.max(...red) - Math.min(...red);
    };
    return { outside: variation(680), inside: variation(menu.y + 8) };
  }, { png: cardPng.toString('base64'), menu });
  await info.attach('card-detail-range', { body: JSON.stringify(detail), contentType: 'application/json' });
  expect(detail.outside, 'the custom background fixture must have visible detail').toBeGreaterThan(50);
  expect.soft(detail.inside, 'settings must preserve background detail, not frost it again').toBeGreaterThan(40);
  for (const theme of ['glass-dark', 'glass-light']) {
    await background(page, theme, '/bg-1.jpg');
    for (const panel of ['更多', '账号安全', '备份与恢复', 'AI Agent 接入']) {
      if (panel !== '更多') await page.getByRole('button', { name: panel, exact: true }).click();
      await expect(page.getByRole('heading', { name: panel, exact: true })).toBeVisible();
      const effects = await page.locator('[data-more-link], .settings-content section:not(.settings-menu)').evaluateAll(surfaces => surfaces.map(surface => {
        const style = getComputedStyle(surface);
        return { backdrop: style.backdropFilter, webkit: style.getPropertyValue('-webkit-backdrop-filter'),
          background: style.backgroundColor, shadow: style.boxShadow, borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth };
      }));
      expect(effects.length).toBeGreaterThan(0);
      expect.soft(effects.every(effect => effect.backdrop === 'none' && ['', 'none'].includes(effect.webkit)), `${theme} ${panel} must not add local frosting`).toBe(true);
      expect.soft(effects.every(effect => effect.background === 'rgba(0, 0, 0, 0)' && effect.shadow === 'none'
        && effect.borderLeft === '0px' && effect.borderRight === '0px'), `${theme} ${panel} must use open rows and sections, without card enclosures`).toBe(true);
      if (panel !== '更多') await page.getByRole('button', { name: '返回设置', exact: true }).click();
    }
  }
});

test('NAV-007 glass content visibly transmits each background without a dark slab', async ({ page }, info) => {
  const report = [];
  for (const theme of ['glass-dark', 'glass-light']) {
    const surfaces: number[][] = [];
    for (const photo of [1, 2, 3, 4, 5, 6]) {
      await background(page, theme, `/bg-${photo}.jpg`);
      const menu = (await page.locator('[data-more-link]').first().boundingBox())!;
      const png = await page.screenshot({ path: info.outputPath(`${theme}-layers-bg-${photo}.png`), scale: 'css', animations: 'disabled' });
      const tones = await page.evaluate(async ({ png, menu }) => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        const pixel = (x: number, y: number) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
        return { surface: pixel(menu.x + menu.width / 2, menu.y + 8), surrounding: pixel(menu.x + menu.width / 2, menu.y - 8) };
      }, { png: png.toString('base64'), menu });
      surfaces.push(tones.surface);
      report.push({ theme, photo, ...tones });
      const mean = (rgb: number[]) => rgb.reduce((a, b) => a + b) / 3;
      expect.soft(mean(tones.surface) - mean(tones.surrounding), `${theme} bg-${photo}: glass must not become a dark slab`).toBeGreaterThan(-12);
    }
    const colorRange = Math.max(...[0, 1, 2].map(channel => Math.max(...surfaces.map(rgb => rgb[channel]!)) - Math.min(...surfaces.map(rgb => rgb[channel]!))));
    expect(colorRange, `${theme}: changing the background must visibly recolor the content surface`).toBeGreaterThan(18);
  }
  await info.attach('rendered-surface-hierarchy', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
});
