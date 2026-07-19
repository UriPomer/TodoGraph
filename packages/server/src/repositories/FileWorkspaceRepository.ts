import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  GraphSchema,
  MAX_PAGE_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  MetaSchema,
  PageDataSchema,
  SYSTEM_HIERARCHY_PAGE_ID,
  SYSTEM_HIERARCHY_PAGE_TITLE,
  pageSupportsDependencyGraph,
  resolveNodeOverlaps,
  validateDependencyEdges,
  validateNoSiblingOverlaps,
  validateTaskHierarchy,
  type Graph,
  type Meta,
  type PageData,
  type PageInfo,
} from '@todograph/shared';
import { isDAG } from '@todograph/core';
import {
  type BackupInfo,
  MetaVersionConflictError,
  NodeOverlapError,
  TaskTitleTooLongError,
  type WorkspaceExport,
  type WorkspaceRepository,
  VersionConflictError,
} from './Repository.js';
import { SEED_GRAPH } from './FileRepository.js';

interface LockState {
  tail: Promise<void>;
  active: number;
}

interface SavePagesJournalEntry {
  pageId: string;
  previousRaw: string | null;
}

interface SavePagesJournal {
  entries: SavePagesJournalEntry[];
}

type WorkspaceImportJournalPhase =
  | 'prepared'
  | 'live_pages_backed_up'
  | 'staged_pages_live'
  | 'meta_commit_started'
  | 'rollback_started'
  | 'rollback_pages_restored'
  | 'committed';

interface WorkspaceImportJournal {
  phase: WorkspaceImportJournalPhase;
  previousMetaRaw: string | null;
  backupPagesDirName: string | null;
  stagingDirName: string;
  nextMetaSha256: string;
  nextPageSha256ById: Record<string, string>;
}

const workspaceLocks = new Map<string, LockState>();

async function withWorkspaceLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const state = workspaceLocks.get(key) ?? { tail: Promise.resolve(), active: 0 };
  workspaceLocks.set(key, state);
  state.active += 1;

  const previous = state.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => gate, () => gate);

  try {
    await previous;
    return await task();
  } finally {
    release();
    state.active -= 1;
    if (state.active === 0) {
      workspaceLocks.delete(key);
    }
  }
}

/**
 * 磁盘布局：
 *   {dataDir}/meta.json              —— 工作区元信息（版本/页面列表/active/settings）
 *   {dataDir}/pages/{pageId}.json    —— 每个页面的 nodes+edges
 *   {dataDir}/tasks.json.v1.bak      —— 首次迁移保留的老数据备份
 *
 * 原子写：所有 writeFile 走 tmp+rename 模式，避免崩溃损坏主数据。
 */
export class FileWorkspaceRepository implements WorkspaceRepository {
  private readonly dataDir: string;
  private readonly metaPath: string;
  private readonly pagesDir: string;
  private readonly legacyPath: string;
  private readonly legacyBackupPath: string;
  private readonly savePagesJournalPath: string;
  private readonly workspaceImportJournalPath: string;
  /** Old root-level data dir (pre-multi-user). If set and meta.json exists there, migrate it in. */
  private readonly legacyV2Dir?: string;

  constructor(dataDir: string, legacyV2Dir?: string) {
    this.dataDir = dataDir;
    this.metaPath = path.join(dataDir, 'meta.json');
    this.pagesDir = path.join(dataDir, 'pages');
    this.legacyPath = path.join(dataDir, 'tasks.json');
    this.legacyBackupPath = path.join(dataDir, 'tasks.json.v1.bak');
    this.savePagesJournalPath = path.join(dataDir, '.save-pages-journal.json');
    this.workspaceImportJournalPath = path.join(dataDir, '.workspace-import-journal.json');
    this.legacyV2Dir = legacyV2Dir;
  }

  async loadMeta(): Promise<Meta> {
    return this.runLocked(() => this.loadMetaUnlocked());
  }

  async loadPage(pageId: string): Promise<PageData> {
    return this.runLocked(() => this.loadPageUnlocked(pageId));
  }

