import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFilesystemLock } from '../src/repositories/fileLock.js';

describe('withFilesystemLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `todograph-file-lock-${Date.now()}-${Math.random()}`);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('serializes concurrent writers and removes the lock after completion', async () => {
    let active = 0;
    let maximumActive = 0;
    const run = () => withFilesystemLock(dir, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });

    await Promise.all([run(), run()]);

    expect(maximumActive).toBe(1);
    await expect(fs.access(path.join(dir, '.workspace.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes acquisition atomically as a directory before entering the task', async () => {
    let releaseTask!: () => void;
    const gate = new Promise<void>((resolve) => { releaseTask = resolve; });
    let entered = false;
    const first = withFilesystemLock(dir, async () => {
      entered = true;
      await gate;
    });

    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(fs.stat(path.join(dir, '.workspace.lock'))).resolves.toMatchObject({});
    expect((await fs.stat(path.join(dir, '.workspace.lock'))).isDirectory()).toBe(true);

    releaseTask();
    await first;
  });

  it('recovers a stale lock file left by the previous lock implementation', async () => {
    await fs.mkdir(dir, { recursive: true });
    const lockPath = path.join(dir, '.workspace.lock');
    await fs.writeFile(lockPath, '2147483647');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    await expect(withFilesystemLock(dir, async () => 'ok')).resolves.toBe('ok');
  });
});
