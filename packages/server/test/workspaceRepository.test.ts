import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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

  it('rejects invalid task hierarchies at the repository boundary', async () => {
    const meta = await repo.loadMeta();
    const page = await repo.loadPage(meta.activePageId);

    await expect(
      repo.savePage(
        meta.activePageId,
        {
          nodes: [{ id: 'child', title: 'child', status: 'todo', parentId: 'missing' }],
          edges: [],
        },
        page.version,
      ),
    ).rejects.toThrow('invalid hierarchy (missing-parent');
  });

  it('reads legacy long titles but rejects them on new writes', async () => {
    const meta = await repo.loadMeta();
    const pageId = meta.activePageId;
    const longPageTitle = 'p'.repeat(101);
    const longTaskTitle = 't'.repeat(201);

    await fs.writeFile(
      path.join(userDir, 'meta.json'),
      JSON.stringify({
        ...meta,
        pages: meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: longPageTitle } : page),
      }),
    );
    await fs.writeFile(
      path.join(userDir, 'pages', `${pageId}.json`),
      JSON.stringify({
        version: 0,
        nodes: [{ id: 'legacy', title: longTaskTitle, status: 'todo' }],
        edges: [],
      }),
    );

    expect((await repo.loadMeta()).pages[0]?.title).toBe(longPageTitle);
    expect((await repo.loadPage(pageId)).nodes[0]?.title).toBe(longTaskTitle);
    await expect(
      repo.savePage(pageId, {
        nodes: [
          { id: 'legacy', title: longTaskTitle, status: 'todo' },
          { id: 'new', title: 'normal', status: 'todo' },
        ],
        edges: [],
      }),
    ).resolves.toBe(1);
    await expect(repo.createPage(longPageTitle)).rejects.toThrow('page title exceeds 100');
    await expect(
      repo.savePage(pageId, {
        nodes: [{ id: 'new', title: longTaskTitle, status: 'todo' }],
        edges: [],
      }),
    ).rejects.toThrow('task title exceeds 200');
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
      // 等待第一个 createPage 进入 writeFile（可能还需要等 I/O）
      await vi.waitFor(() => {
        expect(writeCalls).toBe(1);
      }, { timeout: 5000 });

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

  it('lists backups newest first and restores a selected backup', async () => {
    const repo = new FileWorkspaceRepository(userDir, rootDir);
    const meta = await repo.loadMeta();
    const pageId = meta.pages[0]!.id;
    const original = await repo.loadPage(pageId);

    await repo.createBackup(pageId);
    const first = (await repo.listBackups(pageId))[0]!;

    await repo.savePage(pageId, {
      nodes: [{ id: 'changed', title: 'Changed', status: 'todo', x: 1, y: 2 }],
      edges: [],
      version: original.version,
    });
    await repo.createBackup(pageId);

    const backups = await repo.listBackups(pageId);
    expect(backups.length).toBeGreaterThanOrEqual(2);
    expect(backups[0]!.createdAt >= backups[1]!.createdAt).toBe(true);
    expect(Number.isNaN(new Date(backups[0]!.createdAt).getTime())).toBe(false);
    expect(backups[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const liveBeforeRestore = await repo.loadPage(pageId);
    const restored = await repo.restoreBackup(pageId, first.name);
    expect(restored.nodes.map((n) => n.id)).toEqual(original.nodes.map((n) => n.id));
    expect(restored.version).toBeGreaterThan(liveBeforeRestore.version!);
    await expect(repo.savePage(pageId, liveBeforeRestore, original.version))
      .rejects.toBeInstanceOf(VersionConflictError);
  });

  it('rejects an invalid backup without overwriting the live page', async () => {
    const meta = await repo.loadMeta();
    const pageId = meta.activePageId;
    const live = await repo.loadPage(pageId);
    await repo.createBackup(pageId);
    const backup = (await repo.listBackups(pageId))[0]!;
    await fs.writeFile(path.join(userDir, 'backups', pageId, backup.name), JSON.stringify({
      nodes: [{ id: 'child', title: 'child', status: 'todo', parentId: 'missing' }], edges: [],
    }));

    await expect(repo.restoreBackup(pageId, backup.name)).rejects.toThrow('invalid hierarchy');
    await expect(repo.loadPage(pageId)).resolves.toEqual(live);
  });

  it('restores the latest backup while preserving newer un-backed changes', async () => {
    const meta = await repo.loadMeta();
    const pageId = meta.pages[0]!.id;
    const original = await repo.loadPage(pageId);

    await repo.createBackup(pageId);

    await repo.savePage(pageId, {
      nodes: [{ id: 'backup-version', title: 'Backup version', status: 'todo', x: 10, y: 20 }],
      edges: [],
      version: original.version,
    });
    await repo.createBackup(pageId);

    const backedUp = await repo.loadPage(pageId);
    await repo.savePage(pageId, {
      nodes: [{ id: 'live-version', title: 'Live version', status: 'todo', x: 30, y: 40 }],
      edges: [],
      version: backedUp.version,
    });

    const live = await repo.loadPage(pageId);
    const restored = await repo.restoreLatestBackup(pageId);
    expect(restored.nodes.map((n) => n.id)).toEqual(['backup-version']);
    expect(restored.version).toBeGreaterThan(live.version!);

    const current = await repo.loadPage(pageId);
    expect(current).toEqual(restored);
  });

  it('exports and imports a complete workspace snapshot', async () => {
    const repo = new FileWorkspaceRepository(userDir, rootDir);
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;

    await repo.savePage(pageId, {
      nodes: [{ id: 'after-export', title: 'After export', status: 'todo', x: 10, y: 20 }],
      edges: [],
      version: before.pages[pageId]!.version,
    });

    const restoredMeta = await repo.importWorkspace(before);
    const restored = await repo.loadPage(pageId);

    expect(restoredMeta.pages.map((p) => p.id)).toEqual(before.meta.pages.map((p) => p.id));
    expect(restoredMeta.revision).toBeGreaterThan(before.meta.revision);
    expect(restored.nodes.map((n) => n.id)).toEqual(before.pages[pageId]!.nodes.map((n) => n.id));
  });

  it('round-trips legacy long titles through export and import', async () => {
    const meta = await repo.loadMeta();
    const pageId = meta.activePageId;
    const pageTitle = 'p'.repeat(101);
    const taskTitle = 't'.repeat(201);
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify({
      ...meta,
      pages: meta.pages.map((page) => ({ ...page, title: pageTitle })),
    }));
    await fs.writeFile(path.join(userDir, 'pages', `${pageId}.json`), JSON.stringify({
      version: 0,
      nodes: [{ id: 'legacy', title: taskTitle, status: 'todo' }],
      edges: [],
    }));

    const exported = await repo.exportWorkspace();
    await repo.importWorkspace(exported);

    expect((await repo.loadMeta()).pages[0]?.title).toBe(pageTitle);
    expect((await repo.loadPage(pageId)).nodes[0]?.title).toBe(taskTitle);
  });

  it('rejects malformed workspace imports without mutating live workspace state', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;

    await repo.savePage(pageId, {
      nodes: [{ id: 'live-state', title: 'Live state', status: 'todo', x: 10, y: 20 }],
      edges: [],
      version: before.pages[pageId]!.version,
    });

    const liveMeta = await repo.loadMeta();
    const livePage = await repo.loadPage(pageId);
    const malformed = {
      ...before,
      meta: { ...before.meta, activePageId: 'missing-page' },
      pages: {
        ...before.pages,
        rogue: before.pages[pageId]!,
      },
    };

    await expect(repo.importWorkspace(malformed)).rejects.toThrow();
    await expect(repo.loadMeta()).resolves.toEqual(liveMeta);
    await expect(repo.loadPage(pageId)).resolves.toEqual(livePage);
  });

  it('advances imported page versions instead of reusing stale clocks', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const importedVersion = 42;
    const imported = {
      ...before,
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 15, y: 25 }],
          version: importedVersion,
        },
      },
    };

    await repo.importWorkspace(imported);

    const restored = await repo.loadPage(pageId);
    expect(restored.version).toBe(importedVersion + 1);
    expect(restored.nodes).toEqual([
      { id: 'imported-node', title: 'Imported node', status: 'todo', x: 15, y: 25 },
    ]);
  });

  it('keeps a committed workspace import during startup recovery', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const imported = {
      ...before,
      meta: {
        ...before.meta,
        revision: before.meta.revision + 1,
        pages: before.meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: 'Imported title' } : page,
        ),
      },
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          version: before.pages[pageId]!.version + 1,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 50, y: 60 }],
          edges: [],
        },
      },
    };
    const journalPath = path.join(userDir, '.workspace-import-journal.json');
    const backupDirName = '.workspace-import-pages-backup-test';
    const stagingDirName = '.workspace-import-staging-test';
    const backupDir = path.join(userDir, backupDirName);
    const stagingDir = path.join(userDir, stagingDirName);

    await fs.rm(path.join(userDir, 'pages'), { recursive: true, force: true });
    await fs.mkdir(path.join(userDir, 'pages'), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(repoPagePath(userDir, pageId), JSON.stringify(imported.pages[pageId], null, 2), 'utf-8');
    await fs.writeFile(
      path.join(backupDir, `${pageId}.json`),
      JSON.stringify(before.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        phase: 'committed',
        previousMetaRaw: JSON.stringify(before.meta, null, 2),
        backupPagesDirName: backupDirName,
        stagingDirName,
      }),
      'utf-8',
    );

    const recoveredRepo = new FileWorkspaceRepository(userDir, rootDir);
    const recoveredMeta = await recoveredRepo.loadMeta();
    const recoveredPage = await recoveredRepo.loadPage(pageId);

    expect(recoveredMeta.pages.find((page) => page.id === pageId)?.title).toBe('Imported title');
    expect(recoveredMeta.revision).toBe(imported.meta.revision);
    expect(recoveredPage).toEqual(imported.pages[pageId]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(backupDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back an incomplete workspace import during startup recovery', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const imported = {
      ...before,
      meta: {
        ...before.meta,
        revision: before.meta.revision + 1,
        pages: before.meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: 'Imported title' } : page,
        ),
      },
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          version: before.pages[pageId]!.version + 1,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 50, y: 60 }],
          edges: [],
        },
      },
    };
    const journalPath = path.join(userDir, '.workspace-import-journal.json');
    const backupDirName = '.workspace-import-pages-backup-test';
    const stagingDirName = '.workspace-import-staging-test';
    const backupDir = path.join(userDir, backupDirName);
    const stagingDir = path.join(userDir, stagingDirName);

    await fs.rm(path.join(userDir, 'pages'), { recursive: true, force: true });
    await fs.mkdir(path.join(userDir, 'pages'), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(repoPagePath(userDir, pageId), JSON.stringify(imported.pages[pageId], null, 2), 'utf-8');
    await fs.writeFile(
      path.join(backupDir, `${pageId}.json`),
      JSON.stringify(before.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify(before.meta, null, 2), 'utf-8');
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        phase: 'staged_pages_live',
        previousMetaRaw: JSON.stringify(before.meta, null, 2),
        backupPagesDirName: backupDirName,
        stagingDirName,
      }),
      'utf-8',
    );

    const recoveredRepo = new FileWorkspaceRepository(userDir, rootDir);
    const recoveredMeta = await recoveredRepo.loadMeta();
    const recoveredPage = await recoveredRepo.loadPage(pageId);

    expect(recoveredMeta).toEqual(before.meta);
    expect(recoveredPage).toEqual(before.pages[pageId]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(backupDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back when recovery restarts after rollback has started but before old pages are restored', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const imported = {
      ...before,
      meta: {
        ...before.meta,
        revision: before.meta.revision + 1,
        pages: before.meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: 'Imported title' } : page,
        ),
      },
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          version: before.pages[pageId]!.version + 1,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 50, y: 60 }],
          edges: [],
        },
      },
    };
    const journalPath = path.join(userDir, '.workspace-import-journal.json');
    const backupDirName = '.workspace-import-pages-backup-test';
    const stagingDirName = '.workspace-import-staging-test';
    const backupDir = path.join(userDir, backupDirName);
    const stagingDir = path.join(userDir, stagingDirName);
    const stagedPagesDir = path.join(stagingDir, 'pages');

    await fs.rm(path.join(userDir, 'pages'), { recursive: true, force: true });
    await fs.mkdir(path.join(userDir, 'pages'), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(stagedPagesDir, { recursive: true });
    await fs.writeFile(repoPagePath(userDir, pageId), JSON.stringify(imported.pages[pageId], null, 2), 'utf-8');
    await fs.writeFile(
      path.join(backupDir, `${pageId}.json`),
      JSON.stringify(before.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      path.join(stagedPagesDir, `${pageId}.json`),
      JSON.stringify(imported.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        phase: 'rollback_started',
        previousMetaRaw: JSON.stringify(before.meta, null, 2),
        backupPagesDirName: backupDirName,
        stagingDirName,
        nextMetaSha256: hashJson(imported.meta),
        nextPageSha256ById: {
          [pageId]: hashJson(imported.pages[pageId]),
        },
      }),
      'utf-8',
    );

    const recoveredRepo = new FileWorkspaceRepository(userDir, rootDir);
    const recoveredMeta = await recoveredRepo.loadMeta();
    const recoveredPage = await recoveredRepo.loadPage(pageId);

    expect(recoveredMeta).toEqual(before.meta);
    expect(recoveredPage).toEqual(before.pages[pageId]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(backupDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues rollback when recovery restarts after old pages are restored but old meta is not', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const imported = {
      ...before,
      meta: {
        ...before.meta,
        revision: before.meta.revision + 1,
        pages: before.meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: 'Imported title' } : page,
        ),
      },
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          version: before.pages[pageId]!.version + 1,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 50, y: 60 }],
        },
      },
    };
    const journalPath = path.join(userDir, '.workspace-import-journal.json');
    const stagingDirName = '.workspace-import-staging-test';
    const stagingDir = path.join(userDir, stagingDirName);
    const stagedPagesDir = path.join(stagingDir, 'pages');

    await fs.rm(path.join(userDir, 'pages'), { recursive: true, force: true });
    await fs.mkdir(path.join(userDir, 'pages'), { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.mkdir(stagedPagesDir, { recursive: true });
    await fs.writeFile(repoPagePath(userDir, pageId), JSON.stringify(before.pages[pageId], null, 2), 'utf-8');
    await fs.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      path.join(stagedPagesDir, `${pageId}.json`),
      JSON.stringify(imported.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        phase: 'staged_pages_live',
        previousMetaRaw: JSON.stringify(before.meta, null, 2),
        backupPagesDirName: '.workspace-import-pages-backup-test',
        stagingDirName,
        nextMetaSha256: hashJson(imported.meta),
        nextPageSha256ById: {
          [pageId]: hashJson(imported.pages[pageId]),
        },
      }),
      'utf-8',
    );

    const recoveredRepo = new FileWorkspaceRepository(userDir, rootDir);
    const recoveredMeta = await recoveredRepo.loadMeta();
    const recoveredPage = await recoveredRepo.loadPage(pageId);

    expect(recoveredMeta).toEqual(before.meta);
    expect(recoveredPage).toEqual(before.pages[pageId]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes rollback when recovery restarts after old pages are restored but old meta is not', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const imported = {
      ...before,
      meta: {
        ...before.meta,
        revision: before.meta.revision + 1,
        pages: before.meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: 'Imported title' } : page,
        ),
      },
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          version: before.pages[pageId]!.version + 1,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 50, y: 60 }],
        },
      },
    };
    const journalPath = path.join(userDir, '.workspace-import-journal.json');
    const stagingDirName = '.workspace-import-staging-test';
    const stagingDir = path.join(userDir, stagingDirName);
    const stagedPagesDir = path.join(stagingDir, 'pages');

    await fs.rm(path.join(userDir, 'pages'), { recursive: true, force: true });
    await fs.mkdir(path.join(userDir, 'pages'), { recursive: true });
    await fs.mkdir(stagedPagesDir, { recursive: true });
    await fs.writeFile(repoPagePath(userDir, pageId), JSON.stringify(before.pages[pageId], null, 2), 'utf-8');
    await fs.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      path.join(stagedPagesDir, `${pageId}.json`),
      JSON.stringify(imported.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        phase: 'rollback_pages_restored',
        previousMetaRaw: JSON.stringify(before.meta, null, 2),
        backupPagesDirName: '.workspace-import-pages-backup-test',
        stagingDirName,
        nextMetaSha256: hashJson(imported.meta),
        nextPageSha256ById: {
          [pageId]: hashJson(imported.pages[pageId]),
        },
      }),
      'utf-8',
    );

    const recoveredRepo = new FileWorkspaceRepository(userDir, rootDir);
    const recoveredMeta = await recoveredRepo.loadMeta();
    const recoveredPage = await recoveredRepo.loadPage(pageId);

    expect(recoveredMeta).toEqual(before.meta);
    expect(recoveredPage).toEqual(before.pages[pageId]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a successful import when recovery restarts after meta is written but before import cleanup', async () => {
    const before = await repo.exportWorkspace();
    const pageId = before.meta.pages[0]!.id;
    const imported = {
      ...before,
      meta: {
        ...before.meta,
        revision: before.meta.revision + 1,
        pages: before.meta.pages.map((page) =>
          page.id === pageId ? { ...page, title: 'Imported title' } : page,
        ),
      },
      pages: {
        ...before.pages,
        [pageId]: {
          ...before.pages[pageId]!,
          version: before.pages[pageId]!.version + 1,
          nodes: [{ id: 'imported-node', title: 'Imported node', status: 'todo', x: 50, y: 60 }],
          edges: [],
        },
      },
    };
    const journalPath = path.join(userDir, '.workspace-import-journal.json');
    const backupDirName = '.workspace-import-pages-backup-test';
    const stagingDirName = '.workspace-import-staging-test';
    const backupDir = path.join(userDir, backupDirName);
    const stagingDir = path.join(userDir, stagingDirName);
    const stagedPagesDir = path.join(stagingDir, 'pages');

    await fs.rm(path.join(userDir, 'pages'), { recursive: true, force: true });
    await fs.mkdir(path.join(userDir, 'pages'), { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(stagedPagesDir, { recursive: true });
    await fs.writeFile(repoPagePath(userDir, pageId), JSON.stringify(imported.pages[pageId], null, 2), 'utf-8');
    await fs.writeFile(
      path.join(backupDir, `${pageId}.json`),
      JSON.stringify(before.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(stagingDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      path.join(stagedPagesDir, `${pageId}.json`),
      JSON.stringify(imported.pages[pageId], null, 2),
      'utf-8',
    );
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify(imported.meta, null, 2), 'utf-8');
    await fs.writeFile(
      journalPath,
      JSON.stringify({
        phase: 'meta_commit_started',
        previousMetaRaw: JSON.stringify(before.meta, null, 2),
        backupPagesDirName: backupDirName,
        stagingDirName,
        nextMetaSha256: hashJson(imported.meta),
        nextPageSha256ById: {
          [pageId]: hashJson(imported.pages[pageId]),
        },
      }),
      'utf-8',
    );

    const recoveredRepo = new FileWorkspaceRepository(userDir, rootDir);
    const recoveredMeta = await recoveredRepo.loadMeta();
    const recoveredPage = await recoveredRepo.loadPage(pageId);

    expect(recoveredMeta.pages.find((page) => page.id === pageId)?.title).toBe('Imported title');
    expect(recoveredMeta.revision).toBe(imported.meta.revision);
    expect(recoveredPage).toEqual(imported.pages[pageId]);
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(backupDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
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

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