  async savePage(pageId: string, data: PageData, expectedVersion?: number): Promise<number> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertPageAllowsDependencies(meta, pageId, data);
      return this.savePageUnlocked(pageId, data, expectedVersion);
    });
  }

  async savePages(
    entries: Array<{ pageId: string; data: PageData; expectedVersion?: number }>,
  ): Promise<number[]> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      for (const entry of entries) {
        this.assertPageAllowsDependencies(meta, entry.pageId, entry.data);
      }
      return this.savePagesUnlocked(entries);
    });
  }

  async createPage(title: string, expectedRevision?: number): Promise<{ page: PageInfo; meta: Meta }> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      const id = makePageId(title);
      const maxOrder = meta.pages.reduce((m, p) => Math.max(m, p.order), -1);
      const cleanedTitle = title.trim() || '新页面';
      assertPageTitleLength(cleanedTitle);
      const info: PageInfo = {
        id,
        title: cleanedTitle,
        order: maxOrder + 1,
        createdAt: new Date().toISOString(),
      };
      // Page first, then meta: committed metadata must never reference a missing page file.
      await this.savePageUnlocked(id, { nodes: [], edges: [] });
      const nextMeta = this.bumpMeta({ ...meta, pages: [...meta.pages, info] });
      await this.atomicWriteJson(this.metaPath, nextMeta);
      return { page: info, meta: nextMeta };
    });
  }

  async deletePage(pageId: string, expectedRevision?: number): Promise<Meta> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      if (pageId === SYSTEM_HIERARCHY_PAGE_ID) {
        throw new Error('system page cannot be deleted');
      }
      if (meta.pages.length <= 1) {
        throw new Error('last page cannot be deleted');
      }
      const nextPages = meta.pages.filter((p) => p.id !== pageId);
      if (nextPages.length === meta.pages.length) {
        throw new Error(`page not found: ${pageId}`);
      }
      const nextActive =
        meta.activePageId === pageId
          ? (nextPages.find((page) => page.id !== SYSTEM_HIERARCHY_PAGE_ID)?.id ??
            nextPages[0]?.id ??
            meta.activePageId)
          : meta.activePageId;
      const nextMeta = this.bumpMeta({ ...meta, pages: nextPages, activePageId: nextActive });
      // Meta first, then unlink: a failed unlink leaves an invisible orphan, not a ghost page.
      await this.atomicWriteJson(this.metaPath, nextMeta);
      try {
        await fs.unlink(this.pageFilePath(pageId));
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        // Meta is the commit point. A failed unlink leaves an unreachable orphan,
        // but must not turn a committed delete into an error.
        if (e.code !== 'ENOENT') return nextMeta;
      }
      return nextMeta;
    });
  }

  async renamePage(pageId: string, title: string, expectedRevision?: number): Promise<Meta> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      const idx = meta.pages.findIndex((p) => p.id === pageId);
      if (idx < 0) throw new Error(`page not found: ${pageId}`);
      const cleaned = title.trim() || meta.pages[idx]!.title;
      if (cleaned !== meta.pages[idx]!.title) assertPageTitleLength(cleaned);
      const nextPages = [...meta.pages];
      nextPages[idx] = { ...nextPages[idx]!, title: cleaned };
      const nextMeta = this.bumpMeta({ ...meta, pages: nextPages });
      await this.atomicWriteJson(this.metaPath, nextMeta);
      return nextMeta;
    });
  }

  async reorderPages(ids: string[], expectedRevision?: number): Promise<Meta> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      const byId = new Map(meta.pages.map((p) => [p.id, p]));
      if (ids.length !== meta.pages.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
        throw new Error('reorder ids do not match existing pages');
      }
      const nextPages = pinSystemPageFirst(
        ids.map((id, order) => ({ ...byId.get(id)!, order })),
      );
      const nextMeta = this.bumpMeta({ ...meta, pages: nextPages });
      await this.atomicWriteJson(this.metaPath, nextMeta);
      return nextMeta;
    });
  }

  async setActivePage(pageId: string, expectedRevision?: number): Promise<Meta> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      if (!meta.pages.some((p) => p.id === pageId)) {
        throw new Error(`page not found: ${pageId}`);
      }
      if (meta.activePageId === pageId) return meta;
      const nextMeta = this.bumpMeta({ ...meta, activePageId: pageId });
      await this.atomicWriteJson(this.metaPath, nextMeta);
      return nextMeta;
    });
  }

  async exportWorkspace(): Promise<WorkspaceExport> {
    return this.runLocked(() => this.exportWorkspaceUnlocked());
  }

  async importWorkspace(data: WorkspaceExport): Promise<Meta> {
    return this.runLocked(async () => {
      const validated = this.validateWorkspaceImport(data);
      const importBackupDir = path.join(this.dataDir, 'backups', '_workspace-imports');
      await fs.mkdir(importBackupDir, { recursive: true });
      const snapshot = await this.exportWorkspaceUnlocked().catch(() => null);
      if (snapshot) {
        const name = new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        await this.atomicWriteText(
          path.join(importBackupDir, name),
          JSON.stringify(snapshot, null, 2),
        );
      }
      const meta = { ...validated.meta, revision: Math.max(validated.meta.revision, snapshot?.meta.revision ?? 0) + 1 };
      const pages = Object.fromEntries(Object.entries(validated.pages).map(([pageId, page]) =>
        [pageId, {
          ...page,
          nodes: resolveNodeOverlaps(page.nodes).nodes,
          version: Math.max(page.version ?? 0, snapshot?.pages[pageId]?.version ?? 0) + 1,
        }]));

      const stagingDirName = `.workspace-import-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const stagingDir = path.join(this.dataDir, stagingDirName);
      const stagedPagesDir = path.join(stagingDir, 'pages');
      const stagedMetaPath = path.join(stagingDir, 'meta.json');
      await fs.mkdir(stagedPagesDir, { recursive: true });
      for (const [pageId, pageData] of Object.entries(pages)) {
        await this.atomicWriteJson(path.join(stagedPagesDir, `${pageId}.json`), pageData);
      }
      await this.atomicWriteJson(stagedMetaPath, meta);

      const previousMetaRaw = await fs.readFile(this.metaPath, 'utf-8').catch((err: unknown) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return null;
        throw err;
      });
      const backupPagesDirName = (await this.pathExists(this.pagesDir))
        ? `.workspace-import-pages-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : null;
      const journal: WorkspaceImportJournal = {
        phase: 'prepared',
        previousMetaRaw,
        backupPagesDirName,
        stagingDirName,
        nextMetaSha256: this.hashJson(meta),
        nextPageSha256ById: Object.fromEntries(
          Object.entries(pages).map(([pageId, pageData]) => [pageId, this.hashJson(pageData)]),
        ),
      };
      await this.atomicWriteJson(this.workspaceImportJournalPath, journal);

      try {
        if (backupPagesDirName) {
          await fs.rename(this.pagesDir, path.join(this.dataDir, backupPagesDirName));
          journal.phase = 'live_pages_backed_up';
          await this.atomicWriteJson(this.workspaceImportJournalPath, journal);
        }

        await fs.rename(stagedPagesDir, this.pagesDir);
        journal.phase = 'staged_pages_live';
        await this.atomicWriteJson(this.workspaceImportJournalPath, journal);

        journal.phase = 'meta_commit_started';
        await this.atomicWriteJson(this.workspaceImportJournalPath, journal);

        await this.atomicWriteJson(this.metaPath, meta);
        journal.phase = 'committed';
        await this.atomicWriteJson(this.workspaceImportJournalPath, journal);
      } catch (err) {
        await this.restoreWorkspaceImportJournalUnlocked(journal);
        throw err;
      }

      await this.finalizeWorkspaceImportJournalUnlocked(journal);
      return meta;
    });
  }

  async listPageMtimes(): Promise<Array<{ pageId: string; mtimeMs: number }>> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      const out: Array<{ pageId: string; mtimeMs: number }> = [];
      for (const p of meta.pages) {
        try {
          const st = await fs.stat(this.pageFilePath(p.id));
          out.push({ pageId: p.id, mtimeMs: st.mtimeMs });
        } catch {
          out.push({ pageId: p.id, mtimeMs: 0 });
        }
      }
      return out;
    });
  }

  async createBackup(pageId: string): Promise<void> {
    return this.runLocked(async () => {
      const src = this.pageFilePath(pageId);
      const backupDir = path.join(this.dataDir, 'backups', pageId);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(backupDir, `${ts}.json`);
      await fs.mkdir(backupDir, { recursive: true });
      await fs.copyFile(src, dest);

      const entries = await fs.readdir(backupDir);
      // Retention is bounded so automatic backups cannot grow without limit.
      const jsonFiles = entries
        .filter((f) => f.endsWith('.json'))
        .sort();
      while (jsonFiles.length > 50) {
        const oldest = jsonFiles.shift()!;
        try {
          await fs.unlink(path.join(backupDir, oldest));
        } catch {
        }
      }
    });
  }

  async listBackups(pageId: string): Promise<BackupInfo[]> {
    this.assertSafePageId(pageId);
    return this.runLocked(() => this.listBackupsUnlocked(pageId));
  }

  async restoreBackup(pageId: string, backupName: string): Promise<PageData> {
    this.assertSafePageId(pageId);
    this.assertSafeBackupName(backupName);
    return this.runLocked(() => this.restoreBackupUnlocked(pageId, backupName));
  }

  async restoreLatestBackup(pageId: string): Promise<PageData> {
    this.assertSafePageId(pageId);
    return this.runLocked(async () => {
      const backups = await this.listBackupsUnlocked(pageId);
      if (backups.length === 0) {
        throw new Error(`no backup found for page ${pageId}`);
      }
      return this.restoreBackupUnlocked(pageId, backups[0]!.name);
    });
  }


  private async listBackupsUnlocked(pageId: string): Promise<BackupInfo[]> {
    const backupDir = path.join(this.dataDir, 'backups', pageId);
    try {
      const entries = await fs.readdir(backupDir);
      const backups = await Promise.all(
        entries
          .filter((name) => name.endsWith('.json'))
          .map(async (name): Promise<BackupInfo> => {
            const fullPath = path.join(backupDir, name);
            const stat = await fs.stat(fullPath);
            return {
              name,
              createdAt: backupNameToIso(name),
              size: stat.size,
            };
          }),
      );
      return backups.sort((a, b) => b.name.localeCompare(a.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async restoreBackupUnlocked(pageId: string, backupName: string): Promise<PageData> {
    const src = path.join(this.dataDir, 'backups', pageId, backupName);
    const restored = parseValidPageData(JSON.parse(await fs.readFile(src, 'utf-8')), pageId, undefined, false);
    const current = await this.loadPageUnlocked(pageId);
    const next = {
      ...restored,
      nodes: resolveNodeOverlaps(restored.nodes).nodes,
      version: Math.max(restored.version ?? 0, current.version ?? 0) + 1,
    };
    await this.atomicWriteJson(this.pageFilePath(pageId), next);
    return next;
  }

  private assertSafeBackupName(backupName: string): void {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(backupName)) {
      throw new Error('invalid backup name');
    }
  }

  private pageFilePath(pageId: string): string {
    this.assertSafePageId(pageId);
    return path.join(this.pagesDir, pageId + '.json');
  }

  private assertSafePageId(pageId: string): void {
    // Page IDs become path segments; reject traversal and separators at this boundary.
    if (!isSafePageId(pageId)) {
      throw new Error(`invalid page id: ${pageId}`);
    }
  }

  private async atomicWriteJson(target: string, data: unknown): Promise<void> {
    await this.atomicWriteText(target, JSON.stringify(data, null, 2));
  }

  private async atomicWriteText(target: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, target);
  }

  private assertMetaRevision(meta: Meta, expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== meta.revision) {
      throw new MetaVersionConflictError(meta.revision);
    }
  }

  private bumpMeta(meta: Meta): Meta {
    return { ...meta, revision: (meta.revision ?? 0) + 1 };
  }

  private workspaceLockKey(): string {
    return path.resolve(this.dataDir);
  }

  private async runLocked<T>(task: () => Promise<T>): Promise<T> {
    return withWorkspaceLock(this.workspaceLockKey(), async () => {
      await this.recoverPendingWorkspaceImportUnlocked();
      await this.recoverPendingSavePagesUnlocked();
      return task();
    });
  }

  private async loadMetaUnlocked(): Promise<Meta> {
    let meta: Meta;
    try {
      const raw = await fs.readFile(this.metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      meta = MetaSchema.parse(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      if (this.legacyV2Dir) {
        const legacyMetaPath = path.join(this.legacyV2Dir, 'meta.json');
        let legacyMetaExists = false;
        try {
          await fs.access(legacyMetaPath);
          legacyMetaExists = true;
        } catch (accessError) {
          if ((accessError as NodeJS.ErrnoException).code !== 'ENOENT') throw accessError;
        }
        if (legacyMetaExists) {
          meta = await this.migrateFromLegacyV2(legacyMetaPath);
          return this.ensureSystemHierarchyPageUnlocked(meta);
        }
      }
      meta = await this.migrateFromLegacyOrSeed();
    }
    return this.ensureSystemHierarchyPageUnlocked(meta);
  }

  private async ensureSystemHierarchyPageUnlocked(meta: Meta): Promise<Meta> {
    const existingIndex = meta.pages.findIndex((page) => page.id === SYSTEM_HIERARCHY_PAGE_ID);
    if (existingIndex >= 0) {
      const pages = [...meta.pages];
      pages[existingIndex] = { ...pages[existingIndex]!, kind: 'hierarchy' };
      const orderedPages = pinSystemPageFirst(pages);
      const unchanged = orderedPages.every((page, index) =>
        page.id === meta.pages[index]?.id &&
        page.order === meta.pages[index]?.order &&
        page.kind === meta.pages[index]?.kind,
      );
      if (unchanged) return meta;
      const nextMeta = this.bumpMeta({ ...meta, pages: orderedPages });
      await this.atomicWriteJson(this.metaPath, nextMeta);
      return nextMeta;
    }

    await this.savePageUnlocked(SYSTEM_HIERARCHY_PAGE_ID, { nodes: [], edges: [] });
    const maxOrder = meta.pages.reduce((max, page) => Math.max(max, page.order), -1);
    const systemPage: PageInfo = {
      id: SYSTEM_HIERARCHY_PAGE_ID,
      title: SYSTEM_HIERARCHY_PAGE_TITLE,
      order: maxOrder + 1,
      createdAt: new Date().toISOString(),
      kind: 'hierarchy',
    };
    const nextMeta = this.bumpMeta({
      ...meta,
      pages: pinSystemPageFirst([...meta.pages, systemPage]),
    });
    await this.atomicWriteJson(this.metaPath, nextMeta);
    return nextMeta;
  }

  private assertPageAllowsDependencies(meta: Meta, pageId: string, data: PageData): void {
    const page = meta.pages.find((candidate) => candidate.id === pageId);
    if (!pageSupportsDependencyGraph(page) && data.edges.length > 0) {
      throw new Error(`page does not support dependency edges: ${pageId}`);
    }
  }

  private async savePageUnlocked(pageId: string, data: PageData, expectedVersion?: number): Promise<number> {
    const filePath = this.pageFilePath(pageId);

    let currentVersion = 0;
    let legacyLongTitles = new Map<string, string>();
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      currentVersion = typeof parsed.version === 'number' ? parsed.version : 0;
      legacyLongTitles = collectLegacyLongTaskTitles(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }

    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new VersionConflictError(pageId, currentVersion);
    }

    const newVersion = currentVersion + 1;
    const valid = parseValidPageData(data, pageId, legacyLongTitles);
    assertNoNodeOverlaps(valid, pageId);
    await this.atomicWriteJson(filePath, { ...valid, version: newVersion });
    return newVersion;
  }

  private async savePagesUnlocked(
    entries: Array<{ pageId: string; data: PageData; expectedVersion?: number }>,
  ): Promise<number[]> {
    const checkedBase = await Promise.all(
      entries.map(async (entry) => {
        const filePath = this.pageFilePath(entry.pageId);
        let currentVersion = 0;
        let previousRaw: string | null = null;
        let legacyLongTitles = new Map<string, string>();
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          previousRaw = raw;
          const parsed = JSON.parse(raw);
          currentVersion = typeof parsed.version === 'number' ? parsed.version : 0;
          legacyLongTitles = collectLegacyLongTaskTitles(parsed);
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') throw err;
        }
        return {
          pageId: entry.pageId,
          filePath,
          currentVersion,
          previousRaw,
          legacyLongTitles,
        };
      }),
    );
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const checked = checkedBase[i]!;
      if (entry.expectedVersion !== undefined && entry.expectedVersion !== checked.currentVersion) {
        throw new VersionConflictError(entry.pageId, checked.currentVersion);
      }
    }
    const checked = checkedBase.map((entry, index) => {
      const valid = parseValidPageData(entries[index]!.data, entry.pageId, entry.legacyLongTitles);
      assertNoNodeOverlaps(valid, entry.pageId);
      return { ...entry, valid };
    });

    const journal: SavePagesJournal = {
      entries: checked.map((entry) => ({
        pageId: entry.pageId,
        previousRaw: entry.previousRaw,
      })),
    };
    await this.atomicWriteJson(this.savePagesJournalPath, journal);

    const out: number[] = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        const checkedEntry = checked[i]!;
        const newVersion = checkedEntry.currentVersion + 1;
        await this.atomicWriteJson(checkedEntry.filePath, {
          ...checkedEntry.valid,
          version: newVersion,
        });
        out.push(newVersion);
      }
      await fs.unlink(this.savePagesJournalPath);
      return out;
    } catch (err) {
      await this.restoreSavePagesJournalUnlocked(journal);
      throw err;
    }
  }

  private async recoverPendingSavePagesUnlocked(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.savePagesJournalPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return;
      throw err;
    }
    const journal = JSON.parse(raw) as SavePagesJournal;
    await this.restoreSavePagesJournalUnlocked(journal);
  }

  private async restoreSavePagesJournalUnlocked(journal: SavePagesJournal): Promise<void> {
    for (const entry of journal.entries) {
      const filePath = this.pageFilePath(entry.pageId);
      if (entry.previousRaw === null) {
        try {
          await fs.unlink(filePath);
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') throw err;
        }
        continue;
      }
      await this.atomicWriteText(filePath, entry.previousRaw);
    }
    try {
      await fs.unlink(this.savePagesJournalPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }
  }

  private async recoverPendingWorkspaceImportUnlocked(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.workspaceImportJournalPath, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return;
      throw err;
    }
    const journal = JSON.parse(raw) as WorkspaceImportJournal;
    if (await this.shouldFinalizeWorkspaceImportJournalUnlocked(journal)) {
      await this.finalizeWorkspaceImportJournalUnlocked(journal);
      return;
    }
    await this.restoreWorkspaceImportJournalUnlocked(journal);
  }

  private async restoreWorkspaceImportJournalUnlocked(
    journal: WorkspaceImportJournal,
  ): Promise<void> {
    const backupPagesDir = journal.backupPagesDirName
      ? path.join(this.dataDir, journal.backupPagesDirName)
      : null;

    if (this.workspaceImportJournalNeedsPageRollback(journal.phase)) {
      if (journal.phase !== 'rollback_started' && journal.phase !== 'rollback_pages_restored') {
        journal.phase = 'rollback_started';
        await this.atomicWriteJson(this.workspaceImportJournalPath, journal);
      }
      if (journal.phase === 'rollback_started') {
        if (backupPagesDir && (await this.pathExists(backupPagesDir))) {
          await fs.rm(this.pagesDir, { recursive: true, force: true });
          await fs.rename(backupPagesDir, this.pagesDir);
        } else if (await this.livePagesMatchWorkspaceImportJournalUnlocked(journal.nextPageSha256ById)) {
          await fs.rm(this.pagesDir, { recursive: true, force: true });
        }
        journal.phase = 'rollback_pages_restored';
        await this.atomicWriteJson(this.workspaceImportJournalPath, journal);
      }
    }

    if (journal.previousMetaRaw === null) {
      try {
        await fs.unlink(this.metaPath);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
      }
    } else {
      await this.atomicWriteText(this.metaPath, journal.previousMetaRaw);
    }

    await this.finalizeWorkspaceImportJournalUnlocked(journal);
  }

  /**
   * 从旧的根级 v2 布局迁移（升级到多用户版）：
   *   1. 复制旧 pages/ 目录到用户目录
   *   2. 读旧 meta.json，调整路径
   *   3. 备份旧 meta.json → meta.json.v2.bak（防止多用户重复迁移）
   */
  private async migrateFromLegacyV2(legacyMetaPath: string): Promise<Meta> {
    const legacyDir = path.dirname(legacyMetaPath);
    const legacyPagesDir = path.join(legacyDir, 'pages');

    // Copy all referenced data before committing the new meta migration marker.
    await fs.mkdir(this.pagesDir, { recursive: true });
    try {
      const entries = await fs.readdir(legacyPagesDir);
      for (const entry of entries) {
        if (entry.endsWith('.json')) {
          await fs.copyFile(
            path.join(legacyPagesDir, entry),
            path.join(this.pagesDir, entry),
          );
        }
      }
    } catch {
    }

    const raw = await fs.readFile(legacyMetaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const meta = MetaSchema.parse(parsed);

    await this.atomicWriteJson(this.metaPath, meta);

    // Retire the shared legacy marker so a second user cannot migrate the same workspace.
    try {
      await fs.rename(legacyMetaPath, legacyMetaPath + '.v2.bak');
    } catch {
      try { await fs.copyFile(legacyMetaPath, legacyMetaPath + '.v2.bak'); } catch { /* best effort */ }
    }

    return meta;
  }

  /**
   * 首次启动迁移。顺序：
   *   1. 建 pages/ 目录
   *   2. 生成 default page 的 JSON（来自老数据或 SEED）
   *   3. rename 老 tasks.json → tasks.json.v1.bak（仅当老文件存在）
   *   4. 最后写 meta.json —— 它的存在就是"迁移已完成"的判据
   * 中途任何一步挂了，下次启动还会重跑第 1-4 步（幂等）。
   */
  private async migrateFromLegacyOrSeed(): Promise<Meta> {
    let seedGraph: Graph = SEED_GRAPH;
    let hasLegacy = false;
    try {
      const raw = await fs.readFile(this.legacyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      seedGraph = GraphSchema.parse(parsed);
      hasLegacy = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }

    const pageId = makePageId('默认');
    const systemPageCreatedAt = new Date().toISOString();
    const pageTitle = hasLegacy ? '默认' : '入门教程';
    await this.savePageUnlocked(pageId, {
      nodes: resolveNodeOverlaps(seedGraph.nodes).nodes,
      edges: seedGraph.edges,
    });
    await this.savePageUnlocked(SYSTEM_HIERARCHY_PAGE_ID, { nodes: [], edges: [] });

    if (hasLegacy) {
      try {
        await fs.rename(this.legacyPath, this.legacyBackupPath);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EXDEV') {
          await fs.copyFile(this.legacyPath, this.legacyBackupPath);
          await fs.unlink(this.legacyPath);
        } else {
          throw err;
        }
      }
    }

    const meta: Meta = {
      version: 2,
      revision: 0,
      activePageId: pageId,
      pages: [
        {
          id: SYSTEM_HIERARCHY_PAGE_ID,
          title: SYSTEM_HIERARCHY_PAGE_TITLE,
          order: 0,
          createdAt: systemPageCreatedAt,
          kind: 'hierarchy',
        },
        { id: pageId, title: pageTitle, order: 1, createdAt: new Date().toISOString() },
      ],
    };
    await this.atomicWriteJson(this.metaPath, meta);
    return meta;
  }

  private async exportWorkspaceUnlocked(): Promise<WorkspaceExport> {
    const meta = await this.loadMetaUnlocked();
    const pages: Record<string, PageData> = {};
    for (const page of meta.pages) {
      pages[page.id] = await this.loadPageUnlocked(page.id);
    }
    return {
      exportedAt: new Date().toISOString(),
      meta,
      pages,
    };
  }

  private async loadPageUnlocked(pageId: string): Promise<PageData> {
    const p = this.pageFilePath(pageId);
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return parseValidPageData(parsed, pageId, undefined, false);
  }

  private validateWorkspaceImport(
    data: WorkspaceExport,
  ): { meta: Meta; pages: Record<string, PageData> } {
    let meta = MetaSchema.parse(data.meta);
    const rawPages = { ...data.pages };
    const systemPageIndex = meta.pages.findIndex((page) => page.id === SYSTEM_HIERARCHY_PAGE_ID);
    if (systemPageIndex < 0) {
      const maxOrder = meta.pages.reduce((max, page) => Math.max(max, page.order), -1);
      meta = {
        ...meta,
        pages: [...meta.pages, {
          id: SYSTEM_HIERARCHY_PAGE_ID,
          title: SYSTEM_HIERARCHY_PAGE_TITLE,
          order: maxOrder + 1,
          createdAt: new Date().toISOString(),
          kind: 'hierarchy',
        }],
      };
      rawPages[SYSTEM_HIERARCHY_PAGE_ID] = { nodes: [], edges: [] };
    } else if (meta.pages[systemPageIndex]!.kind !== 'hierarchy') {
      const pages = [...meta.pages];
      pages[systemPageIndex] = { ...pages[systemPageIndex]!, kind: 'hierarchy' };
      meta = { ...meta, pages };
    }
    meta = { ...meta, pages: pinSystemPageFirst(meta.pages) };
    const metaPageIds = meta.pages.map((page) => page.id);
    const uniqueMetaPageIds = new Set(metaPageIds);

    if (uniqueMetaPageIds.size !== metaPageIds.length) {
      throw new Error('meta.pages contains duplicate page ids');
    }
    if (!uniqueMetaPageIds.has(meta.activePageId)) {
      throw new Error('activePageId must reference a page in meta.pages');
    }

    for (const pageId of metaPageIds) {
      this.assertSafePageId(pageId);
    }

    const rawPageIds = Object.keys(rawPages);
    if (rawPageIds.length !== metaPageIds.length) {
      throw new Error('pages record must exactly match meta.pages');
    }

    const pages: Record<string, PageData> = {};
    for (const pageId of rawPageIds) {
      this.assertSafePageId(pageId);
      if (!uniqueMetaPageIds.has(pageId)) {
        throw new Error('pages record must exactly match meta.pages');
      }
    }

    for (const pageId of metaPageIds) {
      if (!Object.prototype.hasOwnProperty.call(rawPages, pageId)) {
        throw new Error(`missing page data: ${pageId}`);
      }
      const pageData = parseValidPageData(rawPages[pageId], pageId, undefined, false);
      this.assertPageAllowsDependencies(meta, pageId, pageData);
      pages[pageId] = pageData;
    }

    return { meta, pages };
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return false;
      throw err;
    }
  }

  private async readTextIfExists(target: string): Promise<string | null> {
    try {
      return await fs.readFile(target, 'utf-8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async shouldFinalizeWorkspaceImportJournalUnlocked(
    journal: WorkspaceImportJournal,
  ): Promise<boolean> {
    if (journal.phase === 'committed') {
      return true;
    }
    if (journal.phase !== 'meta_commit_started') {
      return false;
    }

    const liveMetaRaw = await this.readTextIfExists(this.metaPath);
    if (liveMetaRaw === null) {
      return false;
    }
    if (this.hashRawJson(liveMetaRaw) !== journal.nextMetaSha256) {
      return false;
    }

    return this.livePagesMatchWorkspaceImportJournalUnlocked(journal.nextPageSha256ById);
  }

  private workspaceImportJournalNeedsPageRollback(phase: WorkspaceImportJournalPhase): boolean {
    return (
      phase === 'live_pages_backed_up' ||
      phase === 'staged_pages_live' ||
      phase === 'meta_commit_started' ||
      phase === 'rollback_started'
    );
  }

  private hashJson(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private hashRawJson(raw: string): string | null {
    try {
      return this.hashJson(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async livePagesMatchWorkspaceImportJournalUnlocked(
    nextPageSha256ById: Record<string, string>,
  ): Promise<boolean> {
    const livePageIds = Object.keys(nextPageSha256ById);
    for (const pageId of livePageIds) {
      const livePageRaw = await this.readTextIfExists(this.pageFilePath(pageId));
      if (livePageRaw === null || this.hashRawJson(livePageRaw) !== nextPageSha256ById[pageId]) {
        return false;
      }
    }

    try {
      const pageDirEntries = await fs.readdir(this.pagesDir);
      const liveJsonPageCount = pageDirEntries.filter((entry) => entry.endsWith('.json')).length;
      return liveJsonPageCount === livePageIds.length;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return livePageIds.length === 0;
      throw err;
    }
  }

  private async finalizeWorkspaceImportJournalUnlocked(
    journal: WorkspaceImportJournal,
  ): Promise<void> {
    const stagingDir = path.join(this.dataDir, journal.stagingDirName);
    const backupPagesDir = journal.backupPagesDirName
      ? path.join(this.dataDir, journal.backupPagesDirName)
      : null;

    await fs.rm(stagingDir, { recursive: true, force: true });
    if (backupPagesDir && (await this.pathExists(backupPagesDir))) {
      await fs.rm(backupPagesDir, { recursive: true, force: true });
    }
    try {
      await fs.unlink(this.workspaceImportJournalPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }
  }
}

/**
 * 生成页面 ID：时间戳 + 随机段。
 * 不直接用标题 —— 中文/符号等需要 slug，复杂且可能冲突。
 */
function makePageId(_hint: string): string {
  return (
    'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e8).toString(36).padStart(5, '0')
  );
}

function pinSystemPageFirst(pages: PageInfo[]): PageInfo[] {
  const ordered = [...pages].sort((a, b) => a.order - b.order);
  const systemPage = ordered.find((page) => page.id === SYSTEM_HIERARCHY_PAGE_ID);
  const result = systemPage
    ? [systemPage, ...ordered.filter((page) => page.id !== SYSTEM_HIERARCHY_PAGE_ID)]
    : ordered;
  return result.map((page, order) => ({ ...page, order }));
}

function parseValidPageData(
  data: unknown,
  pageId: string,
  allowedLegacyTitles?: ReadonlyMap<string, string>,
  enforceTitleLimit = true,
): PageData {
  let page = PageDataSchema.parse(data);
  if (enforceTitleLimit) {
    const oversized = page.nodes.find(
      (node) =>
        node.title.length > MAX_TASK_TITLE_LENGTH &&
        allowedLegacyTitles?.get(node.id) !== node.title,
    );
    if (oversized) {
      throw new TaskTitleTooLongError(oversized.id, MAX_TASK_TITLE_LENGTH);
    }
  }
  if (enforceTitleLimit) {
    const dependencies = validateDependencyEdges(page.nodes, page.edges);
    if (!dependencies.valid) {
      throw new Error(`page contains invalid dependency (${dependencies.reason}, edge ${dependencies.edgeIndex}): ${pageId}`);
    }
  } else {
    const ids = new Set(page.nodes.map((node) => node.id));
    const seen = new Set<string>();
    page = {
      ...page,
      edges: page.edges.filter((edge) => {
        const key = `${edge.from}\0${edge.to}`;
        if (edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to) || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  }
  if (!isDAG(page)) throw new Error(`page contains dependency cycle: ${pageId}`);
  const hierarchy = validateTaskHierarchy(page.nodes);
  if (!hierarchy.valid) {
    throw new Error(
      `page contains invalid hierarchy (${hierarchy.reason}, task ${hierarchy.taskId}): ${pageId}`,
    );
  }
  return page;
}

function assertNoNodeOverlaps(page: PageData, pageId: string): void {
  const overlap = validateNoSiblingOverlaps(page.nodes);
  if (!overlap.valid) throw new NodeOverlapError(pageId, overlap.conflicts);
}

function collectLegacyLongTaskTitles(data: unknown): Map<string, string> {
  const page = PageDataSchema.safeParse(data);
  if (!page.success) return new Map();
  return new Map(
    page.data.nodes
      .filter((node) => node.title.length > MAX_TASK_TITLE_LENGTH)
      .map((node) => [node.id, node.title]),
  );
}

function assertPageTitleLength(title: string): void {
  if (title.length > MAX_PAGE_TITLE_LENGTH) {
    throw new Error(`page title exceeds ${MAX_PAGE_TITLE_LENGTH} characters`);
  }
}

/** 防止 pageId 逃逸目录：只允许字母、数字、下划线、短横线。 */
function isSafePageId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 64;
}

function backupNameToIso(name: string): string {
  return name
    .replace(/\.json$/, '')
    .replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
}
