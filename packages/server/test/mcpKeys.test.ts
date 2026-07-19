import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpKeyStore } from '../src/mcp-keys.js';

describe('McpKeyStore', () => {
  let dataDir: string;
  let store: McpKeyStore;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `todograph-mcp-keys-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = new McpKeyStore(dataDir);
  });

  afterEach(async () => {
    await (store as unknown as { writeLock?: Promise<void> }).writeLock;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('stores only a hash and never persists the raw key', async () => {
    const result = await store.generate('u1', 'codex');
    const raw = await fs.readFile(path.join(dataDir, 'mcp-keys.json'), 'utf-8');

    expect(result.key).toMatch(/^tdg-/);
    expect(raw).not.toContain(result.key);
    expect(raw).toContain('"hash"');
    expect(raw).toContain('"prefix"');
  });

  it('rewrites with rename without deleting the live file first', async () => {
    const filePath = path.join(dataDir, 'mcp-keys.json');
    const rmSpy = vi.spyOn(fs, 'rm');

    try {
      await store.generate('u1', 'first');
      await store.generate('u1', 'second');
    } finally {
      rmSpy.mockRestore();
    }

    expect(await fs.readFile(filePath, 'utf-8')).toContain('"keys"');
    expect(
      rmSpy.mock.calls.some(([target]) => target === filePath),
    ).toBe(false);
  });

  it('resolves a valid raw bearer key to its user', async () => {
    const result = await store.generate('u1', 'codex');

    await expect(store.findUserId(result.key)).resolves.toBe('u1');
    await expect(store.findUserId('tdg-invalid')).resolves.toBeNull();
  });

  it('returns the least-privilege scopes stored with a key', async () => {
    const result = await store.generate('u1', 'safe-agent', ['read', 'write']);

    await expect(store.findPrincipal(result.key)).resolves.toEqual({
      userId: 'u1',
      scopes: ['read', 'write'],
    });
    expect((await store.listByUser('u1'))[0]?.scopes).toEqual(['read', 'write']);
  });

  it('throttles last-used persistence for repeated requests', async () => {
    const renameSpy = vi.spyOn(fs, 'rename');
    try {
      const result = await store.generate('u1', 'codex');
      await store.findUserId(result.key);
      await store.findUserId(result.key);
      expect(renameSpy).toHaveBeenCalledTimes(2);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('migrates legacy raw-key records so existing keys still authenticate', async () => {
    const legacyKey = 'tdg-legacy-key-material-123456';
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'mcp-keys.json'),
      JSON.stringify({
        keys: {
          [legacyKey]: {
            userId: 'u1',
            label: 'legacy',
            createdAt: '2026-07-05T00:00:00.000Z',
          },
        },
      }),
      'utf-8',
    );

    await expect(store.findUserId(legacyKey)).resolves.toBe('u1');

    const list = await store.listByUser('u1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      label: 'legacy',
      prefix: legacyKey.slice(0, 16),
      createdAt: '2026-07-05T00:00:00.000Z',
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, 'mcp-keys.json'), 'utf-8'),
    ) as { keys: Record<string, Record<string, string>> };
    expect(JSON.stringify(persisted)).not.toContain(legacyKey);
    const migrated = Object.values(persisted.keys).find(
      (entry) => entry.label === 'legacy',
    );
    expect(migrated).toMatchObject({
      userId: 'u1',
      label: 'legacy',
      prefix: legacyKey.slice(0, 16),
      createdAt: '2026-07-05T00:00:00.000Z',
    });
    expect(migrated?.id).toBeDefined();
    expect(migrated?.hash).toBeDefined();
  });

  it('lists only public key metadata', async () => {
    const result = await store.generate('u1', 'codex');
    const list = await store.listByUser('u1');

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: result.entry.id,
      label: 'codex',
      prefix: result.key.slice(0, 16),
      createdAt: result.entry.createdAt,
    });
    expect(JSON.stringify(list)).not.toContain(result.key);
  });

  it('revokes by key id without requiring the raw key', async () => {
    const result = await store.generate('u1', 'codex');
    await expect(store.revokeById(result.entry.id, 'u1')).resolves.toBe(true);
    await expect(store.findUserId(result.key)).resolves.toBeNull();
  });

  it('returns the user even when lastUsedAt persistence fails', async () => {
    const result = await store.generate('u1', 'codex');
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));

    try {
      await expect(store.findUserId(result.key)).resolves.toBe('u1');
    } finally {
      renameSpy.mockRestore();
    }
  });
});
