import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { openIsolatedWorkspace } from './support';

test.beforeEach(({}, info) => test.skip(info.project.name === 'desktop-chromium', 'Mobile chrome geometry'));

async function openPhone(page: Page, info: TestInfo, standalone: boolean, outside: number, top = 0, bottom = 34) {
  await page.setViewportSize({ width: 440, height: 894 });
  // Browser automation cannot render Apple's status bar. Reproduce the measured
  // screen/viewport boundary; it must never make the bottom bar taller.
  await page.addInitScript(({ standalone, outside }) => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: standalone });
    Object.defineProperty(screen, 'width', { configurable: true, value: 440 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 894 + outside });
  }, { standalone, outside });
  await openIsolatedWorkspace(page, info);
  await page.evaluate(({ top, bottom }) => {
    document.documentElement.style.setProperty('--safe-area-inset-top', `${top}px`);
    document.documentElement.style.setProperty('--safe-area-inset-bottom', `${bottom}px`);
  }, { top, bottom });
}

async function geometry(page: Page) {
  await expect.poll(() => page.locator('html').getAttribute('data-workspace-motion')).toBeNull();
  return page.evaluate(() => {
    const toolbar = Array.from(document.querySelectorAll<HTMLElement>('.mobile-top-chrome')).find(el => el.offsetHeight)!;
    const nav = document.querySelector<HTMLElement>('nav[data-mobile-chrome]')!;
    const main = document.querySelector<HTMLElement>('main[data-mobile-tab]')!;
    const rect = toolbar.getBoundingClientRect();
    const bottom = nav.getBoundingClientRect();
    const input = main.querySelector<HTMLInputElement>('input[placeholder^="新任务"]');
    const heading = main.querySelector<HTMLElement>('[data-mobile-task-section="ready"] h3');
    const firstTask = main.querySelector<HTMLElement>('[data-mobile-task-section="ready"] [data-task-id]');
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height, bottom: rect.bottom };
    };
    return {
      top: rect.height, topY: rect.y, bottom: bottom.height, bottomY: bottom.y, bottomEdge: bottom.bottom,
      contentY: main.getBoundingClientRect().y, contentBottom: main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom),
      navControls: Array.from(nav.querySelectorAll('button')).map(el => {
        const box = el.getBoundingClientRect();
        return { height: box.height, bottom: box.bottom };
      }),
      controls: Array.from(toolbar.querySelectorAll('button')).map(el => {
        const box = el.getBoundingClientRect();
        return { y: box.y, height: box.height, bottom: box.bottom, width: box.width, right: box.right };
      }),
      list: input && heading && firstTask ? { input: box(input), heading: box(heading), firstTask: box(firstTask) } : null,
    };
  });
}

