import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { StoredUserSchema, type StoredUser, type UserRepository } from './UserRepository.js';

export class FileUserRepository implements UserRepository {
  private filePath: string;

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
    const all = await this.findAll();
    if (all.some((u) => u.username === user.username)) {
      throw new Error('username already exists');
    }
    all.push(user);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
