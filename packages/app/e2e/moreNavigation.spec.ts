import { expect, test } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'Mobile settings and navigation');
  await openIsolatedWorkspace(page, info);
});

test('NAV-007 more separates its settings actions, emphasizes the account, and loads panels on entry', async ({ page }, info) => {
  test.setTimeout(60_000); // Capture the three tabs in all seven themes.
  const reads: string[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && /\/api\/(mcp\/keys|pages\/[^/]+\/backups|trash\/pages)$/.test(new URL(request.url()).pathname)) reads.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
  const layout = await page.locator('[data-more-link]').evaluateAll(entries => entries.map(entry => {
    const rect = entry.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  for (let i = 1; i < layout.length; i += 1) {
    expect(layout[i]!.top - layout[i - 1]!.bottom, 'setting actions have visible background space between them').toBeGreaterThanOrEqual(12);
  }
  const accountSize = await page.locator('.settings-account p').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const titleSize = await page.locator('[data-more-link] > span > span').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(accountSize, 'the account is the primary heading of the content').toBeGreaterThanOrEqual(titleSize * 1.5);
  await info.attach('settings-layout', { body: JSON.stringify({ layout, accountSize, titleSize }), contentType: 'application/json' });
  for (const title of ['账号安全', '备份与恢复', 'AI Agent 接入']) {
    const entry = page.getByRole('button', { name: title, exact: true });
    await expect(entry).toBeVisible();
    const rect = (await entry.boundingBox())!;
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.y + rect.height).toBeLessThan((await page.locator('nav[data-mobile-chrome]').boundingBox())!.y);
  }
  await expect(page.getByPlaceholder('当前密码', { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder('设备名称')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(reads).toEqual([]);
  await page.evaluate(() => document.documentElement.style.setProperty('--bg-url', 'url("/bg-1.jpg")'));
  for (const theme of ['glass-dark', 'glass-light', 'default-dark', 'default-light', 'muted-warm', 'muted-cool', 'muted-dark']) {
    await page.locator('html').evaluate((el, value) => el.setAttribute('data-theme', value), theme);
    for (const [tab, name] of [['list', '任务'], ['graph', '依赖图'], ['more', '更多']] as const) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
      await page.screenshot({ path: info.outputPath(`${tab}-${theme}.png`), scale: 'css', animations: 'disabled' });
    }
  }
  await page.getByRole('button', { name: '账号安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号安全', exact: true })).toBeVisible();
  await page.getByPlaceholder('当前密码', { exact: true }).fill('unsaved-password');
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '账号安全', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '账号安全', exact: true }).click();
  await expect(page.getByPlaceholder('当前密码', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await page.getByRole('button', { name: 'AI Agent 接入', exact: true }).click();
  await expect(page.getByPlaceholder('设备名称')).toBeVisible();
  // React StrictMode cancels its first effect before mounting the live request.
  await expect.poll(() => reads.filter(url => url.includes('/mcp/keys')).length).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('more-ai-panel.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI Agent 接入', exact: true })).toBeFocused();
  expect(reads.filter(url => url.endsWith('/backups') || url.endsWith('/trash/pages'))).toEqual([]);
});

test('NAV-007 small-screen return restores the settings scroll and rapid tab changes keep the last destination', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 340 });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  // Establish the scroll position after the incoming snapshot has settled.
  await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
  const scroller = page.locator('[data-mobile-surface="theme-aware"]');
  await scroller.evaluate(el => { el.scrollTop = 72; });
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '备份与恢复', exact: true }).scrollIntoViewIfNeeded();
  const scroll = await scroller.evaluate(el => el.scrollTop);
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await expect(page.getByRole('heading', { name: '备份与恢复', exact: true })).toBeVisible();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '备份与恢复', exact: true })).toBeVisible();
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(scroll);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('more-small-screen-return.png'), animations: 'disabled' });
  // Dispatch real button events within the same turn, before an animation can finish.
  await page.locator('nav[data-mobile-chrome]').evaluate(nav => {
    for (const name of ['任务', '依赖图', '更多', '任务', '更多']) {
      (nav.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement).click();
    }
  });
  await expect(page.locator('main[data-mobile-tab="more"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '账号安全', exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('main[data-mobile-tab="more"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '返回设置', exact: true })).toHaveCount(0);
});