for (const scenario of [
  { name: 'iOS excluded status area', standalone: true, outside: 62, safeTop: 0, safeBottom: 34 },
  { name: 'iOS full viewport safe area', standalone: true, outside: 0, safeTop: 59, safeBottom: 34 },
  { name: 'ordinary browser with browser chrome', standalone: false, outside: 100, safeTop: 0, safeBottom: 0 },
]) {
  test(`NATIVE-105 status color extension and reduced space below navigation: ${scenario.name}`, async ({ page }, info) => {
    await openPhone(page, info, scenario.standalone, scenario.outside, scenario.safeTop, scenario.safeBottom);
    const external = scenario.standalone ? scenario.outside : 0;
    const measurements = [];
    for (const tab of ['任务', '依赖图', '更多', '备份与恢复']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      const measured = await geometry(page);
      expect(measured.topY).toBe(0);
      const bottomSpace = Math.max(0, scenario.safeBottom - 8);
      expect(measured.bottom).toBeCloseTo(55.5 + bottomSpace, 1);
      const toolbarHeight = tab === '备份与恢复' ? 68 : tab === '更多' ? 56 : 60;
      expect(measured.top - scenario.safeTop).toBeCloseTo(toolbarHeight, 1);
      expect(measured.contentY).toBeCloseTo(measured.top, 0);
      expect(Math.abs(measured.contentBottom - measured.bottomY)).toBeLessThanOrEqual(1);
      expect(measured.bottomEdge).toBe(894);
      for (const control of measured.navControls) {
        expect(control.height).toBeGreaterThanOrEqual(44);
        expect(control.height).toBeCloseTo(54.5, 1);
        expect(control.bottom).toBeCloseTo(894 - bottomSpace, 1);
      }
      for (const control of measured.controls) {
        expect(control.height).toBe(tab === '任务' || tab === '依赖图' ? 36 : (control === measured.controls[0] && tab === '备份与恢复' ? 44 : 32));
        expect(control.y).toBeCloseTo(scenario.safeTop + 16 + (44 - control.height) / 2 * Number(tab === '备份与恢复'), 1);
        expect(control.bottom).toBeLessThanOrEqual(measured.top);
        expect(control.right).toBeLessThanOrEqual(440);
      }
      if (tab === '任务') {
        expect(measured.list).not.toBeNull();
        const list = measured.list!;
        // Both former 20px gaps shrink to 12px, so input, heading and tasks
        // follow one continuous layout instead of moving only the toolbar.
        expect(list.input.y - Math.max(...measured.controls.map(control => control.bottom))).toBeCloseTo(12, 1);
        expect(list.heading.y - list.input.bottom).toBeCloseTo(12, 1);
        expect(list.firstTask.y - list.heading.bottom).toBeCloseTo(4, 1);
        expect(list.input.height).toBe(32);
        expect(list.heading.height).toBe(28);
        expect(list.firstTask.height).toBeGreaterThanOrEqual(44);
      }
      measurements.push({ tab, external, ...measured });
      await page.screenshot({ path: info.outputPath(`${scenario.name}-${tab}.png`), animations: 'disabled' });
    }
    await info.attach('physical-chrome-measurements', { body: JSON.stringify(measurements), contentType: 'application/json' });
  });
}

test('NATIVE-101/NATIVE-105 keyboard, zoom and rotation preserve usable chrome', async ({ page }, info) => {
  await openPhone(page, info, true, 62);
  const initial = await geometry(page);
  const input = page.locator('input[placeholder^="新任务"]');
  await input.focus();
  await page.setViewportSize({ width: 440, height: 594 });
  await expect.poll(async () => (await geometry(page)).top).toBe(initial.top);
  await input.blur();
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await expect.poll(async () => (await geometry(page)).bottom).toBe(initial.bottom);
  await page.setViewportSize({ width: 440, height: 894 });
  await expect.poll(async () => (await geometry(page)).bottom).toBe(initial.bottom);

  // Pinch zoom and visual keyboard movement alter the visual viewport, not
  // status-bar geometry. Existing keyboard handling must still hide the nav.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport!, 'scale', { configurable: true, value: 2 });
    Object.defineProperty(visualViewport!, 'height', { configurable: true, value: 700 });
    visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('nav[data-mobile-chrome]')).toBeHidden();
  await expect(page.locator('.mobile-top-chrome:visible')).toHaveCSS('height', `${initial.top}px`);
  await page.evaluate(() => {
    Reflect.deleteProperty(visualViewport!, 'scale');
    Reflect.deleteProperty(visualViewport!, 'height');
    visualViewport!.dispatchEvent(new Event('resize'));
    Object.defineProperty(screen, 'width', { configurable: true, value: 700 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 440 });
  });
  await page.setViewportSize({ width: 700, height: 440 });
  await expect.poll(async () => {
    const measured = await geometry(page);
    return { top: measured.top, bottom: measured.bottom };
  }).toEqual({ top: 60, bottom: 81.5 });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '备份与恢复' }).click();
  await expect(page.getByRole('button', { name: '返回设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回设置', exact: true }).click();
  await page.screenshot({ path: info.outputPath('rotated-chrome.png'), animations: 'disabled' });
});
