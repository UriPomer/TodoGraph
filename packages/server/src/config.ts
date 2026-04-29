import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  dataFile: string;
  /** 生产模式下静态文件根目录（前端构建产物）。dev 下留空。 */
  staticDir?: string;
}

export function resolveConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cwd = process.cwd();
  return {
    port: Number(process.env.PORT ?? 5173),
    host: process.env.HOST ?? '127.0.0.1',
    dataFile: process.env.DATA_FILE ?? path.join(cwd, 'data', 'tasks.json'),
    staticDir: process.env.STATIC_DIR,
    ...overrides,
  };
}
