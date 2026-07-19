import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function atomicWriteText(target: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(tmp, text, 'utf-8');
    await syncFile(tmp);
    await fs.rename(tmp, target);
    await syncDirectory(path.dirname(target));
  } finally {
    // Covers write/fsync/rename failures; after a successful rename the temp path no longer exists.
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function atomicWriteJson(target: string, data: unknown): Promise<void> {
  await atomicWriteText(target, JSON.stringify(data, null, 2));
}

export async function copyFileDurable(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  await syncFile(destination);
  await syncDirectory(path.dirname(destination));
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not expose directory fsync; file fsync + atomic rename is the strongest available path.
    if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOSYS', 'EPERM'].includes(code ?? '')) throw error;
  }
}
