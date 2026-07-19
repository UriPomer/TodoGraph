import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  GraphSchema,
  MetaSchema,
  PageInfoSchema,
  SYSTEM_HIERARCHY_PAGE_ID,
  SYSTEM_HIERARCHY_PAGE_TITLE,
  pageSupportsDependencyGraph,
  resolveNodeOverlaps,
  type Graph,
  type Meta,
  type PageData,
  type PageInfo,
} from '@todograph/shared';
import {
  type BackupInfo,
  MetaVersionConflictError,
  type TrashedPageInfo,
  type WorkspaceExport,
  type WorkspaceRepository,
  VersionConflictError,
} from './Repository.js';
import { withFilesystemLock } from './fileLock.js';
import {
  atomicWriteJson,
  atomicWriteText,
  copyFileDurable,
  syncDirectory,
} from './durableFile.js';
import {
  assertNoNodeOverlaps,
  assertPageCapacity,
  assertPageTitleLength,
  collectLegacyLongTaskTitles,
  isSafePageId,
  MAX_WORKSPACE_DATA_BYTES,
  parseValidPageData,
  serializedJsonBytes,
} from './workspaceValidation.js';
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
const MAX_WORKSPACE_PAGES = 500;
const MAX_PAGE_BACKUPS = 50;
const MAX_IMPORT_BACKUPS = 20;
const MAX_TRASHED_PAGES = 100;
const MAX_PAGE_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_TRASH_BYTES = 64 * 1024 * 1024;

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
    return this.runLocked(async () => {
      this.assertKnownPage(await this.loadMetaUnlocked(), pageId);
      return this.loadPageUnlocked(pageId);
    });
  }

  async savePage(pageId: string, data: PageData, expectedVersion?: number): Promise<number> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertKnownPage(meta, pageId);
      this.assertPageAllowsDependencies(meta, pageId, data);
      await this.assertWorkspaceGrowthAllowed(meta, new Map([[pageId, data]]));
      return this.savePageUnlocked(pageId, data, expectedVersion);
    });
  }

  async savePages(
    entries: Array<{ pageId: string; data: PageData; expectedVersion?: number }>,
  ): Promise<number[]> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      if (new Set(entries.map((entry) => entry.pageId)).size !== entries.length) {
        throw new Error('savePages contains duplicate page ids');
      }
      for (const entry of entries) {
        this.assertKnownPage(meta, entry.pageId);
        this.assertPageAllowsDependencies(meta, entry.pageId, entry.data);
      }
      await this.assertWorkspaceGrowthAllowed(
        meta,
        new Map(entries.map((entry) => [entry.pageId, entry.data])),
      );
      return this.savePagesUnlocked(entries);
    });
  }

  async createPage(title: string, expectedRevision?: number): Promise<{ page: PageInfo; meta: Meta }> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      if (meta.pages.length >= MAX_WORKSPACE_PAGES) {
        throw new Error(`workspace exceeds ${MAX_WORKSPACE_PAGES} pages`);
      }
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
      await this.assertWorkspaceGrowthAllowed(meta, new Map([[id, { nodes: [], edges: [] }]]));
      // Page first, then meta: committed metadata must never reference a missing page file.
      await this.savePageUnlocked(id, { nodes: [], edges: [] });
      const nextMeta = this.bumpMeta({ ...meta, pages: [...meta.pages, info] });
      await atomicWriteJson(this.metaPath, nextMeta);
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
      // Persist a tombstone before metadata makes the page unreachable.
      const deletedAt = new Date().toISOString();
      const pageRaw = await fs.readFile(this.pageFilePath(pageId), 'utf-8');
      const trashDir = path.join(this.dataDir, 'trash', 'pages');
      await atomicWriteText(
        path.join(trashDir, `${deletedAt.replace(/[:.]/g, '-')}-${pageId}.json`),
        JSON.stringify({
          deletedAt,
          page: meta.pages.find((page) => page.id === pageId),
          data: JSON.parse(pageRaw),
        }, null, 2),
      );
      await this.pruneJsonFiles(trashDir, MAX_TRASHED_PAGES, MAX_TRASH_BYTES);
      await atomicWriteJson(this.metaPath, nextMeta);
      try {
        await fs.unlink(this.pageFilePath(pageId));
        await syncDirectory(this.pagesDir);
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
      await atomicWriteJson(this.metaPath, nextMeta);
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
      await atomicWriteJson(this.metaPath, nextMeta);
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
      await atomicWriteJson(this.metaPath, nextMeta);
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
      // Import is destructive, so failure to snapshot the current workspace aborts it.
      const snapshot = await this.exportWorkspaceUnlocked();
      const name = new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      await atomicWriteText(
        path.join(importBackupDir, name),
        JSON.stringify(snapshot, null, 2),
      );
      await this.pruneJsonFiles(importBackupDir, MAX_IMPORT_BACKUPS, MAX_IMPORT_BACKUP_BYTES);
      const meta = { ...validated.meta, revision: Math.max(validated.meta.revision, snapshot.meta.revision) + 1 };
      const pages = Object.fromEntries(Object.entries(validated.pages).map(([pageId, page]) =>
        [pageId, {
          ...page,
          nodes: resolveNodeOverlaps(page.nodes).nodes,
          version: Math.max(page.version ?? 0, snapshot.pages[pageId]?.version ?? 0) + 1,
        }]));

      const stagingDirName = `.workspace-import-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const stagingDir = path.join(this.dataDir, stagingDirName);
      const stagedPagesDir = path.join(stagingDir, 'pages');
      const stagedMetaPath = path.join(stagingDir, 'meta.json');
      await fs.mkdir(stagedPagesDir, { recursive: true });
      for (const [pageId, pageData] of Object.entries(pages)) {
        await atomicWriteJson(path.join(stagedPagesDir, `${pageId}.json`), pageData);
      }
      await atomicWriteJson(stagedMetaPath, meta);

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
      await atomicWriteJson(this.workspaceImportJournalPath, journal);

      try {
        if (backupPagesDirName) {
          await fs.rename(this.pagesDir, path.join(this.dataDir, backupPagesDirName));
          await syncDirectory(this.dataDir);
          journal.phase = 'live_pages_backed_up';
          await atomicWriteJson(this.workspaceImportJournalPath, journal);
        }

        await fs.rename(stagedPagesDir, this.pagesDir);
        await syncDirectory(this.dataDir);
        journal.phase = 'staged_pages_live';
        await atomicWriteJson(this.workspaceImportJournalPath, journal);

        journal.phase = 'meta_commit_started';
        await atomicWriteJson(this.workspaceImportJournalPath, journal);

        await atomicWriteJson(this.metaPath, meta);
        journal.phase = 'committed';
        await atomicWriteJson(this.workspaceImportJournalPath, journal);
      } catch (err) {
        await this.restoreWorkspaceImportJournalUnlocked(journal);
        throw err;
      }

      await this.finalizeWorkspaceImportJournalUnlocked(journal);
      return meta;
    });
  }

  async listPageMtimes(): Promise<Array<{ pageId: string; mtimeMs: number | null }>> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      const out: Array<{ pageId: string; mtimeMs: number | null }> = [];
      for (const p of meta.pages) {
        try {
          const st = await fs.stat(this.pageFilePath(p.id));
          out.push({ pageId: p.id, mtimeMs: st.mtimeMs });
        } catch {
          out.push({ pageId: p.id, mtimeMs: null });
        }
      }
      return out;
    });
  }

  async createBackup(pageId: string): Promise<void> {
    return this.runLocked(async () => {
      this.assertKnownPage(await this.loadMetaUnlocked(), pageId);
      await this.createBackupUnlocked(pageId);
    });
  }

  async listBackups(pageId: string): Promise<BackupInfo[]> {
    this.assertSafePageId(pageId);
    return this.runLocked(async () => {
      this.assertKnownPage(await this.loadMetaUnlocked(), pageId);
      return this.listBackupsUnlocked(pageId);
    });
  }

  async restoreBackup(pageId: string, backupName: string, expectedVersion?: number): Promise<PageData> {
    this.assertSafePageId(pageId);
    this.assertSafeBackupName(backupName);
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertKnownPage(meta, pageId);
      return this.restoreBackupUnlocked(meta, pageId, backupName, expectedVersion);
    });
  }

  async restoreLatestBackup(pageId: string, expectedVersion?: number): Promise<PageData> {
    this.assertSafePageId(pageId);
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertKnownPage(meta, pageId);
      const backups = await this.listBackupsUnlocked(pageId);
      if (backups.length === 0) {
        throw new Error(`no backup found for page ${pageId}`);
      }
      return this.restoreBackupUnlocked(meta, pageId, backups[0]!.name, expectedVersion);
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

  private async restoreBackupUnlocked(
    meta: Meta,
    pageId: string,
    backupName: string,
    expectedVersion?: number,
  ): Promise<PageData> {
    const src = path.join(this.dataDir, 'backups', pageId, backupName);
    const restored = parseValidPageData(JSON.parse(await fs.readFile(src, 'utf-8')), pageId, undefined, false);
    const current = await this.loadPageUnlocked(pageId);
    if (expectedVersion !== undefined && expectedVersion !== (current.version ?? 0)) {
      throw new VersionConflictError(pageId, current.version ?? 0);
    }
    const next = {
      ...restored,
      nodes: resolveNodeOverlaps(restored.nodes).nodes,
      version: Math.max(restored.version ?? 0, current.version ?? 0) + 1,
    };
    await this.assertWorkspaceGrowthAllowed(meta, new Map([[pageId, next]]));
    // Restores are reversible: snapshot the live page before overwriting it.
    await this.createBackupUnlocked(pageId);
    await atomicWriteJson(this.pageFilePath(pageId), next);
    return next;
  }

  async listTrashedPages(): Promise<TrashedPageInfo[]> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      const liveIds = new Set(meta.pages.map((page) => page.id));
      const trashDir = path.join(this.dataDir, 'trash', 'pages');
      try {
        const entries = (await fs.readdir(trashDir)).filter((name) => name.endsWith('.json'));
        const items = await Promise.all(entries.map(async (name): Promise<TrashedPageInfo | null> => {
          const fullPath = path.join(trashDir, name);
          const raw = JSON.parse(await fs.readFile(fullPath, 'utf-8')) as Record<string, unknown>;
          const page = PageInfoSchema.parse(raw.page);
          if (liveIds.has(page.id)) return null;
          const deletedAt = typeof raw.deletedAt === 'string' ? raw.deletedAt : '';
          parseValidPageData(raw.data, page.id, undefined, false);
          return { name, deletedAt, page, size: (await fs.stat(fullPath)).size };
        }));
        return items.filter((item): item is TrashedPageInfo => item !== null)
          .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
  }

  async restoreTrashedPage(
    name: string,
    expectedRevision?: number,
  ): Promise<{ meta: Meta; page: PageInfo; data: PageData }> {
    this.assertSafeTrashName(name);
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      if (meta.pages.length >= MAX_WORKSPACE_PAGES) {
        throw new Error(`workspace exceeds ${MAX_WORKSPACE_PAGES} pages`);
      }
      const trashPath = path.join(this.dataDir, 'trash', 'pages', name);
      const raw = JSON.parse(await fs.readFile(trashPath, 'utf-8')) as Record<string, unknown>;
      const originalPage = PageInfoSchema.parse(raw.page);
      if (meta.pages.some((page) => page.id === originalPage.id)) {
        throw new Error(`page already exists: ${originalPage.id}`);
      }
      const restored = parseValidPageData(raw.data, originalPage.id, undefined, false);
      assertPageCapacity(restored, originalPage.id);
      const page: PageInfo = {
        ...originalPage,
        order: meta.pages.reduce((max, candidate) => Math.max(max, candidate.order), -1) + 1,
      };
      await this.assertWorkspaceGrowthAllowed(meta, new Map([[page.id, restored]]));
      await this.savePageUnlocked(page.id, restored);
      const nextMeta = this.bumpMeta({ ...meta, pages: pinSystemPageFirst([...meta.pages, page]) });
      await atomicWriteJson(this.metaPath, nextMeta);
      let cleanupWarning: string | undefined;
      try {
        await fs.unlink(trashPath);
        await syncDirectory(path.dirname(trashPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          cleanupWarning = '页面已恢复，但旧回收站文件清理失败';
        }
      }
      return {
        meta: nextMeta,
        page,
        data: await this.loadPageUnlocked(page.id),
        ...(cleanupWarning ? { cleanupWarning } : {}),
      };
    });
  }

  private async createBackupUnlocked(pageId: string): Promise<void> {
    const src = this.pageFilePath(pageId);
    const backupDir = path.join(this.dataDir, 'backups', pageId);
    await fs.mkdir(backupDir, { recursive: true });
    let timestamp = Date.now();
    let destination: string;
    do {
      const name = new Date(timestamp).toISOString().replace(/[:.]/g, '-') + '.json';
      destination = path.join(backupDir, name);
      timestamp += 1;
    } while (await this.pathExists(destination));
    await copyFileDurable(src, destination);
    await this.pruneJsonFiles(backupDir, MAX_PAGE_BACKUPS, MAX_PAGE_BACKUP_BYTES);
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

  private assertSafeTrashName(name: string): void {
    if (path.basename(name) !== name || !name.endsWith('.json') || name.length > 300) {
      throw new Error('invalid trash entry name');
    }
  }

  private async pruneJsonFiles(directory: string, limit: number, maxBytes: number): Promise<void> {
    const candidates = await Promise.all(
      (await fs.readdir(directory))
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map(async (name) => {
          try {
            return { name, size: (await fs.stat(path.join(directory, name))).size };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        }),
    );
    const jsonFiles = candidates.filter((file): file is { name: string; size: number } => file !== null);
    let totalBytes = jsonFiles.reduce((sum, file) => sum + file.size, 0);
    let changed = false;
    // Always retain the newest recovery point, even when one legacy file alone exceeds the byte budget.
    while (jsonFiles.length > 1 && (jsonFiles.length > limit || totalBytes > maxBytes)) {
      const oldest = jsonFiles.shift()!;
      await fs.unlink(path.join(directory, oldest.name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      totalBytes -= oldest.size;
      changed = true;
    }
    if (changed) await syncDirectory(directory);
  }

  private async assertWorkspaceGrowthAllowed(
    meta: Meta,
    replacements: ReadonlyMap<string, PageData>,
  ): Promise<void> {
    const livePageIds = new Set(meta.pages.map((page) => page.id));
    let currentBytes = 0;
    let nextBytes = 0;

    for (const page of meta.pages) {
      const replacement = replacements.get(page.id);
      const pagePath = this.pageFilePath(page.id);
      if (!replacement) {
        let currentSize = 0;
        try {
          currentSize = (await fs.stat(pagePath)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        currentBytes += currentSize;
        nextBytes += currentSize;
        continue;
      }

      let raw: string | null = null;
      try {
        raw = await fs.readFile(pagePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const currentSize = raw === null ? 0 : Buffer.byteLength(raw, 'utf-8');
      currentBytes += currentSize;
      const parsed = raw === null ? undefined : JSON.parse(raw) as { version?: unknown };
      const currentVersion = typeof parsed?.version === 'number' ? parsed.version : 0;
      nextBytes += serializedJsonBytes({ ...replacement, version: currentVersion + 1 });
    }

    for (const [pageId, replacement] of replacements) {
      if (!livePageIds.has(pageId)) {
        nextBytes += serializedJsonBytes({ ...replacement, version: 1 });
      }
    }

    // Existing oversized workspaces remain editable when an operation reduces or preserves their footprint.
    if (nextBytes > MAX_WORKSPACE_DATA_BYTES && nextBytes > currentBytes) {
      throw new Error(`workspace exceeds ${MAX_WORKSPACE_DATA_BYTES} serialized bytes`);
    }
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
    return withWorkspaceLock(this.workspaceLockKey(), () =>
      withFilesystemLock(this.dataDir, async () => {
        await this.recoverPendingWorkspaceImportUnlocked();
        await this.recoverPendingSavePagesUnlocked();
        return task();
      }),
    );
  }

  private async loadMetaUnlocked(): Promise<Meta> {
    let meta: Meta;
    try {
      const raw = await fs.readFile(this.metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      meta = MetaSchema.parse(parsed);
      await this.finalizeOwnedLegacyV2Claim();
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      const migrated = await this.claimAndMigrateLegacyV2();
      if (migrated) {
        return this.ensureSystemHierarchyPageUnlocked(migrated);
      }
      meta = await this.migrateFromLegacyOrSeed();
    }
    return this.ensureSystemHierarchyPageUnlocked(meta);
  }

  private legacyV2ClaimPath(): string | null {
    if (!this.legacyV2Dir) return null;
    const owner = createHash('sha256').update(path.resolve(this.dataDir)).digest('hex').slice(0, 16);
    return path.join(this.legacyV2Dir, `meta.json.v2.claimed-${owner}`);
  }

  private async claimAndMigrateLegacyV2(): Promise<Meta | null> {
    if (!this.legacyV2Dir) return null;
    return withFilesystemLock(this.legacyV2Dir, async () => {
      const legacyMetaPath = path.join(this.legacyV2Dir!, 'meta.json');
      const claimPath = this.legacyV2ClaimPath()!;
      let source = claimPath;
      if (!(await this.pathExists(claimPath))) {
        if (!(await this.pathExists(legacyMetaPath))) return null;
        await fs.rename(legacyMetaPath, claimPath);
        await syncDirectory(this.legacyV2Dir!);
      }
      try {
        const migrated = await this.migrateFromLegacyV2(source);
        await fs.rename(source, path.join(this.legacyV2Dir!, 'meta.json.v2.bak'));
        await syncDirectory(this.legacyV2Dir!);
        return migrated;
      } catch (error) {
        if (await this.pathExists(source)) {
          await fs.rename(source, legacyMetaPath).catch(() => {});
          await syncDirectory(this.legacyV2Dir!);
        }
        throw error;
      }
    }, '.legacy-v2-migration.lock');
  }

  private async finalizeOwnedLegacyV2Claim(): Promise<void> {
    if (!this.legacyV2Dir) return;
    const claimPath = this.legacyV2ClaimPath()!;
    if (!(await this.pathExists(claimPath))) return;
    await withFilesystemLock(this.legacyV2Dir, async () => {
      if (await this.pathExists(claimPath)) {
        await fs.rename(claimPath, path.join(this.legacyV2Dir!, 'meta.json.v2.bak'));
        await syncDirectory(this.legacyV2Dir!);
      }
    }, '.legacy-v2-migration.lock');
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
      await atomicWriteJson(this.metaPath, nextMeta);
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
    await atomicWriteJson(this.metaPath, nextMeta);
    return nextMeta;
  }

  private assertPageAllowsDependencies(meta: Meta, pageId: string, data: PageData): void {
    const page = meta.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new Error(`page not found: ${pageId}`);
    if (!pageSupportsDependencyGraph(page) && data.edges.length > 0) {
      throw new Error(`page does not support dependency edges: ${pageId}`);
    }
  }

  private assertKnownPage(meta: Meta, pageId: string): void {
    this.assertSafePageId(pageId);
    if (!meta.pages.some((page) => page.id === pageId)) {
      throw new Error(`page not found: ${pageId}`);
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
    const next = { ...valid, version: newVersion };
    assertPageCapacity(next, pageId);
    assertNoNodeOverlaps(valid, pageId);
    await atomicWriteJson(filePath, next);
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
      assertPageCapacity({ ...valid, version: entry.currentVersion + 1 }, entry.pageId);
      assertNoNodeOverlaps(valid, entry.pageId);
      return { ...entry, valid };
    });

    const journal: SavePagesJournal = {
      entries: checked.map((entry) => ({
        pageId: entry.pageId,
        previousRaw: entry.previousRaw,
      })),
    };
    await atomicWriteJson(this.savePagesJournalPath, journal);

    const out: number[] = [];
    try {
      for (let i = 0; i < entries.length; i++) {
        const checkedEntry = checked[i]!;
        const newVersion = checkedEntry.currentVersion + 1;
        await atomicWriteJson(checkedEntry.filePath, {
          ...checkedEntry.valid,
          version: newVersion,
        });
        out.push(newVersion);
      }
      await fs.unlink(this.savePagesJournalPath);
      await syncDirectory(this.dataDir);
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
      await atomicWriteText(filePath, entry.previousRaw);
    }
    await syncDirectory(this.pagesDir);
    try {
      await fs.unlink(this.savePagesJournalPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }
    await syncDirectory(this.dataDir);
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
        await atomicWriteJson(this.workspaceImportJournalPath, journal);
      }
      if (journal.phase === 'rollback_started') {
        if (backupPagesDir && (await this.pathExists(backupPagesDir))) {
          await fs.rm(this.pagesDir, { recursive: true, force: true });
          await fs.rename(backupPagesDir, this.pagesDir);
          await syncDirectory(this.dataDir);
        } else if (await this.livePagesMatchWorkspaceImportJournalUnlocked(journal.nextPageSha256ById)) {
          await fs.rm(this.pagesDir, { recursive: true, force: true });
          await syncDirectory(this.dataDir);
        }
        journal.phase = 'rollback_pages_restored';
        await atomicWriteJson(this.workspaceImportJournalPath, journal);
      }
    }

    if (journal.previousMetaRaw === null) {
      try {
        await fs.unlink(this.metaPath);
        await syncDirectory(this.dataDir);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
      }
    } else {
      await atomicWriteText(this.metaPath, journal.previousMetaRaw);
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
    const raw = await fs.readFile(legacyMetaPath, 'utf-8');
    const meta = MetaSchema.parse(JSON.parse(raw));

    // Validate and atomically copy every referenced page before committing metadata.
    await fs.mkdir(this.pagesDir, { recursive: true });
    for (const page of meta.pages) {
      this.assertSafePageId(page.id);
      const pageRaw = await fs.readFile(path.join(legacyPagesDir, `${page.id}.json`), 'utf-8');
      parseValidPageData(JSON.parse(pageRaw), page.id, undefined, false);
      await atomicWriteText(this.pageFilePath(page.id), pageRaw);
    }

    await atomicWriteJson(this.metaPath, meta);

    return meta;
  }

  /**
   * 首次启动迁移。顺序：
   *   1. 建 pages/ 目录
   *   2. 生成 default page 的 JSON（来自老数据或 SEED）
   *   3. copy 老 tasks.json → tasks.json.v1.bak（仅当老文件存在）
   *   4. 写 meta.json 作为提交点，再删除旧入口
   * 提交点之前始终保留 tasks.json，因此崩溃重试不会回退到演示数据。
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
      await copyFileDurable(this.legacyPath, this.legacyBackupPath);
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
    await atomicWriteJson(this.metaPath, meta);
    if (hasLegacy) {
      await fs.unlink(this.legacyPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      await syncDirectory(this.dataDir);
    }
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
    if (meta.pages.length > MAX_WORKSPACE_PAGES) {
      throw new Error(`workspace exceeds ${MAX_WORKSPACE_PAGES} pages`);
    }
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
      assertPageCapacity(pageData, pageId);
      this.assertPageAllowsDependencies(meta, pageId, pageData);
      pages[pageId] = pageData;
    }

    const totalBytes = Object.values(pages).reduce(
      (sum, page) => sum + serializedJsonBytes(page),
      0,
    );
    if (totalBytes > MAX_WORKSPACE_DATA_BYTES) {
      throw new Error(`workspace exceeds ${MAX_WORKSPACE_DATA_BYTES} serialized bytes`);
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
    await syncDirectory(this.dataDir);
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

function backupNameToIso(name: string): string {
  return name
    .replace(/\.json$/, '')
    .replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
}
