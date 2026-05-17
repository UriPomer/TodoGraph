import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  GraphSchema,
  MetaSchema,
  PageDataSchema,
  type Graph,
  type Meta,
  type PageData,
  type PageInfo,
  type WorkspaceSettings,
} from '@todograph/shared';
import {
  MetaVersionConflictError,
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
  /** Old root-level data dir (pre-multi-user). If set and meta.json exists there, migrate it in. */
  private readonly legacyV2Dir?: string;

  constructor(dataDir: string, legacyV2Dir?: string) {
    this.dataDir = dataDir;
    this.metaPath = path.join(dataDir, 'meta.json');
    this.pagesDir = path.join(dataDir, 'pages');
    this.legacyPath = path.join(dataDir, 'tasks.json');
    this.legacyBackupPath = path.join(dataDir, 'tasks.json.v1.bak');
    this.savePagesJournalPath = path.join(dataDir, '.save-pages-journal.json');
    this.legacyV2Dir = legacyV2Dir;
  }

  async loadMeta(): Promise<Meta> {
    return this.runLocked(() => this.loadMetaUnlocked());
  }

  async loadPage(pageId: string): Promise<PageData> {
    return this.runLocked(async () => {
      const p = this.pageFilePath(pageId);
      const raw = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw);
      return PageDataSchema.parse(parsed);
    });
  }

  async savePage(pageId: string, data: PageData, expectedVersion?: number): Promise<number> {
    return this.runLocked(() => this.savePageUnlocked(pageId, data, expectedVersion));
  }

  async savePages(
    entries: Array<{ pageId: string; data: PageData; expectedVersion?: number }>,
  ): Promise<number[]> {
    return this.runLocked(() => this.savePagesUnlocked(entries));
  }

  async createPage(title: string, expectedRevision?: number): Promise<{ page: PageInfo; meta: Meta }> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      const id = makePageId(title);
      const maxOrder = meta.pages.reduce((m, p) => Math.max(m, p.order), -1);
      const info: PageInfo = {
        id,
        title: title.trim() || '新页面',
        order: maxOrder + 1,
        createdAt: new Date().toISOString(),
      };
      // 新页面先落盘（空数据），再写 meta —— 保证 meta 指向的文件一定存在
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
      if (meta.pages.length <= 1) {
        throw new Error('last page cannot be deleted');
      }
      const nextPages = meta.pages.filter((p) => p.id !== pageId);
      if (nextPages.length === meta.pages.length) {
        throw new Error(`page not found: ${pageId}`);
      }
      const nextActive =
        meta.activePageId === pageId ? (nextPages[0]?.id ?? meta.activePageId) : meta.activePageId;
      const nextMeta = this.bumpMeta({ ...meta, pages: nextPages, activePageId: nextActive });
      // 先更新 meta 再删文件：即使删文件失败，用户也看不到幽灵页面
      await this.atomicWriteJson(this.metaPath, nextMeta);
      try {
        await fs.unlink(this.pageFilePath(pageId));
      } catch (err) {
        // 幂等：文件已经不在也算成功
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
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
      if (ids.length !== meta.pages.length || ids.some((id) => !byId.has(id))) {
        throw new Error('reorder ids do not match existing pages');
      }
      const nextPages: PageInfo[] = ids.map((id, i) => ({ ...byId.get(id)!, order: i }));
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

  async updateSettings(settings: WorkspaceSettings, expectedRevision?: number): Promise<Meta> {
    return this.runLocked(async () => {
      const meta = await this.loadMetaUnlocked();
      this.assertMetaRevision(meta, expectedRevision);
      const nextMeta = this.bumpMeta({ ...meta, settings });
      await this.atomicWriteJson(this.metaPath, nextMeta);
      return nextMeta;
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
          // 文件缺失：mtime=0，让缓存失效重读时发现并抛错
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

      // 保留最近 50 份
      const entries = await fs.readdir(backupDir);
      const jsonFiles = entries
        .filter((f) => f.endsWith('.json'))
        .sort();
      while (jsonFiles.length > 50) {
        const oldest = jsonFiles.shift()!;
        try {
          await fs.unlink(path.join(backupDir, oldest));
        } catch {
          // 删不掉就跳过
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private pageFilePath(pageId: string): string {
    // 防御性：pageId 不允许含斜杠或 ..
    if (!isSafePageId(pageId)) {
      throw new Error(`invalid page id: ${pageId}`);
    }
    return path.join(this.pagesDir, pageId + '.json');
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
      await this.recoverPendingSavePagesUnlocked();
      return task();
    });
  }

  private async loadMetaUnlocked(): Promise<Meta> {
    try {
      const raw = await fs.readFile(this.metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return MetaSchema.parse(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      // meta.json 不存在 → 先尝试从旧根级目录迁移 v2 数据
      if (this.legacyV2Dir) {
        const legacyMetaPath = path.join(this.legacyV2Dir, 'meta.json');
        try {
          await fs.access(legacyMetaPath);
          return await this.migrateFromLegacyV2(legacyMetaPath);
        } catch {
          // legacy v2 data doesn't exist either, fall through
        }
      }
      // 无旧数据 → 执行 v1 迁移或 SEED
      return await this.migrateFromLegacyOrSeed();
    }
  }

  private async savePageUnlocked(pageId: string, data: PageData, expectedVersion?: number): Promise<number> {
    const filePath = this.pageFilePath(pageId);

    // 读当前版本
    let currentVersion = 0;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      currentVersion = typeof parsed.version === 'number' ? parsed.version : 0;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      // 文件不存在 → version = 0
    }

    // 版本比对
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new VersionConflictError(pageId, currentVersion);
    }

    const newVersion = currentVersion + 1;
    const valid = PageDataSchema.parse(data);
    await this.atomicWriteJson(filePath, { ...valid, version: newVersion });
    return newVersion;
  }

  private async savePagesUnlocked(
    entries: Array<{ pageId: string; data: PageData; expectedVersion?: number }>,
  ): Promise<number[]> {
    const checked = await Promise.all(
      entries.map(async (entry) => {
        const filePath = this.pageFilePath(entry.pageId);
        let currentVersion = 0;
        let previousRaw: string | null = null;
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          previousRaw = raw;
          const parsed = JSON.parse(raw);
          currentVersion = typeof parsed.version === 'number' ? parsed.version : 0;
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') throw err;
        }
        if (entry.expectedVersion !== undefined && entry.expectedVersion !== currentVersion) {
          throw new VersionConflictError(entry.pageId, currentVersion);
        }
        return {
          pageId: entry.pageId,
          filePath,
          currentVersion,
          previousRaw,
          valid: PageDataSchema.parse(entry.data),
        };
      }),
    );

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

  /**
   * 从旧的根级 v2 布局迁移（升级到多用户版）：
   *   1. 复制旧 pages/ 目录到用户目录
   *   2. 读旧 meta.json，调整路径
   *   3. 备份旧 meta.json → meta.json.v2.bak（防止多用户重复迁移）
   */
  private async migrateFromLegacyV2(legacyMetaPath: string): Promise<Meta> {
    const legacyDir = path.dirname(legacyMetaPath);
    const legacyPagesDir = path.join(legacyDir, 'pages');

    // 1. 复制页面文件
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
      // pages dir doesn't exist — use empty
    }

    // 2. 读旧 meta
    const raw = await fs.readFile(legacyMetaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const meta = MetaSchema.parse(parsed);

    // 3. 写新 meta（迁移完成标志）
    await this.atomicWriteJson(this.metaPath, meta);

    // 4. 备份旧 meta（防止第二个用户迁移同一份旧数据）
    try {
      await fs.rename(legacyMetaPath, legacyMetaPath + '.v2.bak');
    } catch {
      // rename failed, at least copy
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
      // 没有老文件：用 SEED
    }

    // 步骤 1-2：建 default page
    const pageId = makePageId('默认');
    const pageTitle = hasLegacy ? '默认' : '入门教程';
    await this.savePageUnlocked(pageId, { nodes: seedGraph.nodes, edges: seedGraph.edges });

    // 步骤 3：备份老文件（仅当存在）
    if (hasLegacy) {
      try {
        await fs.rename(this.legacyPath, this.legacyBackupPath);
      } catch (err) {
        // 若 rename 失败（跨设备等罕见情况），至少复制一份备份
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EXDEV') {
          await fs.copyFile(this.legacyPath, this.legacyBackupPath);
          await fs.unlink(this.legacyPath);
        } else {
          throw err;
        }
      }
    }

    // 步骤 4：写 meta.json（迁移完成）
    const meta: Meta = {
      version: 2,
      revision: 0,
      activePageId: pageId,
      pages: [
        { id: pageId, title: pageTitle, order: 0, createdAt: new Date().toISOString() },
      ],
    };
    await this.atomicWriteJson(this.metaPath, meta);
    return meta;
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

/** 防止 pageId 逃逸目录：只允许字母、数字、下划线、短横线。 */
function isSafePageId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 64;
}
