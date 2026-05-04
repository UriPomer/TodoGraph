import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileUserRepository } from '../src/repositories/FileUserRepository.js';

describe('FileUserRepository', () => {
  let repo: FileUserRepository;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `todograph-user-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repo = new FileUserRepository(dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('returns empty array when no users file exists', async () => {
    const all = await repo.findAll();
    expect(all).toEqual([]);
  });

  it('creates and finds a user', async () => {
    const user = { id: 'u1', username: 'alice', passwordHash: 'salt:hash', createdAt: new Date().toISOString() };
    await repo.create(user);
    const found = await repo.findByUsername('alice');
    expect(found).toEqual(user);
  });

  it('returns null for non-existent user', async () => {
    expect(await repo.findByUsername('nobody')).toBeNull();
    expect(await repo.findById('nobody')).toBeNull();
  });

  it('rejects duplicate usernames', async () => {
    const user = { id: 'u1', username: 'bob', passwordHash: 'salt:hash', createdAt: new Date().toISOString() };
    await repo.create(user);
    await expect(repo.create({ ...user, id: 'u2' })).rejects.toThrow('username already exists');
  });
});
