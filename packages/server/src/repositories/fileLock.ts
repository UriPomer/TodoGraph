import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

const RETRY_MS = 25;
const TIMEOUT_MS = 10_000;
const STALE_MS = 30_000;

/** Serializes writers that share a filesystem, complementing in-process promise queues. */
export async function withFilesystemLock<T>(
  dataDir: string,
  task: () => Promise<T>,
  lockName = '.workspace.lock',
): Promise<T> {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, lockName);
  await removeLegacyLockFile(lockPath);
  const release = await lockfile.lock(dataDir, {
    lockfilePath: lockPath,
    realpath: false,
    stale: STALE_MS,
    update: STALE_MS / 2,
    retries: {
      retries: Math.ceil(TIMEOUT_MS / RETRY_MS),
      factor: 1,
      minTimeout: RETRY_MS,
      maxTimeout: RETRY_MS,
      randomize: false,
    },
  });

  try {
    return await task();
  } finally {
    await release();
  }
}

async function removeLegacyLockFile(lockPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) return;
  const owner = Number.parseInt(await fs.readFile(lockPath, 'utf-8').catch(() => ''), 10);
  if ((Number.isInteger(owner) && isProcessAlive(owner)) || Date.now() - stat.mtimeMs < STALE_MS) {
    throw new Error('workspace is locked by a legacy server process');
  }
  await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
