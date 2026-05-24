import type { client as ClientType } from '../client.js';

/** 写操作前静默备份，失败不阻断主流程 */
export async function backupBeforeMutation(c: typeof ClientType, pageId: string): Promise<void> {
  try {
    await c.post(`/api/pages/${encodeURIComponent(pageId)}/backup`);
  } catch { /* 静默 */ }
}
