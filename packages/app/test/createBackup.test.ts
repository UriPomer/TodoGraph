import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileWorkspaceRepository } from '../../server/src/repositories/FileWorkspaceRepository';

describe('FileWorkspaceRepository.createBackup', () => {
  let repo: FileWorkspaceRepository;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `todograph-backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repo = new FileWorkspaceRepository(dataDir);
    // 创建 page 文件，否则 createBackup 的 copyFile 会失败
    const pageDir = path.join(dataDir, 'pages');
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(
      path.join(pageDir, 'test123.json'),
      JSON.stringify({ nodes: [{ id: 'a', title: 'hello', status: 'todo' }], edges: [] }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('creates a timestamped backup file in backups/{pageId}/', async () => {
    await repo.createBackup('test123');

    const backupDir = path.join(dataDir, 'backups', 'test123');
    const files = await fs.readdir(backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
  });

  it('backup file contains the same content as the source page', async () => {
    await repo.createBackup('test123');

    const backupDir = path.join(dataDir, 'backups', 'test123');
    const files = await fs.readdir(backupDir);
    const content = await fs.readFile(path.join(backupDir, files[0]!), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({
      nodes: [{ id: 'a', title: 'hello', status: 'todo' }],
      edges: [],
    });
  });

  it('prunes oldest backups beyond 50', async () => {
    const backupDir = path.join(dataDir, 'backups', 'test123');
    await fs.mkdir(backupDir, { recursive: true });

    // 写入 51 个按时间升序命名的文件（最旧的序号为 0）
    for (let i = 0; i < 51; i++) {
      const ts = `2026-01-01T00-00-00-${String(i).padStart(3, '0')}Z.json`;
      await fs.writeFile(path.join(backupDir, ts), JSON.stringify({ n: i }), 'utf-8');
    }

    // 第 52 次备份（加上原有的 51 → 52，应删除最旧的 2 个，保留 50）
    await repo.createBackup('test123');

    const files = (await fs.readdir(backupDir)).filter((f) => f.endsWith('.json')).sort();
    expect(files).toHaveLength(50);
    // 最旧的文件（序号 0 和 1）应已被删除
    expect(files[0]).not.toBe('2026-01-01T00-00-00-000Z.json');
    expect(files[0]).not.toBe('2026-01-01T00-00-00-001Z.json');
  });

  it('rejects on invalid page id', async () => {
    await expect(repo.createBackup('../../etc')).rejects.toThrow('invalid page id');
  });
});
