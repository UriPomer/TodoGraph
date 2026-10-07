import { create } from 'zustand';
import { cloudKit, isCloudKitConfigured, type CloudWorkspace } from './cloudKit';
import { useProductStore } from '@/features/product/entitlements';
import { isLocalWorkspace } from '@/platform/workspaceRuntime';
import { localTransaction, exportLocalRecord, retainLocalRecovery, validateSnapshot, type WorkspaceSnapshot } from '@/local/localWorkspace';
import { readDeviceRecord, writeDeviceRecord } from '@/local/deviceDatabase';
import { useTaskStore } from '@/stores/useTaskStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

type SyncStatus = 'local' | 'syncing' | 'synced' | 'offline' | 'conflict' | 'error';
interface Cursor { account: string; hash: string; enabled: boolean }
interface SyncState {
  enabled: boolean; status: SyncStatus; error: string | null; lastSynced: string | null;
  enable: () => Promise<void>; disable: (persist?: boolean) => void; sync: (resolution?: 'local' | 'cloud') => Promise<void>;
}
let epoch = 0;
let running = false;
let changedDuringSync = false;
let cursor: Cursor | null = null;
let remoteConflict: CloudWorkspace | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const cursorKey = 'sync:cloudkit';
async function hash(snapshot: WorkspaceSnapshot) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ meta: snapshot.meta, pages: snapshot.pages })));
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}
const allowed = () => {
  const access = useProductStore.getState().entitlements;
  return isLocalWorkspace() && access.plan === 'pro' && (!access.expiresAt || Date.parse(access.expiresAt) > Date.now());
};

async function applyCloud(snapshot: WorkspaceSnapshot, expectedChange: number) {
  const next = validateSnapshot(snapshot);
  await localTransaction(record => {
    if (record.change !== expectedChange) throw new Error('同步期间又有本地编辑，已保留数据，请重试');
    retainLocalRecovery(record);
    record.meta = next.meta; record.pages = next.pages;
  });
  const store = useWorkspaceStore.getState();
  if (store.sessionUserId) await store.bootstrap(store.sessionUserId);
}

