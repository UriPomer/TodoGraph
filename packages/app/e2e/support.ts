import { expect, type Page, type TestInfo } from '@playwright/test';

export const E2E_SANDBOX_TITLE = 'E2E 测试沙箱';

export async function openIsolatedWorkspace(page: Page, testInfo: TestInfo, waitUntil: 'load' | 'domcontentloaded' = 'load') {
  const metaResponse = await page.request.get('/api/meta');
  expect(metaResponse.ok()).toBeTruthy();
  const meta = await metaResponse.json() as {
    activePageId: string;
    revision: number;
    pages: Array<{ id: string; title: string; kind?: string; order: number }>;
  };
  const basePage = meta.pages.find((item) => item.title === E2E_SANDBOX_TITLE && item.kind !== 'hierarchy');
  expect(basePage).toBeTruthy();
  if (meta.activePageId !== basePage!.id) {
    const activate = await page.request.patch(`/api/pages/${basePage!.id}`, {
      data: { activate: true, expectedRevision: meta.revision },
    });
    expect(activate.ok(), `activate E2E page returned ${activate.status()}`).toBeTruthy();
  }

  const pageResponse = await page.request.get(`/api/pages/${basePage!.id}`);
  expect(pageResponse.ok()).toBeTruthy();
  const current = await pageResponse.json() as { version: number };
  const fixtureId = `e2e-${testInfo.project.name}-${Date.now()}`;
  const fixtureTitle = `E2E fixture ${testInfo.project.name} ${Date.now()}`;
  const reset = await page.request.put(`/api/pages/${basePage!.id}`, {
    data: {
      nodes: [{ id: fixtureId, title: fixtureTitle, status: 'todo' }],
      edges: [],
      expectedVersion: current.version,
    },
  });
  expect(reset.ok(), `reset E2E page returned ${reset.status()}`).toBeTruthy();
  // Desktop graph measurement persists the fixture's initial dimensions.
  // Wait for that public save before a test reads a version for its own PUT.
  const layoutSaved = testInfo.project.name === 'desktop-chromium' ? page.waitForResponse(response => {
    if (response.request().method() !== 'PUT' || new URL(response.url()).pathname !== `/api/pages/${basePage!.id}` || !response.ok()) return false;
    const data = response.request().postDataJSON() as { nodes: Array<{ id: string; width?: number; height?: number }> };
    return data.nodes.some(node => node.id === fixtureId && (node.width ?? 0) > 0 && (node.height ?? 0) > 0);
  }) : undefined;
  await page.goto('/', { waitUntil });
  await expect(page.locator('input[placeholder^="新任务"]')).toBeVisible();
  await page.locator('.mobile-workspace-shell').evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)),
  );
  await layoutSaved;
}

export async function addTask(page: Page, title: string) {
  const input = page.locator('input[placeholder^="新任务"]');
  await input.fill(title);
  await input.press('Enter');
  const row = taskRow(page, title);
  await expect(row).toBeVisible();
  return row;
}

export function taskRow(page: Page, title: string) {
  return page.locator('[data-task-title]')
    .filter({ hasText: title })
    .first()
    .locator('xpath=ancestor::li[@data-task-id][1]');
}

export function taskStatusButton(row: ReturnType<typeof taskRow>) {
  return row.locator('button[data-status]');
}
