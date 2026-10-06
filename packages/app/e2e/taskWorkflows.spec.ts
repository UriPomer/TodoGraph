import { expect, test } from '@playwright/test';
import { addTask, openIsolatedWorkspace, taskRow, taskStatusButton } from './support';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  await openIsolatedWorkspace(page, testInfo);
});

test('GEST-012/GEST-013 desktop task editing, child completion, persistence, and delete undo work through the UI', async ({ page }, testInfo) => {
  const originalTitle = `端到端父任务 ${Date.now()}`;
  const editedTitle = `${originalTitle} 已编辑`;
  const childTitle = `端到端子任务 ${Date.now()}`;
  const parent = await addTask(page, originalTitle);
  const parentId = await parent.getAttribute('data-task-id');
  expect(parentId).toBeTruthy();
  const stableParent = page.locator(`[data-task-id="${parentId}"]`);

  await stableParent.locator('[data-task-title]').dblclick();
  const titleInput = stableParent.locator('input');
  await expect(titleInput).toBeFocused();
  await titleInput.fill(editedTitle);
  await titleInput.press('Enter');

  const editedParent = stableParent;
  await editedParent.locator('[data-task-action="description"]').click();
  const description = '任务描述由真实页面输入并持久化';
  await editedParent.getByPlaceholder('添加描述...').fill(`  ${description}  `);
  await editedParent.locator('[data-task-action="description"]').click();

  await editedParent.getByTitle('添加子任务').click();
  await editedParent.getByPlaceholder('输入子任务名称…').fill(childTitle);
  await editedParent.getByPlaceholder('输入子任务名称…').press('Enter');
  const child = taskRow(page, childTitle);

  const parentStatus = taskStatusButton(editedParent);
  await parentStatus.click();
  await parentStatus.click();
  await page.getByRole('menuitem', { name: '标记完成', exact: true }).click();
  await expect(page.getByText('无法完成')).toBeVisible();

  const childStatus = taskStatusButton(child);
  await childStatus.click();
  await childStatus.click();
  await page.getByRole('menuitem', { name: '标记完成', exact: true }).click();
  await parentStatus.click();
  await page.getByRole('menuitem', { name: '标记完成', exact: true }).click();

  const disposableTitle = `端到端待删除任务 ${Date.now()}`;
  const disposable = await addTask(page, disposableTitle);
  await disposable.locator('button[title="删除"]').click();
  await page.getByRole('button', { name: '确定' }).click();
  await expect(taskRow(page, disposableTitle)).toHaveCount(0);
  await page.getByRole('button', { name: '撤销' }).last().click();
  await expect(taskRow(page, disposableTitle)).toBeVisible();

  const metaResponse = await page.request.get('/api/meta');
  const meta = await metaResponse.json() as { activePageId: string };
  await expect.poll(async () => {
    const response = await page.request.get(`/api/pages/${meta.activePageId}`);
    const data = await response.json() as { nodes: Array<{ id: string; title: string; status: string; description?: string; parentId?: string }> };
    const persistedParent = data.nodes.find((node) => node.title === editedTitle);
    const persistedChild = data.nodes.find((node) => node.title === childTitle);
    return Boolean(
      persistedParent?.status === 'done'
      && persistedParent.description === description
      && persistedChild?.parentId === persistedParent.id
      && data.nodes.some((node) => node.title === disposableTitle),
    );
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-task-workflow.png'), fullPage: true });
});

test('GEST-005 desktop row drag reorders tasks and persists the new order', async ({ page }) => {
  const firstTitle = `端到端拖动前 ${Date.now()}`;
  const secondTitle = `端到端拖动后 ${Date.now()}`;
  const first = await addTask(page, firstTitle);
  const second = await addTask(page, secondTitle);
  const source = first.locator('[data-task-drag-surface]');
  const sourceBox = await source.boundingBox();
  const targetBox = await second.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  const startX = sourceBox!.x + Math.min(8, sourceBox!.width / 2);
  const startY = sourceBox!.y + sourceBox!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 28, startY + 2, { steps: 3 });
  await page.mouse.move(targetBox!.x + 32, targetBox!.y + targetBox!.height - 3, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => {
    const rows = await page.locator('[data-mobile-task-section="ready"] [data-task-title]').allTextContents();
    return rows.indexOf(secondTitle) < rows.indexOf(firstTitle);
  }).toBe(true);
  const metaResponse = await page.request.get('/api/meta');
  const meta = await metaResponse.json() as { activePageId: string };
  await expect.poll(async () => {
    const response = await page.request.get(`/api/pages/${meta.activePageId}`);
    const data = await response.json() as { nodes: Array<{ title: string }> };
    const firstIndex = data.nodes.findIndex((node) => node.title === firstTitle);
    const secondIndex = data.nodes.findIndex((node) => node.title === secondTitle);
    return firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex;
  }).toBe(true);
});

test('GEST-002 desktop drag cancels when its pointer capture is lost', async ({ page }, testInfo) => {
  const row = await addTask(page, `桌面失去捕获 ${Date.now()}`);
  const surface = row.locator('[data-task-drag-surface]');
  const box = await surface.boundingBox();
  const point = { x: box!.x + 8, y: box!.y + box!.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 2);
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toBeVisible();
  await surface.evaluate((element) => element.releasePointerCapture(1));
  // The browser processes pending capture changes before the next pointer event.
  await page.mouse.move(point.x + 32, point.y + 2);
  await expect(page.locator('.fixed.pointer-events-none.z-50')).toHaveCount(0);
  await expect(row).not.toHaveClass(/opacity-25/);
  await page.mouse.up();
  await page.screenshot({ path: testInfo.outputPath('desktop-drag-capture-cleanup.png'), fullPage: true });
});

test('DROP-001/DROP-002 desktop drag nests and then moves a child to a root sibling, preserving hierarchy after reload', async ({ page }, info) => {
  const parent = await addTask(page, `拖入父任务 ${Date.now()}`);
  const sibling = await addTask(page, `根级锚点 ${Date.now()}`);
  const moving = await addTask(page, `跨层移动 ${Date.now()}`);
  const parentId = (await parent.getAttribute('data-task-id'))!;
  const movingId = (await moving.getAttribute('data-task-id'))!;
  const row = page.locator(`[data-task-id="${movingId}"]`);
  const meta = await (await page.request.get('/api/meta')).json();
  const savedPage = async () => (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
  const dragTo = async (target: typeof row, ratio: number) => {
    await row.locator('[data-task-title]').click({ trial: true });
    const sourceBox = (await row.locator('[data-task-drag-surface]').boundingBox())!;
    const targetBox = (await target.locator('[data-task-drag-surface]').boundingBox())!;
    const x = sourceBox.x + 8;
    const y = sourceBox.y + sourceBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 28, y + 2, { steps: 3 });
    await page.mouse.move(targetBox.x + 32, targetBox.y + targetBox.height * ratio, { steps: 5 });
    await page.mouse.up();
  };
  await dragTo(parent, 0.5);
  await expect.poll(async () => (await savedPage()).nodes.find((node: { id: string }) => node.id === movingId)?.parentId).toBe(parentId);
  await dragTo(sibling, 0.9);
  await expect.poll(async () => {
    const node = (await savedPage()).nodes.find((node: { id: string }) => node.id === movingId);
    return Boolean(node && !node.parentId);
  }).toBe(true);
  await page.reload();
  await expect(row.locator('[data-task-title]')).toBeVisible();
  const data = await savedPage();
  expect(data.nodes.find((node: { id: string }) => node.id === movingId).parentId).toBeUndefined();
  await info.attach('persisted-hierarchy', { body: JSON.stringify(data), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('desktop-hierarchy-move.png') });
});

test('DROP-005 undo and redo exchange exactly one snapshot per operation and a new edit clears redo', async ({ page }, info) => {
  const firstTitle = `撤销重做 A ${Date.now()}`;
  const secondTitle = `撤销重做 B ${Date.now()}`;
  await addTask(page, firstTitle);
  await addTask(page, secondTitle);
  const undo = page.getByTitle('撤销 (⌘Z)', { exact: true });
  const redo = page.getByTitle('重做 (⌘⇧Z / ⌘Y)', { exact: true });
  const first = taskRow(page, firstTitle);
  const second = taskRow(page, secondTitle);
  await undo.click();
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  await undo.click();
  await expect(first).toHaveCount(0);
  await redo.click();
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  await redo.click();
  await expect(second).toBeVisible();
  await expect(redo).toBeDisabled();
  await undo.click();
  await addTask(page, `新分支 ${Date.now()}`);
  await expect(redo).toBeDisabled();
  const meta = await (await page.request.get('/api/meta')).json();
  await expect.poll(async () => {
    const data = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
    return data.nodes.some((node: { title: string }) => node.title === firstTitle)
      && !data.nodes.some((node: { title: string }) => node.title === secondTitle);
  }).toBe(true);
  await page.screenshot({ path: info.outputPath('history-one-step.png') });
});

test('GEST-012 multiline graph titles retain their frame during editing and share list commit and cancel behavior', async ({ page }, info) => {
  const row = page.locator('[data-task-id]').first();
  const id = await row.getAttribute('data-task-id');
  const original = await row.locator('[data-task-title]').innerText();
  const graphNode = page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(page.locator('.graph-viewport-restoring')).toHaveCount(0);
  const graphTitle = graphNode.getByTitle('双击编辑标题');
  await graphTitle.dblclick();
  await expect(graphNode.locator('input')).toBeFocused();
  await graphNode.locator('input').fill('cancelled graph draft');
  await graphNode.locator('input').press('Escape');
  await expect(row.locator('[data-task-title]')).toHaveText(original);
  await graphTitle.dblclick();
  await graphNode.locator('input').fill('');
  await graphNode.locator('input').press('Enter');
  await expect(row.locator('[data-task-title]')).toHaveText(original);
  await graphTitle.dblclick();
  await graphNode.locator('input').fill('saved from graph');
  await graphNode.locator('input').press('Enter');
  await expect(row.locator('[data-task-title]')).toHaveText('saved from graph');
  await row.locator('[data-task-title]').dblclick();
  await row.locator('input').fill('saved on blur from list');
  await graphTitle.click();
  await expect(graphTitle).toHaveText('saved on blur from list');
  const meta = await (await page.request.get('/api/meta')).json();
  await expect.poll(async () => {
    const data = await (await page.request.get(`/api/pages/${meta.activePageId}`)).json();
    return data.nodes.find((node: { id: string }) => node.id === id)?.title;
  }).toBe('saved on blur from list');
  await page.screenshot({ path: info.outputPath('shared-title-editor.png') });
});
