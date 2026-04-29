import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { graphRoutes } from './routes/graph.js';
import type { GraphRepository } from './repositories/Repository.js';

export interface AppOptions {
  repo: GraphRepository;
  /** 若提供，生产模式下会作为前端静态资源目录 */
  staticDir?: string;
  logger?: boolean;
}

/**
 * 装配 Fastify 应用。
 * 分离成工厂便于：
 *  - 测试（注入 mock repo）
 *  - Electron 主进程复用（起动态端口）
 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(graphRoutes, { repo: opts.repo });

  if (opts.staticDir) {
    await app.register(fastifyStatic, {
      root: path.resolve(opts.staticDir),
      prefix: '/',
    });
    // SPA 兜底：非 API 非静态资源的请求，回退到 index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.status(404).send({ error: 'not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
