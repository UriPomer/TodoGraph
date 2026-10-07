import { expect, test, type BrowserContext } from '@playwright/test';
import { addTask } from './support';

test('PRODUCT-WEB-CLOUD: CloudKit JS uploads assets and downloads the same workspace on another browser', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop-chromium');
  let payload = ''; let tag = 0;
  const configure = async (context: BrowserContext) => {
    await context.exposeFunction('testEntitlements', async () => ({ plan: 'pro', source: 'storekit', purchaseAvailable: false }));
    await context.exposeFunction('testCloudRead', async () => payload ? { records: [{ recordName: 'todograph-workspace', recordType: 'TodoGraphWorkspace', recordChangeTag: String(tag), fields: { workspaceFile: { value: { downloadURL: 'http://127.0.0.1:5184/__e2e_cloud_asset' } } } }] } : { errors: [{ ckErrorCode: 'UNKNOWN_ITEM' }] });
    await context.exposeFunction('testCloudWrite', async (next: string, expected?: string) => {
      if (expected !== (tag ? String(tag) : undefined)) throw new Error('CloudKit record changed');
      payload = next; tag += 1;
      return { records: [{ recordChangeTag: String(tag) }] };
    });
    await context.route('**/__e2e_cloud_asset', route => route.fulfill({ body: payload, contentType: 'application/json' }));
    await context.addInitScript(() => {
      const target = window as unknown as { testEntitlements: () => Promise<unknown>; testCloudRead: () => Promise<unknown>; testCloudWrite: (payload: string, tag?: string) => Promise<unknown> } & Record<string, unknown>;
      // Only the paid entitlement is simulated natively; every cloud call uses the web adapter.
      target.CapacitorCustomPlatform = { name: 'ios' };
      target.Capacitor = { nativePromise: target.testEntitlements, PluginHeaders: [{ name: 'ApplePurchases', methods: [{ name: 'entitlements', rtype: 'promise' }] }] };
      target.CloudKit = {
        configure: () => {}, getDefaultContainer: () => ({
          setUpAuth: async () => ({ userRecordName: 'same-test-apple-account' }),
          privateCloudDatabase: {
            fetchRecords: target.testCloudRead,
            saveRecords: async (records: Array<{ recordChangeTag?: string; fields: { workspaceFile: { value: Blob } } }>) => {
              const record = records[0];
              if (!record) throw new Error('No CloudKit record');
              if (!(record.fields.workspaceFile.value instanceof Blob)) throw new Error('Expected a CloudKit Asset Blob');
              return target.testCloudWrite(await record.fields.workspaceFile.value.text(), record.recordChangeTag);
            },
          },
        }),
      };
    });
  };
  const first = await browser.newContext(); const second = await browser.newContext();
  try {
    await configure(first); await configure(second);
    const a = await first.newPage(); const b = await second.newPage();
    await a.goto('/'); await addTask(a, 'CloudKit 网页资产同步');
    await a.getByRole('button', { name: '同步设置' }).filter({ visible: true }).first().click();
    await a.getByRole('button', { name: '启用 iCloud 同步', exact: true }).click();
    await expect(a.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
    await b.goto('/');
    await b.getByRole('button', { name: '同步设置' }).filter({ visible: true }).first().click();
    await b.getByRole('button', { name: '启用 iCloud 同步', exact: true }).click();
    await expect(b.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
    await expect(b.locator('[data-task-title]').filter({ hasText: 'CloudKit 网页资产同步' })).toBeVisible();
    await info.attach('web-cloud-adapter', { body: JSON.stringify({ assetUpload: true, assetDownload: true, expectedTag: true, boundary: 'Apple login, entitlement and CloudKit service simulated; asset adapter and persistence real' }), contentType: 'application/json' });
  } finally { await first.close(); await second.close(); }
});
