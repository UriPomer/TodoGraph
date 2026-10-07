import { expect, test, type BrowserContext } from '@playwright/test';
import { addTask } from './support';

test('PRODUCT-SYNC: two device sessions preserve offline conflicts and revoked Pro data', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium');
  let cloud: { payload: string; tag: string } | null = null;
  let sequence = 0;
  let pro = true;
  const calls: Array<{ plugin: string; method: string }> = [];
  const configure = async (context: BrowserContext) => {
    await context.exposeFunction('testNativePromise', async (plugin: string, method: string, options: { payload?: string; expectedTag?: string } = {}) => {
      calls.push({ plugin, method });
      if (plugin === 'ApplePurchases') {
        if (method === 'entitlements') return { plan: pro ? 'pro' : 'free', source: 'storekit', purchaseAvailable: false };
        if (method === 'products') return { products: [] };
      }
      if (plugin === 'AppleCloud') {
        if (method === 'account') return { accountId: 'test-icloud-owner' };
        if (method === 'read') return cloud ?? {};
        if (method === 'write') {
          if (options.expectedTag !== cloud?.tag) throw new Error('server record changed');
          cloud = { payload: options.payload!, tag: String(++sequence) }; return { tag: cloud.tag };
        }
      }
      throw new Error(`Test platform does not implement ${plugin}.${method}`);
    });
    await context.addInitScript(() => {
      const target = window as unknown as Record<string, unknown>;
      target.CapacitorCustomPlatform = { name: 'ios' };
      target.Capacitor = {
        nativePromise: target.testNativePromise,
        PluginHeaders: [
          { name: 'ApplePurchases', methods: ['entitlements', 'products', 'purchase', 'restore'].map(name => ({ name, rtype: 'promise' })) },
          { name: 'AppleCloud', methods: ['account', 'read', 'write'].map(name => ({ name, rtype: 'promise' })) },
        ],
      };
    });
  };
  const first = await browser.newContext(); const second = await browser.newContext();
  try {
    await configure(first); await configure(second);
    const a = await first.newPage(); const b = await second.newPage();
    await a.goto('/');
    await addTask(a, '设备 A 原始任务');
    await a.getByRole('button', { name: '同步设置' }).filter({ visible: true }).first().click();
    await a.getByRole('button', { name: '启用 iCloud 同步', exact: true }).click();
    await expect(a.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
    await a.getByRole('button', { name: '关闭同步设置' }).click();
    await b.goto('/');
    await b.getByRole('button', { name: '同步设置' }).filter({ visible: true }).first().click();
    await b.getByRole('button', { name: '启用 iCloud 同步', exact: true }).click();
    await expect(b.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
    await b.getByRole('button', { name: '关闭同步设置' }).click();
    await expect(b.locator('[data-task-title]').filter({ hasText: '设备 A 原始任务' })).toBeVisible();
    await a.reload();
    await expect(a.getByText('已同步', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await first.setOffline(true);
    await addTask(a, '设备 A 离线修改');
    await addTask(b, '设备 B 联网修改');
    await b.getByRole('button', { name: '同步设置' }).filter({ visible: true }).first().click();
    await b.getByRole('button', { name: '立即同步', exact: true }).click();
    await expect(b.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
    await first.setOffline(false);
    await a.getByRole('button', { name: '同步设置' }).filter({ visible: true }).first().click();
    await expect(a.getByRole('status').filter({ hasText: '同步冲突' })).toBeVisible();
    await a.getByRole('button', { name: '使用 iCloud 版本', exact: true }).click();
    await expect(a.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
    await expect(a.getByRole('button', { name: /^导出 \d/ }).first()).toBeVisible();
    await a.getByRole('button', { name: '关闭同步设置' }).click();
    await expect(a.locator('[data-task-title]').filter({ hasText: '设备 B 联网修改' })).toBeVisible();
    await a.getByRole('button', { name: '新页面', exact: true }).click();
    await a.getByPlaceholder('输入页面名称').fill('付费额外页面');
    await a.getByRole('button', { name: '确定', exact: true }).click();
    await expect(a.locator('[data-task-title]').filter({ hasText: '设备 B 联网修改' })).not.toBeVisible();
    await addTask(a, '降级后保留的额外页面任务');
    await a.waitForTimeout(500);
    pro = false;
    await a.reload();
    await expect(a.getByRole('button', { name: '升级 TodoGraph Pro', exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(a.locator('[data-task-title]').filter({ hasText: '降级后保留的额外页面任务' })).toBeVisible();
    await expect(a.getByRole('textbox', { name: '此页面只读' })).toBeDisabled();
    await a.getByRole('button', { name: '设为免费可编辑页面', exact: true }).click();
    await expect(a.locator('input[placeholder^="新任务"]')).toBeEnabled();
    await addTask(a, '免费切换编辑页成功');
    await testInfo.attach('simulated-apple-sync', { body: JSON.stringify({ boundary: 'StoreKit and CloudKit native bridges simulated; UI, local persistence, conflict recovery and Pro gating real', calls, cloud }), contentType: 'application/json' });
    await a.screenshot({ path: testInfo.outputPath('sync-revoked-pro-preserves-data.png') });
  } finally { await first.close(); await second.close(); }
});
