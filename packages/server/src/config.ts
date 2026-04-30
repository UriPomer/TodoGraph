import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  /**
   * 工作区数据目录（v2 布局）：
   *   {dataDir}/meta.json
   *   {dataDir}/pages/{pageId}.json
   *   {dataDir}/tasks.json.v1.bak   （首次迁移后）
   *
   * 向后兼容：如果传入 DATA_FILE（老环境变量），
   *   取其父目录作为 dataDir —— 这样 `DATA_FILE=data/tasks.json`
   *   会自然落到 `data/` 目录，而迁移逻辑会把同名老文件升级成 v2 结构。
   */
  dataDir: string;
  /** 生产模式下静态文件根目录（前端构建产物）。dev 下留空。 */
  staticDir?: string;
}

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cwd = process.cwd();
  // 兼容旧的 DATA_FILE：取其父目录；否则走 DATA_DIR / 默认 cwd/data
  const envDataDir = process.env.DATA_DIR;
  const legacyDataFile = process.env.DATA_FILE;
  const fallbackDir = legacyDataFile
    ? path.dirname(legacyDataFile)
    : path.join(cwd, 'data');
  return {
    port: Number(process.env.PORT ?? 5173),
    host: process.env.HOST ?? '127.0.0.1',
    dataDir: envDataDir ?? fallbackDir,
    staticDir: process.env.STATIC_DIR,
    ...overrides,
  };
}
