import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface McpKeyEntry {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface PublicMcpKeyEntry {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface McpKeysFile {
  keys: Record<string, McpKeyEntry>;
}

function generateKey(): string {
  return 'tdg-' + randomBytes(24).toString('base64url');
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function equalHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function publicEntry(entry: McpKeyEntry): PublicMcpKeyEntry {
  return {
    id: entry.id,
    prefix: entry.prefix,
    label: entry.label,
    createdAt: entry.createdAt,
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
  };
}

function makeKeyId(seed?: string): string {
  return seed ? `mk_${seed.slice(0, 24)}` : 'mk_' + randomBytes(12).toString('base64url');
}

function migrateLegacyEntry(rawKey: string, value: Partial<McpKeyEntry>): McpKeyEntry | null {
  if (!value.userId || !value.label || !value.createdAt) {
    return null;
  }

  const hash = hashKey(rawKey);
  return {
    id: makeKeyId(hash),
    userId: value.userId,
    label: value.label,
    prefix: rawKey.slice(0, 16),
    hash,
    createdAt: value.createdAt,
    ...(value.lastUsedAt ? { lastUsedAt: value.lastUsedAt } : {}),
  };
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

  async findUserId(key: string): Promise<string | null> {
    const digest = hashKey(key);
    const keys = await this.readKeys();
    for (const entry of Object.values(keys.keys)) {
      if (equalHex(entry.hash, digest)) {
        if (!entry.lastUsedAt || Date.now() - Date.parse(entry.lastUsedAt) >= 60_000) {
          await this.touchLastUsed(entry.id).catch(() => {});
        }
        return entry.userId;
      }
    }
    return null;
  }

  async listByUser(userId: string): Promise<PublicMcpKeyEntry[]> {
    const keys = await this.readKeys();
    return Object.values(keys.keys)
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(publicEntry);
  }

  async generate(userId: string, label: string): Promise<{ key: string; entry: PublicMcpKeyEntry }> {
    const key = generateKey();
    const id = makeKeyId();
    const entry: McpKeyEntry = {
      id,
      userId,
      label,
      prefix: key.slice(0, 16),
      hash: hashKey(key),
      createdAt: new Date().toISOString(),
    };
    await this.withLock(async () => {
      const keys = await this.readKeys();
      const userKeyCount = Object.values(keys.keys).filter((v) => v.userId === userId).length;
      if (userKeyCount >= 10) throw new Error('每个用户最多 10 个 API Key，请先撤销不用的 Key');
      keys.keys[id] = entry;
      await this.writeKeys(keys);
    });
    return { key, entry: publicEntry(entry) };
  }

  async revokeById(id: string, userId: string): Promise<boolean> {
    return this.withLock(async () => {
      const keys = await this.readKeys();
      const entry = keys.keys[id];
      if (!entry || entry.userId !== userId) return false;
      delete keys.keys[id];
      await this.writeKeys(keys);
      return true;
    });
  }

  private async touchLastUsed(id: string): Promise<void> {
    await this.withLock(async () => {
      const keys = await this.readKeys();
      const entry = keys.keys[id];
      if (!entry) return;
      entry.lastUsedAt = new Date().toISOString();
      await this.writeKeys(keys);
    });
  }

  private async readKeys(): Promise<McpKeysFile> {
    if (this.cache && Date.now() - this.cacheTime < 5000) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { keys?: Record<string, Partial<McpKeyEntry>> };
      const keys: Record<string, McpKeyEntry> = {};
      let migratedLegacy = false;
      for (const [id, value] of Object.entries(parsed.keys ?? {})) {
        if (
          value.id &&
          value.userId &&
          value.label &&
          value.prefix &&
          value.hash &&
          value.createdAt
        ) {
          keys[id] = value as McpKeyEntry;
          continue;
        }

        const migrated = migrateLegacyEntry(id, value);
        if (migrated) {
          keys[migrated.id] = migrated;
          migratedLegacy = true;
        }
      }
      this.cache = { keys };
      this.cacheTime = Date.now();
      if (migratedLegacy) {
        await this.writeKeys(this.cache);
      }
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
    const tmp = `${this.filePath}.tmp.${randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    try {
      await fs.rename(tmp, this.filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
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
