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
import type { WorkspaceRepository } from './Repository.js';
import { SEED_GRAPH } from './FileRepository.js';

/**
 * 磁盘布局：
 *   {dataDir}/meta.json              —— 工作区元信息（版本/页面列表/active/settings）
 *   {dataDir}/pages/{pageId}.json    —— 每个页面的 nodes+edges
 *   {dataDir}/tasks.json.v1.bak      —— 首次迁移保留的老数据备份
 *
 * 原子写：所有 writeFile 走 tmp+rename 模式，避免崩溃损坏主数据。
 */
export class FileWorkspaceRepository implements WorkspaceRepository {
  private readonly metaPath: string;
  private readonly pagesDir: string;
  private readonly legacyPath: string;
  private readonly legacyBackupPath: string;

  constructor(private readonly dataDir: string) {
    this.metaPath = path.join(dataDir, 'meta.json');
    this.pagesDir = path.join(dataDir, 'pages');
    this.legacyPath = path.join(dataDir, 'tasks.json');
    this.legacyBackupPath = path.join(dataDir, 'tasks.json.v1.bak');
  }

  async loadMeta(): Promise<Meta> {
    try {
      const raw = await fs.readFile(this.metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return MetaSchema.parse(parsed);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      // meta.json 不存在 → 执行一次性迁移
      return await this.migrateFromLegacyOrSeed();
    }
  }

  async loadPage(pageId: string): Promise<PageData> {
    const p = this.pageFilePath(pageId);
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return PageDataSchema.parse(parsed);
  }

  async savePage(pageId: string, data: PageData): Promise<void> {
    const valid = PageDataSchema.parse(data);
    await this.atomicWriteJson(this.pageFilePath(pageId), valid);
  }

  async createPage(title: string): Promise<PageInfo> {
    const meta = await this.loadMeta();
    const id = makePageId(title);
    const maxOrder = meta.pages.reduce((m, p) => Math.max(m, p.order), -1);
    const info: PageInfo = {
      id,
      title: title.trim() || '新页面',
      order: maxOrder + 1,
      createdAt: new Date().toISOString(),
    };
    // 新页面先落盘（空数据），再写 meta —— 保证 meta 指向的文件一定存在
    await this.savePage(id, { nodes: [], edges: [] });
    const nextMeta: Meta = { ...meta, pages: [...meta.pages, info] };
    await this.atomicWriteJson(this.metaPath, nextMeta);
    return info;
  }

  async deletePage(pageId: string): Promise<void> {
    const meta = await this.loadMeta();
    if (meta.pages.length <= 1) {
      throw new Error('last page cannot be deleted');
    }
    const nextPages = meta.pages.filter((p) => p.id !== pageId);
    if (nextPages.length === meta.pages.length) {
      throw new Error(`page not found: ${pageId}`);
    }
    const nextActive =
      meta.activePageId === pageId ? (nextPages[0]?.id ?? meta.activePageId) : meta.activePageId;
    const nextMeta: Meta = { ...meta, pages: nextPages, activePageId: nextActive };
    // 先更新 meta 再删文件：即使删文件失败，用户也看不到幽灵页面
    await this.atomicWriteJson(this.metaPath, nextMeta);
    try {
      await fs.unlink(this.pageFilePath(pageId));
    } catch (err) {
      // 幂等：文件已经不在也算成功
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
    }
  }

  async renamePage(pageId: string, title: string): Promise<void> {
    const meta = await this.loadMeta();
    const idx = meta.pages.findIndex((p) => p.id === pageId);
    if (idx < 0) throw new Error(`page not found: ${pageId}`);
    const cleaned = title.trim() || meta.pages[idx]!.title;
    const nextPages = [...meta.pages];
    nextPages[idx] = { ...nextPages[idx]!, title: cleaned };
    await this.atomicWriteJson(this.metaPath, { ...meta, pages: nextPages });
  }

  async reorderPages(ids: string[]): Promise<void> {
    const meta = await this.loadMeta();
    const byId = new Map(meta.pages.map((p) => [p.id, p]));
    if (ids.length !== meta.pages.length || ids.some((id) => !byId.has(id))) {
      throw new Error('reorder ids do not match existing pages');
    }
    const nextPages: PageInfo[] = ids.map((id, i) => ({ ...byId.get(id)!, order: i }));
    await this.atomicWriteJson(this.metaPath, { ...meta, pages: nextPages });
  }

  async setActivePage(pageId: string): Promise<void> {
    const meta = await this.loadMeta();
    if (!meta.pages.some((p) => p.id === pageId)) {
      throw new Error(`page not found: ${pageId}`);
    }
    if (meta.activePageId === pageId) return;
    await this.atomicWriteJson(this.metaPath, { ...meta, activePageId: pageId });
  }

  async updateSettings(settings: WorkspaceSettings): Promise<void> {
    const meta = await this.loadMeta();
    await this.atomicWriteJson(this.metaPath, { ...meta, settings });
  }

  async listPageMtimes(): Promise<Array<{ pageId: string; mtimeMs: number }>> {
    const meta = await this.loadMeta();
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
  }

  async createBackup(pageId: string): Promise<void> {
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
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, target);
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
    const pageTitle = hasLegacy ? '默认' : '毕设示例';
    await this.savePage(pageId, { nodes: seedGraph.nodes, edges: seedGraph.edges });

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
