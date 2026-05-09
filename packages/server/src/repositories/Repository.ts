import type { Graph, Meta, PageData, PageInfo } from '@todograph/shared';

/**
 * 图数据的持久化抽象（v1，legacy）。
 * 保留是为了让迁移脚本能继续以"一整张图"的视角读老 tasks.json。
 * 新代码不应再实现这个 —— 用 WorkspaceRepository。
 */
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

/**
 * 工作区（多页面）持久化抽象。v2。
 *
 * 所有实现必须保证：
 *  - 原子写：页面/meta 文件的写入不能半途损坏（tmp+rename）。
 *  - 失败抛异常：调用方负责转成 HTTP 响应 / Toast。
 *  - 迁移幂等：没有 meta.json 才会跑迁移，跑完之后不会再跑。
 *  - 乐观锁：savePage 可接受 expectedVersion 做版本比对，
 *    不匹配时抛 VersionConflictError，防止多设备覆盖。
 */
export interface WorkspaceRepository {
  /**
   * 读工作区元信息。若 meta.json 不存在，执行一次性迁移：
   *  - 有老 tasks.json → 迁成 default page + rename bak
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
  createPage(title: string): Promise<PageInfo>;
  deletePage(pageId: string): Promise<void>;
  renamePage(pageId: string, title: string): Promise<void>;
  reorderPages(ids: string[]): Promise<void>;
  setActivePage(pageId: string): Promise<void>;
  updateSettings(settings: NonNullable<Meta['settings']>): Promise<void>;
  /** 将当前页面文件拷贝到 backups/ 目录，保留最近 50 份，按时间戳命名。 */
  createBackup(pageId: string): Promise<void>;
  /** 列出所有 page 的文件路径与 mtime —— 用于 /api/all-tasks 的缓存失效判断。 */
  listPageMtimes(): Promise<Array<{ pageId: string; mtimeMs: number }>>;
}
