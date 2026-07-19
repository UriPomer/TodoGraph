import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withFilesystemLock } from './fileLock.js';
import { atomicWriteJson } from './durableFile.js';
import { z } from 'zod';
import type {
  ConsumeRememberTokenResult,
  RememberTokenRepository,
} from './RememberTokenRepository.js';

const MAX_TOKENS_PER_USER = 20;
const REPLAY_GRACE_MS = 5_000;
const REMEMBER_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

const RememberTokenSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  currentSecretHashes: z.array(z.string().length(64)).min(1),
  previousSecretHashes: z.array(z.string().length(64)).default([]),
  previousValidUntil: z.string().datetime().optional(),
  sessionVersion: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

type RememberToken = z.infer<typeof RememberTokenSchema>;

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function encodeToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

function parseToken(token: string): { id: string; secret: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [id, secret] = parts;
  if (!id || !secret || !/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    return null;
  }
  return { id, secret };
}

function includesHash(hashes: string[], actual: Buffer): boolean {
  return hashes.some((hash) => timingSafeEqual(Buffer.from(hash, 'hex'), actual));
}

/** File-backed store that persists only hashes of long-lived device credentials. */
export class FileRememberTokenRepository implements RememberTokenRepository {
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'users', 'remember-tokens.json');
  }

  async issue(userId: string, sessionVersion: number): Promise<string> {
    return this.withWriteLock(async () => {
      const now = new Date();
      const tokens = (await this.readTokens()).filter((token) => new Date(token.expiresAt) > now);
      const userTokens = tokens
        .filter((token) => token.userId === userId)
        .sort((left, right) => left.lastUsedAt.localeCompare(right.lastUsedAt));
      const removeCount = Math.max(0, userTokens.length - MAX_TOKENS_PER_USER + 1);
      const idsToRemove = new Set(userTokens.slice(0, removeCount).map((token) => token.id));

      const id = randomBytes(16).toString('base64url');
      const secret = randomBytes(32).toString('base64url');
      const nowIso = now.toISOString();
      tokens.push({
        id,
        userId,
        currentSecretHashes: [hashSecret(secret).toString('hex')],
        previousSecretHashes: [],
        sessionVersion,
        createdAt: nowIso,
        lastUsedAt: nowIso,
        expiresAt: new Date(now.getTime() + REMEMBER_LIFETIME_MS).toISOString(),
      });
      await this.writeTokens(tokens.filter((token) => !idsToRemove.has(token.id)));
      return encodeToken(id, secret);
    });
  }

  async consume(rawToken: string): Promise<ConsumeRememberTokenResult> {
    const parsed = parseToken(rawToken);
    if (!parsed) return { status: 'invalid' };

    return this.withWriteLock(async () => {
      const tokens = await this.readTokens();
      const index = tokens.findIndex((token) => token.id === parsed.id);
      if (index < 0) return { status: 'invalid' };

      const record = tokens[index]!;
      const now = new Date();
      if (new Date(record.expiresAt) <= now) {
        tokens.splice(index, 1);
        await this.writeTokens(tokens);
        return { status: 'invalid' };
      }

      const actual = hashSecret(parsed.secret);
      const isCurrent = includesHash(record.currentSecretHashes, actual);
      const isGraceReplay =
        includesHash(record.previousSecretHashes, actual) &&
        record.previousValidUntil !== undefined &&
        new Date(record.previousValidUntil) >= now;

      if (!isCurrent && !isGraceReplay) {
        tokens.splice(index, 1);
        await this.writeTokens(tokens);
        return { status: 'replayed' };
      }
      if (isGraceReplay) {
        return {
          status: 'valid',
          userId: record.userId,
          sessionVersion: record.sessionVersion,
          expiresAt: record.expiresAt,
        };
      }

      const nextSecret = randomBytes(32).toString('base64url');
      record.previousSecretHashes = record.currentSecretHashes;
      record.previousValidUntil = new Date(now.getTime() + REPLAY_GRACE_MS).toISOString();
      record.currentSecretHashes = [hashSecret(nextSecret).toString('hex')];
      record.lastUsedAt = now.toISOString();
      await this.writeTokens(tokens);
      return {
        status: 'valid',
        userId: record.userId,
        sessionVersion: record.sessionVersion,
        rotatedToken: encodeToken(record.id, nextSecret),
        expiresAt: record.expiresAt,
      };
    });
  }

  async revoke(rawToken: string): Promise<void> {
    const parsed = parseToken(rawToken);
    if (!parsed) return;
    await this.withWriteLock(async () => {
      const tokens = await this.readTokens();
      const remaining = tokens.filter((token) => token.id !== parsed.id);
      if (remaining.length !== tokens.length) await this.writeTokens(remaining);
    });
  }

  async revokeUser(userId: string): Promise<void> {
    await this.withWriteLock(async () => {
      const tokens = await this.readTokens();
      const remaining = tokens.filter((token) => token.userId !== userId);
      if (remaining.length !== tokens.length) await this.writeTokens(remaining);
    });
  }

  private async readTokens(): Promise<RememberToken[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return z.array(RememberTokenSchema).parse(JSON.parse(raw));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeTokens(tokens: RememberToken[]): Promise<void> {
    await atomicWriteJson(this.filePath, tokens);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await withFilesystemLock(path.dirname(this.filePath), operation, '.identity.lock');
    } finally {
      release();
    }
  }
}
