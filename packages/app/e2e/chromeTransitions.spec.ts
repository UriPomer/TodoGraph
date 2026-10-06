import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { THEMES } from '../src/features/theme/themes';
import { openIsolatedWorkspace } from './support';

async function inspectSeam(page: Page, info: TestInfo, name: string) {
  const png = await page.screenshot({ path: info.outputPath(`${name}.png`), scale: 'css' });
  const result = await page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, 8).data;
    const color = getComputedStyle(document.documentElement).backgroundColor;
    const rgb = color.match(/[\d.]+/g)!.map(Number);
    let maximum = 0;
    for (let index = 0; index < pixels.length; index++) {
      if (index % 4 !== 3) maximum = Math.max(maximum, Math.abs(pixels[index]! - rgb[index % 4]!));
    }
    return { color, maximum, themeColor: document.querySelector('meta[name="theme-color"]')!.getAttribute('content') };
  }, png.toString('base64'));
  await info.attach(name, { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.themeColor).toBe(result.color);
  expect(result.maximum, `${name}: every pixel across the status extension must retain the current system color`).toBeLessThanOrEqual(2);
}

for (const fallback of [false, true]) {
  test(`NATIVE-105 status seam stays continuous during page and theme changes (${fallback ? 'fallback' : 'view transition'})`, async ({ page }, info) => {
    test.skip(info.project.name === 'desktop-chromium', 'Mobile chrome');
    test.setTimeout(90_000);
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await page.setViewportSize({ width: 440, height: 894 });
    await openIsolatedWorkspace(page, info);
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px'));
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
    await page.evaluate(fallback => {
      const freeze = () => {
        const animations = document.getAnimations().filter(animation => {
          const target = (animation.effect as KeyframeEffect)?.target;
          return animation instanceof CSSAnimation ? animation.animationName.startsWith('workspace-')
            : target instanceof Element && target.matches('[data-workspace-screen]');
        });
        for (const animation of animations) { animation.pause(); animation.currentTime = 80; }
        Object.assign(window, { frozenChromeAnimations: animations });
      };
      if (fallback) {
        Object.defineProperty(document, 'startViewTransition', { value: undefined, configurable: true });
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          const animation = animate.apply(this, args);
          if (this.matches('[data-workspace-screen]')) queueMicrotask(freeze);
          return animation;
        };
      } else {
        const start = document.startViewTransition.bind(document);
        document.startViewTransition = update => {
          const transition = start(update);
          void transition.ready.then(freeze);
          return transition;
        };
      }
    }, fallback);
    const finish = async () => {
      await page.evaluate(() => {
        for (const animation of (window as unknown as { frozenChromeAnimations: Animation[] }).frozenChromeAnimations) animation.finish();
        Object.assign(window, { frozenChromeAnimations: [] });
      });
      await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
    };
    for (const theme of THEMES) {
      await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { frozenChromeAnimations?: Animation[] }).frozenChromeAnimations?.length ?? 0)).toBeGreaterThan(0);
      await inspectSeam(page, info, `${theme.id}-push`);
      // A frozen snapshot suppresses hit testing of its live descendants.
      // Activate the public menu events without waiting for that snapshot to end.
      await page.locator('[data-mobile-more-header]').getByTitle('切换主题').dispatchEvent('pointerdown', { button: 0, ctrlKey: false, pointerType: 'mouse' });
      await page.getByRole('menuitem', { name: theme.label, exact: true }).dispatchEvent('click');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
      await inspectSeam(page, info, `${theme.id}-theme-during-push`);
      await finish();
      await page.getByRole('button', { name: '返回设置', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { frozenChromeAnimations: Animation[] }).frozenChromeAnimations.length)).toBeGreaterThan(0);
      await inspectSeam(page, info, `${theme.id}-pop`);
      await finish();
    }
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { frozenChromeAnimations: Animation[] }).frozenChromeAnimations.length)).toBeGreaterThan(0);
    await inspectSeam(page, info, 'tab-switch');
    await finish();
  });
}
