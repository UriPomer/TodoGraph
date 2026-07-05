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

  it('creates and finds a user by username and id', async () => {
    const user = {
      id: 'u1',
      username: 'alice',
      passwordHash: 'salt:hash',
      sessionVersion: 0,
      createdAt: new Date().toISOString(),
    };
    await repo.create(user);
    const byUsername = await repo.findByUsername('alice');
    expect(byUsername).toEqual(user);
    const byId = await repo.findById('u1');
    expect(byId).toEqual(user);
  });

  it('returns null for non-existent user', async () => {
    expect(await repo.findByUsername('nobody')).toBeNull();
    expect(await repo.findById('nobody')).toBeNull();
  });

  it('rejects duplicate usernames', async () => {
    const user = {
      id: 'u1',
      username: 'bob',
      passwordHash: 'salt:hash',
      sessionVersion: 0,
      createdAt: new Date().toISOString(),
    };
    await repo.create(user);
    await expect(repo.create({ ...user, id: 'u2' })).rejects.toThrow('username already exists');
  });

  it('reads legacy users without sessionVersion and preserves fields when updating password hash', async () => {
    const legacyUser = {
      id: 'u1',
      username: 'legacy-user',
      passwordHash: 'old-hash',
      createdAt: new Date().toISOString(),
    };
    const usersDir = path.join(dataDir, 'users');
    const usersFile = path.join(usersDir, 'users.json');
    await fs.mkdir(usersDir, { recursive: true });
    await fs.writeFile(usersFile, JSON.stringify([legacyUser], null, 2), 'utf-8');

    const all = await repo.findAll();
    expect(all).toEqual([{ ...legacyUser, sessionVersion: 0 }]);

    await repo.updatePasswordHash('u1', 'new-hash', 1);

    const persisted = JSON.parse(await fs.readFile(usersFile, 'utf-8')) as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      {
        ...legacyUser,
        passwordHash: 'new-hash',
        sessionVersion: 1,
      },
    ]);
  });
});
