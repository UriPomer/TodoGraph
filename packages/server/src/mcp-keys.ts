import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withFilesystemLock } from './repositories/fileLock.js';
import { atomicWriteJson } from './repositories/durableFile.js';

export interface McpKeyEntry {
  id: string;
  userId: string;
  label: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  scopes: McpKeyScope[];
}

export type McpKeyScope = 'read' | 'write' | 'destructive';
const ALL_SCOPES: McpKeyScope[] = ['read', 'write', 'destructive'];

export interface PublicMcpKeyEntry {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  scopes: McpKeyScope[];
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
    scopes: entry.scopes,
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
    scopes: normalizeScopes(value.scopes),
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
    return (await this.findPrincipal(key))?.userId ?? null;
  }

  async findPrincipal(key: string): Promise<{ userId: string; scopes: McpKeyScope[] } | null> {
    const digest = hashKey(key);
    const keys = await this.readKeys();
    for (const entry of Object.values(keys.keys)) {
      if (equalHex(entry.hash, digest)) {
        if (!entry.lastUsedAt || Date.now() - Date.parse(entry.lastUsedAt) >= 60_000) {
          await this.touchLastUsed(entry.id).catch(() => {});
        }
        return { userId: entry.userId, scopes: entry.scopes };
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

  async generate(
    userId: string,
    label: string,
    scopes: McpKeyScope[] = ALL_SCOPES,
  ): Promise<{ key: string; entry: PublicMcpKeyEntry }> {
    const key = generateKey();
    const id = makeKeyId();
    const entry: McpKeyEntry = {
      id,
      userId,
      label,
      prefix: key.slice(0, 16),
      hash: hashKey(key),
      createdAt: new Date().toISOString(),
      scopes: normalizeScopes(scopes),
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
          keys[id] = { ...value, scopes: normalizeScopes(value.scopes) } as McpKeyEntry;
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
    await atomicWriteJson(this.filePath, data);
    this.cache = data;
    this.cacheTime = Date.now();
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await withFilesystemLock(path.dirname(this.filePath), async () => {
        this.cache = null;
        return fn();
      }, '.mcp-keys.lock');
    } finally {
      release();
    }
  }
}

function normalizeScopes(scopes: unknown): McpKeyScope[] {
  if (!Array.isArray(scopes)) return [...ALL_SCOPES];
  const allowed = new Set<McpKeyScope>(ALL_SCOPES);
  const normalized = [...new Set(scopes.filter((scope): scope is McpKeyScope =>
    typeof scope === 'string' && allowed.has(scope as McpKeyScope)))] as McpKeyScope[];
  return normalized.includes('read') ? normalized : ['read', ...normalized];
}
