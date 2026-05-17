import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileWorkspaceRepository } from '../src/repositories/FileWorkspaceRepository.js';
import { MetaVersionConflictError, VersionConflictError } from '../src/repositories/Repository.js';

describe('FileWorkspaceRepository concurrency guards', () => {
  let rootDir: string;
  let userDir: string;
  let repo: FileWorkspaceRepository;

  beforeEach(async () => {
    rootDir = path.join(
      os.tmpdir(),
      `todograph-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    userDir = path.join(rootDir, 'users', 'u1');
    repo = new FileWorkspaceRepository(userDir, rootDir);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('seeds meta revision as 0', async () => {
    const meta = await repo.loadMeta();
    expect(meta.revision).toBe(0);
  });

  it('rejects stale meta revision on createPage', async () => {
    const meta = await repo.loadMeta();

    await repo.createPage('第一页', meta.revision);

    await expect(repo.createPage('第二页', meta.revision)).rejects.toBeInstanceOf(
      MetaVersionConflictError,
    );
  });

  it('savePages aborts all writes when any expected version is stale', async () => {
    const meta = await repo.loadMeta();
    const sourceId = meta.activePageId;
    const source = await repo.loadPage(sourceId);

    const created = await repo.createPage('目标页', meta.revision);
    const targetId = created.page.id;
    const staleTarget = await repo.loadPage(targetId);

    await repo.savePage(targetId, { nodes: [{ id: 't1', title: 'target', status: 'todo' }], edges: [] }, staleTarget.version);

    await expect(
      repo.savePages([
        {
          pageId: sourceId,
          data: {
            nodes: [...source.nodes, { id: 'new-source', title: 'source', status: 'todo' }],
            edges: source.edges,
          },
          expectedVersion: source.version,
        },
        {
          pageId: targetId,
          data: {
            nodes: [{ id: 'stale-write', title: 'stale', status: 'todo' }],
            edges: [],
          },
          expectedVersion: staleTarget.version,
        },
      ]),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const sourceAfter = await repo.loadPage(sourceId);
    const targetAfter = await repo.loadPage(targetId);

    expect(sourceAfter.nodes.map((node) => node.id)).toEqual(source.nodes.map((node) => node.id));
    expect(targetAfter.nodes.map((node) => node.id)).toEqual(['t1']);
  });

  it('rolls back earlier page writes if a later page write fails', async () => {
    const meta = await repo.loadMeta();
    const sourceId = meta.activePageId;
    const sourceBefore = await repo.loadPage(sourceId);
    const created = await repo.createPage('目标页', meta.revision);
    const targetId = created.page.id;
    const targetBefore = await repo.loadPage(targetId);
    const originalWriteFile = fs.writeFile;
    let failedTargetWrite = false;

    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const [filePath] = args;
      if (
        !failedTargetWrite &&
        typeof filePath === 'string' &&
        filePath.endsWith(`${targetId}.json.tmp`)
      ) {
        failedTargetWrite = true;
        throw new Error('simulated target write failure');
      }
      return originalWriteFile(...(args as Parameters<typeof fs.writeFile>));
    });

    try {
      await expect(
        repo.savePages([
          {
            pageId: sourceId,
            data: {
              nodes: [...sourceBefore.nodes, { id: 'source-new', title: 'source-new', status: 'todo' }],
              edges: sourceBefore.edges,
            },
            expectedVersion: sourceBefore.version,
          },
          {
            pageId: targetId,
            data: {
              nodes: [{ id: 'target-new', title: 'target-new', status: 'todo' }],
              edges: [],
            },
            expectedVersion: targetBefore.version,
          },
        ]),
      ).rejects.toThrow('simulated target write failure');

      const sourceAfter = await repo.loadPage(sourceId);
      const targetAfter = await repo.loadPage(targetId);

      expect(sourceAfter).toEqual(sourceBefore);
      expect(targetAfter).toEqual(targetBefore);
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it('recovers a pending multi-page save journal before serving reads', async () => {
    const meta = await repo.loadMeta();
    const sourceId = meta.activePageId;
    const sourceBefore = await repo.loadPage(sourceId);
    const created = await repo.createPage('目标页', meta.revision);
    const targetId = created.page.id;
    const targetBefore = await repo.loadPage(targetId);
    const journalPath = path.join(userDir, '.save-pages-journal.json');

    await fs.writeFile(
      repoPagePath(userDir, sourceId),
      JSON.stringify({
        ...sourceBefore,
        version: (sourceBefore.version ?? 0) + 1,
        nodes: [...sourceBefore.nodes, { id: 'partial', title: 'partial', status: 'todo' }],
      }),
      'utf-8',
    );
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        entries: [
          {
            pageId: sourceId,
            previousRaw: JSON.stringify(sourceBefore),
          },
          {
            pageId: targetId,
            previousRaw: JSON.stringify(targetBefore),
          },
        ],
      }),
      'utf-8',
    );

    const recovered = await repo.loadPage(sourceId);

    expect(recovered).toEqual(sourceBefore);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent createPage calls so one stale write cannot win', async () => {
    const meta = await repo.loadMeta();
    const gate = createDeferred<void>();
    const originalWriteFile = fs.writeFile;
    let writeCalls = 0;

    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      writeCalls += 1;
      if (writeCalls === 1) {
        await gate.promise;
      }
      return originalWriteFile(...(args as Parameters<typeof fs.writeFile>));
    });

    try {
      const first = repo.createPage('并发一', meta.revision);
      const second = repo.createPage('并发二', meta.revision);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writeCalls).toBe(1);

      gate.resolve();
      const results = await Promise.allSettled([first, second]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        MetaVersionConflictError,
      );

      const nextMeta = await repo.loadMeta();
      expect(nextMeta.pages.map((p) => p.title)).toContain('并发一');
      expect(nextMeta.pages.map((p) => p.title)).not.toContain('并发二');
    } finally {
      writeFileSpy.mockRestore();
      gate.resolve();
    }
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function repoPagePath(userDir: string, pageId: string): string {
  return path.join(userDir, 'pages', `${pageId}.json`);
}
