import { Capacitor, registerPlugin } from '@capacitor/core';
import { validateSnapshot, type WorkspaceSnapshot } from '@/local/localWorkspace';

export interface CloudWorkspace { snapshot: WorkspaceSnapshot; tag: string }
interface CloudBridge {
  account(): Promise<{ accountId: string }>;
  read(): Promise<{ payload?: string; tag?: string }>;
  write(options: { payload: string; expectedTag?: string }): Promise<{ tag: string }>;
}
const native = registerPlugin<CloudBridge>('AppleCloud');
const containerId = import.meta.env.VITE_CLOUDKIT_CONTAINER as string | undefined;
const token = import.meta.env.VITE_CLOUDKIT_API_TOKEN as string | undefined;
export const isCloudKitConfigured = () => Boolean(containerId && (Capacitor.isPluginAvailable('AppleCloud') || token));

interface CKRecord { recordName: string; recordType: string; recordChangeTag?: string; fields: { workspaceFile: { value: Blob | { downloadURL: string } } } }
interface CKResponse { records?: CKRecord[]; errors?: Array<{ reason?: string; ckErrorCode?: string }> }
interface CKContainer {
  setUpAuth(): Promise<{ userRecordName: string } | null>;
  privateCloudDatabase: {
    fetchRecords(names: string[]): Promise<CKResponse>;
    saveRecords(records: CKRecord[]): Promise<CKResponse>;
  };
}
interface CloudKitGlobal { configure(config: unknown): void; getDefaultContainer(): CKContainer }
declare global { interface Window { CloudKit?: CloudKitGlobal } }
let container: Promise<CKContainer> | undefined;
async function webContainer(): Promise<CKContainer> {
  if (!containerId || !token) throw new Error('iCloud 同步尚未配置');
  container ??= (async () => {
    if (!window.CloudKit) await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://cdn.apple-cloudkit.com/ck/2/cloudkit.js';
      const timer = window.setTimeout(() => { script.remove(); reject(new Error('加载 iCloud 登录超时，请重试')); }, 15_000);
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('无法加载 iCloud 登录')); };
      document.head.append(script);
    });
    if (!window.CloudKit) throw new Error('iCloud 登录组件不可用');
    window.CloudKit.configure({ containers: [{ containerIdentifier: containerId, environment: import.meta.env.VITE_CLOUDKIT_ENVIRONMENT === 'development' ? 'development' : 'production', apiTokenAuth: { apiToken: token, persist: true, signInButton: { id: 'cloudkit-sign-in', theme: 'medium' }, signOutButton: { id: 'cloudkit-sign-out', theme: 'medium' } } }] });
    return window.CloudKit.getDefaultContainer();
  })();
  try { return await container; } catch (error) { container = undefined; throw error; }
}

const recordName = 'todograph-workspace';
function firstRecord(response: CKResponse, missing = false): CKRecord | null {
  const errors = response.errors ?? [];
  if (missing && errors.length === 1 && errors[0]?.ckErrorCode === 'UNKNOWN_ITEM') return null;
  if (errors.length) throw new Error(errors.map(error => error.reason ?? error.ckErrorCode ?? 'iCloud 操作失败').join('；'));
  return response.records?.[0] ?? null;
}
const adapter = {
  async account(): Promise<string> {
    if (!isCloudKitConfigured()) throw new Error('iCloud 同步尚未配置');
    if (Capacitor.isPluginAvailable('AppleCloud')) return (await native.account()).accountId;
    const user = await (await webContainer()).setUpAuth();
    if (!user) throw new Error('请先使用下方 iCloud 按钮登录');
    return user.userRecordName;
  },
  async read(): Promise<CloudWorkspace | null> {
    if (Capacitor.isPluginAvailable('AppleCloud')) {
      const record = await native.read();
      return record.payload && record.tag ? { snapshot: validateSnapshot(JSON.parse(record.payload)), tag: record.tag } : null;
    }
    const record = firstRecord(await (await webContainer()).privateCloudDatabase.fetchRecords([recordName]), true);
    if (!record) return null;
    if (!record.recordChangeTag) throw new Error('iCloud 返回的数据缺少版本');
    const asset = record.fields.workspaceFile.value;
    if (asset instanceof Blob || !asset?.downloadURL) throw new Error('iCloud 工作区文件无效');
    return { snapshot: await downloadWorkspace(asset.downloadURL), tag: record.recordChangeTag };
  },
  async write(snapshot: WorkspaceSnapshot, expectedTag?: string): Promise<string> {
    const payload = JSON.stringify(validateSnapshot(snapshot));
    if (Capacitor.isPluginAvailable('AppleCloud')) return (await native.write({ payload, expectedTag })).tag;
    const record = firstRecord(await (await webContainer()).privateCloudDatabase.saveRecords([{
      recordName, recordType: 'TodoGraphWorkspace', ...(expectedTag ? { recordChangeTag: expectedTag } : {}), fields: { workspaceFile: { value: new Blob([payload], { type: 'application/json' }) } },
    }]));
    if (!record?.recordChangeTag) throw new Error('iCloud 保存响应缺少版本');
    return record.recordChangeTag;
  },
};

async function downloadWorkspace(url: string): Promise<WorkspaceSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url.replace('${f}', 'workspace.json'), { credentials: 'omit', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('无法下载 iCloud 工作区文件');
    const reader = response.body.getReader(); const chunks: ArrayBuffer[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 20 * 1024 * 1024) { controller.abort(); throw new Error('iCloud 工作区超过 20 MB 上限'); }
        chunks.push(Uint8Array.from(value).buffer);
      }
    } finally { reader.releaseLock(); }
    return validateSnapshot(JSON.parse(await new Blob(chunks).text()));
  } finally { clearTimeout(timer); }
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('iCloud 操作超时，本地数据已保留，请重试')), 30_000);
    })]);
  } finally { clearTimeout(timer!); }
}
export const cloudKit = {
  account: () => bounded(adapter.account()), read: () => bounded(adapter.read()),
  write: (snapshot: WorkspaceSnapshot, tag?: string) => bounded(adapter.write(snapshot, tag)),
};
