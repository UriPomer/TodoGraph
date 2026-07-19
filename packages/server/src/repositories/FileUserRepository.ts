import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withFilesystemLock } from './fileLock.js';
import { atomicWriteJson } from './durableFile.js';
import { z } from 'zod';
import { StoredUserSchema, type StoredUser, type UserRepository } from './UserRepository.js';

export class FileUserRepository implements UserRepository {
  private filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'users', 'users.json');
  }

  async findAll(): Promise<StoredUser[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return z.array(StoredUserSchema).parse(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return [];
      throw err;
    }
  }

  async findByUsername(username: string): Promise<StoredUser | null> {
    const all = await this.findAll();
    return all.find((u) => u.username === username) ?? null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    const all = await this.findAll();
    return all.find((u) => u.id === id) ?? null;
  }

  async register(user: StoredUser, allowAdditionalUsers: boolean): Promise<'created' | 'closed' | 'duplicate'> {
    return this.withWriteLock(async () => {
      const all = await this.findAll();
      if (all.length > 0 && !allowAdditionalUsers) return 'closed';
      if (all.some((entry) => entry.username === user.username)) return 'duplicate';
      all.push(user);
      await this.writeUsers(all);
      return 'created';
    });
  }

  async updatePasswordHash(userId: string, passwordHash: string, sessionVersion: number): Promise<void> {
    await this.withWriteLock(async () => {
      const all = await this.findAll();
      const user = all.find((u) => u.id === userId);
      if (!user) {
        throw new Error('user not found');
      }
      user.passwordHash = passwordHash;
      user.sessionVersion = sessionVersion;
      await this.writeUsers(all);
    });
  }

  private async writeUsers(users: StoredUser[]): Promise<void> {
    await atomicWriteJson(this.filePath, users);
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await withFilesystemLock(path.dirname(this.filePath), fn, '.identity.lock');
    } finally {
      release();
    }
  }
}