export const useSyncStore = create<SyncState>((set, get) => ({
  enabled: false, status: 'local', error: null, lastSynced: null,
  enable: async () => {
    if (!allowed()) { useProductStore.getState().openPro(); return; }
    if (!isCloudKitConfigured()) { set({ status: 'error', error: 'iCloud 同步尚未配置' }); return; }
    const request = epoch;
    try {
      const account = await cloudKit.account();
      if (request !== epoch || !allowed()) return;
      const stored = await readDeviceRecord<Cursor>(cursorKey, () => ({ account, hash: '', enabled: false }));
      if (request !== epoch) return;
      if (stored.account !== account && stored.hash) throw new Error('iCloud 账号已变化；请先导出本地数据，再确认新的同步工作区');
      cursor = { ...stored, account, enabled: true };
      await writeDeviceRecord(cursorKey, cursor);
      if (request !== epoch) return;
      set({ enabled: true, error: null }); await get().sync();
    } catch (error) { if (request === epoch) set({ status: 'error', error: (error as Error).message }); }
  },
  disable: (persist = true) => {
    epoch += 1; clearTimeout(timer); timer = undefined; remoteConflict = null;
    set({ enabled: false, status: 'local', error: null });
    if (persist && cursor) {
      cursor = { ...cursor, enabled: false };
      void writeDeviceRecord(cursorKey, cursor).catch(error => set({ error: (error as Error).message }));
    }
  },
  sync: async resolution => {
    if (!get().enabled || !allowed()) return;
    if (running) { changedDuringSync = true; return; }
    if (!navigator.onLine) { set({ status: 'offline' }); return; }
    running = true; changedDuringSync = false;
    const request = epoch;
    const current = () => request === epoch && allowed() && get().enabled;
    set({ status: 'syncing', error: null });
    try {
      await useTaskStore.getState().flush();
      const account = await cloudKit.account();
      if (!current()) return;
      if (!cursor || cursor.account !== account) throw new Error('iCloud 账号已变化，请暂停同步并导出数据');
      const local = await localTransaction(record => ({ snapshot: exportLocalRecord(record), change: record.change }), false);
      const localHash = await hash(local.snapshot);
      const remote = await cloudKit.read();
      if (!current()) return;
      if (resolution && remoteConflict && remote?.tag !== remoteConflict.tag) {
        remoteConflict = remote;
        set({ status: 'conflict', error: '云端工作区在选择期间又有修改，请重新确认要保留的数据。' }); return;
      }
      const remoteHash = remote ? await hash(remote.snapshot) : '';
      const empty = local.snapshot.meta.pages.length === 2 && Object.values(local.snapshot.pages).every(page => page.nodes.length === 0);
      const localDirty = cursor.hash ? localHash !== cursor.hash : !empty;
      const cloudDirty = remote && remoteHash !== cursor.hash;
      let nextHash = localHash;
      if (remote && remoteHash === localHash) { /* Both already contain the same committed workspace. */ }
      else if (remote && cloudDirty && localDirty && !resolution) {
        remoteConflict = remote;
        set({ status: 'conflict', error: '两台设备都有修改，请选择要保留的工作区。替换前会保存本地恢复点。' }); return;
      } else if (remote && (resolution === 'cloud' || (!localDirty && cloudDirty))) {
        await applyCloud(remote.snapshot, local.change); nextHash = remoteHash;
      } else if (!remote || localDirty || resolution === 'local') {
        if (resolution === 'local' && remote) {
          await localTransaction(record => { record.history.unshift(remote.snapshot); record.history = record.history.slice(0, 5); });
        }
        if (!current()) return;
        await cloudKit.write(local.snapshot, remote?.tag);
      }
      if (!current()) return;
      const nextCursor = { account, hash: nextHash, enabled: true };
      await writeDeviceRecord(cursorKey, nextCursor);
      if (!current()) return;
      cursor = nextCursor; remoteConflict = null;
      set({ status: 'synced', lastSynced: new Date().toISOString(), error: null });
    } catch (error) {
      if (current()) set({ status: navigator.onLine ? 'error' : 'offline', error: (error as Error).message });
    } finally {
      running = false;
      if (changedDuringSync && current() && get().status === 'synced') scheduleSync();
    }
  },
}));

function scheduleSync() {
  clearTimeout(timer);
  if (!useSyncStore.getState().enabled || useSyncStore.getState().status === 'conflict') return;
  timer = setTimeout(() => { void useSyncStore.getState().sync(); }, 1500);
}
export function startSyncLifecycle() {
  let disposed = false; let restoring = false;
  const restore = async () => {
    if (disposed || restoring || !allowed() || !useWorkspaceStore.getState().loaded) return;
    restoring = true;
    try {
      const saved = await readDeviceRecord<Cursor | null>(cursorKey, () => null);
      if (!disposed && allowed() && saved?.enabled) await useSyncStore.getState().enable();
    } catch (error) { if (!disposed) useSyncStore.setState({ status: 'error', error: (error as Error).message }); }
  };
  const online = () => { void useSyncStore.getState().sync(); };
  const changed = () => { if (running) changedDuringSync = true; else scheduleSync(); };
  window.addEventListener('online', online); window.addEventListener('todograph-local-change', changed);
  const poll = setInterval(online, 60_000);
  const unsubscribe = useProductStore.subscribe(state => { if (state.entitlements.plan !== 'pro') useSyncStore.getState().disable(false); else void restore(); });
  const unsubscribeWorkspace = useWorkspaceStore.subscribe(() => { void restore(); });
  void restore();
  return () => { disposed = true; window.removeEventListener('online', online); window.removeEventListener('todograph-local-change', changed); clearInterval(poll); unsubscribe(); unsubscribeWorkspace(); useSyncStore.getState().disable(false); };
}

export const getConflictSnapshot = () => remoteConflict?.snapshot ?? null;
