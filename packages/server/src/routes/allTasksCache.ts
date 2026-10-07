import type { AllTasksResponse } from '@todograph/shared';

/**
 * /api/all-tasks 的内存缓存。
 *
 * 正常 API 写入会按用户精确失效。meta 摘要和页面 mtime 是额外的
 * 尽力而为检查；直接修改磁盘文件不属于受支持的写入路径。
 */
export interface AllTasksCache {
  key: string; // meta 摘要：activePageId + pages.id.order
  mtimes: Map<string, number>;
  response: AllTasksResponse;
}

export class AllTasksCacheStore {
  private readonly entries = new Map<string, { cache: AllTasksCache; bytes: number }>();
  private totalBytes = 0;

  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly maxUsers = 32) {}

  get(userId: string): AllTasksCache | null {
    const entry = this.entries.get(userId);
    if (!entry) return null;
    this.entries.delete(userId);
    this.entries.set(userId, entry);
    return entry.cache;
  }

  set(userId: string, cache: AllTasksCache): void {
    this.delete(userId);
    const bytes = Buffer.byteLength(JSON.stringify(cache.response), 'utf8');
    if (bytes > this.maxBytes) return;
    this.entries.set(userId, { cache, bytes });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxUsers || this.totalBytes > this.maxBytes) {
      const oldestUserId = this.entries.keys().next().value as string | undefined;
      if (!oldestUserId) break;
      this.delete(oldestUserId);
    }
  }

  delete(userId: string): void {
    const previous = this.entries.get(userId);
    if (!previous) return;
    this.totalBytes -= previous.bytes;
    this.entries.delete(userId);
  }
}
