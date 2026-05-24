import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface McpKeyEntry {
  userId: string;
  label: string;
  createdAt: string;
}

interface McpKeysFile {
  keys: Record<string, McpKeyEntry>;
}

function generateKey(): string {
  return 'tdg-' + randomBytes(24).toString('base64url');
}

export class McpKeyStore {
  private cache: McpKeysFile | null = null;
  private cacheTime = 0;
  private readonly filePath: string;
  /** 互斥写锁：防止并发生成/撤销时的竞态 */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'mcp-keys.json');
  }

  /** 根据 key 查找 userId。env var 优先级高于文件存储。 */
  async findUserId(key: string): Promise<string | null> {
    const keys = await this.readKeys();
    const entry = keys.keys[key];
    return entry?.userId ?? null;
  }

  /** 列出用户的所有 key（返回 key 前缀，不暴露完整 key 内容以便确认身份）。 */
  async listByUser(userId: string): Promise<Array<{ key: string; label: string; createdAt: string }>> {
    const keys = await this.readKeys();
    return Object.entries(keys.keys)
      .filter(([, v]) => v.userId === userId)
      .map(([k, v]) => ({ key: k, label: v.label, createdAt: v.createdAt }));
  }

  /** 为用户生成一个新 key，返回完整 key（仅此一次可获取原始值）。 */
  async generate(userId: string, label: string): Promise<{ key: string; entry: McpKeyEntry }> {
    const key = generateKey();
    const entry: McpKeyEntry = { userId, label, createdAt: new Date().toISOString() };
    await this.withLock(async () => {
      const keys = await this.readKeys();
      keys.keys[key] = entry;
      await this.writeKeys(keys);
    });
    return { key, entry };
  }

  /** 撤销一个 key。调用方必须验证 key 属于当前用户。 */
  async revoke(key: string, userId: string): Promise<boolean> {
    return this.withLock(async () => {
      const keys = await this.readKeys();
      const entry = keys.keys[key];
      if (!entry || entry.userId !== userId) return false;
      delete keys.keys[key];
      await this.writeKeys(keys);
      return true;
    });
  }

  // ── private ──

  private async readKeys(): Promise<McpKeysFile> {
    // 内存缓存 5 秒，降低 auth hook 的磁盘 IO
    if (this.cache && Date.now() - this.cacheTime < 5000) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const keys: Record<string, McpKeyEntry> = {};
      if (parsed && typeof parsed === 'object' && parsed.keys) {
        for (const [k, v] of Object.entries(parsed.keys)) {
          const entry = v as McpKeyEntry;
          if (entry.userId && entry.label) keys[k] = entry;
        }
      }
      this.cache = { keys };
      this.cacheTime = Date.now();
      return this.cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty: McpKeysFile = { keys: {} };
        this.cache = empty;
        this.cacheTime = Date.now();
        return empty;
      }
      throw err;
    }
  }

  private async writeKeys(data: McpKeysFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp.' + Date.now();
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
    this.cache = data;
    this.cacheTime = Date.now();
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
