import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import { workspaceRoutes } from './routes/workspace.js';
import { authRoutes, authHook } from './auth.js';
import { FileWorkspaceRepository } from './repositories/FileWorkspaceRepository.js';
import { FileUserRepository } from './repositories/FileUserRepository.js';
import type { WorkspaceRepository } from './repositories/Repository.js';

export interface AppOptions {
  dataDir: string;
  staticDir?: string;
  registrationKey: string;
  sessionSecret: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // Security plugins
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyRateLimit, {
    max: opts.logger === false ? 1000 : 100,
    timeWindow: '1 minute'
  });

  // Session (encrypted httpOnly cookie)
  if (!opts.sessionSecret || opts.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  await app.register(fastifyCookie);
  await app.register(fastifySecureSession, {
    key: Buffer.from(opts.sessionSecret),
    cookie: {
      path: '/',
      httpOnly: true,
      secure: false, // Caddy handles HTTPS, internal traffic is HTTP
      sameSite: 'strict',
      maxAge: 24 * 60 * 60, // 24h
    },
  });

  // User repo + auth routes
  const userRepo = new FileUserRepository(opts.dataDir);
  await app.register(authRoutes, { userRepo, registrationKey: opts.registrationKey });

  // Per-user workspace repo factory
  const getRepo = (userId: string): WorkspaceRepository =>
    new FileWorkspaceRepository(path.join(opts.dataDir, 'users', userId), opts.dataDir);

  // Workspace routes — pass factory, not a single repo
  await app.register(workspaceRoutes, { getRepo });

  // Auth hook: protect /api/* after auth routes are registered
  app.addHook('onRequest', authHook(userRepo));

  // Static files (production)
  if (opts.staticDir) {
    await app.register(fastifyStatic, {
      root: path.resolve(opts.staticDir),
      prefix: '/',
    });
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
