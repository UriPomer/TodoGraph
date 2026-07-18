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

  it('collapses credentials issued by the previous parallel-rotation model', async () => {
    const now = new Date();
    const secrets = ['first-secret', 'second-secret'];
    const tokenDir = path.join(dataDir, 'users');
    const filePath = path.join(tokenDir, 'remember-tokens.json');
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify([
        {
          id: 'device-id',
          userId: 'user-1',
          currentSecretHashes: secrets.map((secret) =>
            createHash('sha256').update(secret).digest('hex')),
          previousSecretHashes: [],
          sessionVersion: 0,
          createdAt: now.toISOString(),
          lastUsedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      ]),
    );

    const result = await new FileRememberTokenRepository(dataDir).consume(
      `device-id.${secrets[1]}`,
    );
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8')) as Array<{
      currentSecretHashes: string[];
      previousSecretHashes: string[];
    }>;

    expect(result).toMatchObject({ status: 'valid', userId: 'user-1' });
    expect(stored[0]?.currentSecretHashes).toHaveLength(1);
    expect(stored[0]?.previousSecretHashes).toHaveLength(2);
  });
});
