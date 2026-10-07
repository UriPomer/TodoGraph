import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface DeviceRecord { version: number; value: unknown }

/** Stable native storage independent of the loopback HTTP port. One host owns its writers. */
export class DeviceStorage {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir: string) {}

  private filePath(key: string) {
    if (!/^(workspace|appearance:[\w-]{1,100}|sync:[\w.-]{1,150})$/.test(key)) throw new Error('Unsupported device record key');
    return path.join(this.dataDir, 'device', createHash('sha256').update(key).digest('hex') + '.json');
  }

  async read(key: string): Promise<DeviceRecord> {
    const file = this.filePath(key);
    await this.queues.get(key)?.catch(() => {});
    return this.readFile(file);
  }
  private async readFile(file: string): Promise<DeviceRecord> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as DeviceRecord; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 0, value: null };
    }
  }

  async write(key: string, value: unknown, expectedVersion: number): Promise<boolean> {
    const file = this.filePath(key);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.readFile(file);
      if (current.version !== expectedVersion) return false;
      const json = JSON.stringify({ version: current.version + 1, value });
      if (Buffer.byteLength(json) > 96 * 1024 * 1024) throw new Error('Device record exceeds storage limit');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(json, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
      }
      catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
      return true;
    });
    this.queues.set(key, operation);
    try { return await operation; }
    finally { if (this.queues.get(key) === operation) this.queues.delete(key); }
  }
}
