import type { Graph, Meta, NodeOverlapConflict, PageData, PageInfo } from '@todograph/shared';

/** Legacy v1 port kept for consumers migrating single-file graphs. */
export interface GraphRepository {
  load(): Promise<Graph>;
  save(graph: Graph): Promise<void>;
}

export class VersionConflictError extends Error {
  constructor(
    public pageId: string,
    public serverVersion: number,
  ) {
    super(`版本冲突：页面已被其他设备修改（服务端版本 ${serverVersion}），请刷新后重试`);
    this.name = 'VersionConflictError';
  }
}

export class MetaVersionConflictError extends Error {
  constructor(public serverRevision: number) {
    super(`版本冲突：工作区元信息已被其他设备修改（服务端 revision ${serverRevision}），请刷新后重试`);
    this.name = 'MetaVersionConflictError';
  }
}

export class TaskTitleTooLongError extends Error {
  constructor(
    public taskId: string,
    public maxLength: number,
  ) {
    super(`task title exceeds ${maxLength} characters: ${taskId}`);
    this.name = 'TaskTitleTooLongError';
  }
}

export class NodeOverlapError extends Error {
  constructor(
    public pageId: string,
    public conflicts: NodeOverlapConflict[],
  ) {
    super(`page contains overlapping sibling nodes: ${pageId}`);
    this.name = 'NodeOverlapError';
  }
}

export interface BackupInfo {
  name: string;
  createdAt: string;
  size: number;
}

export interface TrashedPageInfo {
  name: string;
  deletedAt: string;
  page: PageInfo;
  size: number;
}

export interface WorkspaceExport {
  exportedAt: string;
  meta: Meta;
  pages: Record<string, PageData>;
}

/**
 * 工作区（多页面）持久化抽象。v2。
 *
 * 所有实现必须保证：
 *  - 原子写：页面/meta 文件的写入不能半途损坏（tmp+rename）。
 *  - 失败抛异常：调用方负责转成 HTTP 响应 / Toast。
 *  - 迁移可恢复：新 meta.json 提交前保留旧入口和验证过的备份。
 *  - 乐观锁：savePage 可接受 expectedVersion 做版本比对，
 *    不匹配时抛 VersionConflictError，防止多设备覆盖。
 */
export interface WorkspaceRepository {
  /**
   * 读工作区元信息。若 meta.json 不存在，执行一次性迁移：
   *  - 有老 tasks.json → 迁成 default page + copy bak
   *  - 无老数据 → 建 default page 含 SEED
   * 最后一步写 meta.json 才算完成。
   */
  loadMeta(): Promise<Meta>;
  loadPage(pageId: string): Promise<PageData>;
  /**
   * 保存页面。若 expectedVersion 传入且与服务端版本不匹配，抛 VersionConflictError。
   * 返回写入后的新版本号。
   */
  savePage(pageId: string, data: PageData, expectedVersion?: number): Promise<number>;
  savePages(
    entries: Array<{ pageId: string; data: PageData; expectedVersion?: number }>,
  ): Promise<number[]>;
  createPage(title: string, expectedRevision?: number): Promise<{ page: PageInfo; meta: Meta }>;
  deletePage(pageId: string, expectedRevision?: number): Promise<Meta>;
  renamePage(pageId: string, title: string, expectedRevision?: number): Promise<Meta>;
  reorderPages(ids: string[], expectedRevision?: number): Promise<Meta>;
  setActivePage(pageId: string, expectedRevision?: number): Promise<Meta>;
  exportWorkspace(): Promise<WorkspaceExport>;
  importWorkspace(data: WorkspaceExport): Promise<Meta>;
  /** 将当前页面文件拷贝到 backups/ 目录，保留最近 50 份，按时间戳命名。 */
  createBackup(pageId: string): Promise<void>;
  listBackups(pageId: string): Promise<BackupInfo[]>;
  restoreBackup(pageId: string, backupName: string, expectedVersion?: number): Promise<PageData>;
  /** 从最新备份恢复页面文件。若不存在备份则抛异常。返回恢复后的页面数据。 */
  restoreLatestBackup(pageId: string, expectedVersion?: number): Promise<PageData>;
  listTrashedPages(): Promise<TrashedPageInfo[]>;
  restoreTrashedPage(
    name: string,
    expectedRevision?: number,
  ): Promise<{ meta: Meta; page: PageInfo; data: PageData; cleanupWarning?: string }>;
  /** 列出所有 page 的文件路径与 mtime —— 用于 /api/all-tasks 的缓存失效判断。 */
  listPageMtimes(): Promise<Array<{ pageId: string; mtimeMs: number | null }>>;
}