test('NAV-007 reduced motion and browsers without view transitions retain every navigation action', async ({ page }, info) => {
  for (const reduced of [true, false]) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    if (!reduced) await page.evaluate(() => Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined }));
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: '账号安全', exact: true }).click();
    await expect(page.getByPlaceholder('当前密码', { exact: true })).toBeVisible();
    if (reduced) expect(await page.evaluate(() => document.getAnimations().filter(a =>
      (a.effect as KeyframeEffect)?.getKeyframes().some(frame => 'transform' in frame || 'opacity' in frame),
    ).length)).toBe(0);
    await page.getByRole('button', { name: '返回设置', exact: true }).click();
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前页备份' })).toBeVisible();
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('motion-fallback-list.png'), animations: 'disabled' });
});

test('NAV-007 AI panel retries a failed catalog and cancels a pending load on return', async ({ page }, info) => {
  let fail = true;
  await page.route('**/api/mcp/keys', async route => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法连接' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: 'AI Agent 接入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法连接');
  fail = false;
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(page.getByText('暂无 Key', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mcp/keys', async route => {
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }).catch(() => undefined);
  });
  try {
    await page.getByRole('button', { name: 'AI Agent 接入', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '加载中' })).toBeVisible();
    await page.getByRole('button', { name: '返回设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '账号安全', exact: true })).toBeVisible();
  } finally { release(); }
  await page.waitForTimeout(300);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('more-after-cancelled-request.png'), animations: 'disabled' });
});

test('NAV-007 subpage push and pop animate in opposite directions while bottom navigation stays fixed', async ({ page }, info) => {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
  const navBefore = await page.locator('nav[data-mobile-chrome]').boundingBox();
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    const samples: Array<{ oldX: number; newX: number; animations: string[] }> = [];
    Object.assign(window, { motionSamples: samples });
    document.startViewTransition = (update) => {
      const transition = start(update);
      void transition.ready.then(() => {
        const animations = document.getAnimations().filter(a => a instanceof CSSAnimation && a.animationName.startsWith('workspace-')) as CSSAnimation[];
        for (const animation of animations) { animation.pause(); animation.currentTime = 80; }
        const x = (pseudo: string) => new DOMMatrixReadOnly(getComputedStyle(document.documentElement, pseudo).transform).m41;
        samples.push({ oldX: x('::view-transition-old(workspace-screen)'), newX: x('::view-transition-new(workspace-screen)'), animations: animations.map(a => a.animationName) });
      }).catch(() => undefined);
      return transition;
    };
  });
  const samples = () => page.evaluate(() => (window as unknown as { motionSamples: Array<{ oldX: number; newX: number; animations: string[] }> }).motionSamples);
  const finish = () => page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSAnimation && animation.animationName.startsWith('workspace-')) animation.finish();
    }
  });
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await expect.poll(async () => (await samples()).length).toBe(1);
  const push = (await samples())[0]!;
  expect(push.oldX).toBeLessThan(0);
  expect(push.newX).toBeGreaterThan(0);
  expect(await page.locator('nav[data-mobile-chrome]').boundingBox()).toEqual(navBefore);
  await page.screenshot({ path: info.outputPath('subpage-push-midpoint.png') });
  await finish();
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await expect.poll(async () => (await samples()).length).toBe(2);
  const pop = (await samples())[1]!;
  expect(pop.oldX).toBeGreaterThan(0);
  expect(pop.newX).toBeLessThan(0);
  expect(await page.locator('nav[data-mobile-chrome]').boundingBox()).toEqual(navBefore);
  await page.screenshot({ path: info.outputPath('subpage-pop-midpoint.png') });
  await finish();
  await info.attach('rendered-motion', { body: JSON.stringify(await samples()), contentType: 'application/json' });
});
