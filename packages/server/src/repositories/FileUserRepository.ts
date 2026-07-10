import { promises as fs } from 'node:fs';
import path from 'node:path';
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

  async create(user: StoredUser): Promise<void> {
    await this.withWriteLock(async () => {
      const all = await this.findAll();
      if (all.some((u) => u.username === user.username)) {
        throw new Error('username already exists');
      }
      all.push(user);
      await this.writeUsers(all);
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(users, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
