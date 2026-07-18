import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRememberTokenRepository } from '../src/repositories/FileRememberTokenRepository.js';

describe('FileRememberTokenRepository', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'todograph-remember-test-'));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('reads and rotates credentials written by the pre-repository format', async () => {
    const id = 'legacy-token-id';
    const secret = 'legacy-token-secret';
    const now = new Date();
    const tokenDir = path.join(dataDir, 'users');
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(
      path.join(tokenDir, 'remember-tokens.json'),
      JSON.stringify([
        {
          id,
          userId: 'user-1',
          secretHash: createHash('sha256').update(secret).digest('hex'),
          sessionVersion: 0,
          createdAt: now.toISOString(),
          lastUsedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      ]),
    );

    const result = await new FileRememberTokenRepository(dataDir).consume(`${id}.${secret}`);

    expect(result).toMatchObject({ status: 'valid', userId: 'user-1' });
  });
});
