import { z } from 'zod';

export interface StoredUser {
  id: string;
  username: string;
  /** format: "hexSalt:hexHash" */
  passwordHash: string;
  sessionVersion: number;
  createdAt: string;
}

export const StoredUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(2).max(32),
  passwordHash: z.string().min(1),
  sessionVersion: z.number().int().nonnegative().default(0),
  createdAt: z.string().min(1),
});

export interface UserRepository {
  findAll(): Promise<StoredUser[]>;
  findByUsername(username: string): Promise<StoredUser | null>;
  findById(id: string): Promise<StoredUser | null>;
  create(user: StoredUser): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string, sessionVersion: number): Promise<void>;
}
