import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteText } from '../src/repositories/durableFile.js';

describe('durable file writes', () => {
  let directory = '';

  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it('removes the temporary file when writing fails before rename', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'todograph-durable-'));
    const target = path.join(directory, 'page.json');
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args: unknown[]) => {
      await (realWriteFile as (...callArgs: unknown[]) => Promise<void>)(...args);
      throw new Error('simulated disk failure');
    });

    await expect(atomicWriteText(target, '{"ok":true}')).rejects.toThrow('simulated disk failure');
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
