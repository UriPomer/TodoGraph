import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifySecureSession from '@fastify/secure-session';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import { workspaceRoutes } from './routes/workspace.js';
import { mcpRoutes } from './routes/mcp.js';
import { authRoutes, authHook } from './auth.js';
import { McpKeyStore } from './mcp-keys.js';
import { FileWorkspaceRepository } from './repositories/FileWorkspaceRepository.js';
import { FileUserRepository } from './repositories/FileUserRepository.js';
import { FileRememberTokenRepository } from './repositories/FileRememberTokenRepository.js';
import type { WorkspaceRepository } from './repositories/Repository.js';

export interface AppOptions {
  /** Local file repositories serialize writers per dataDir; network filesystems are unsupported. */
  dataDir: string;
  staticDir?: string;
  registrationKey: string;
  sessionSecret: string;
  cookieSecure?: boolean;
  /** Exact renderer origin allowed to call the API in Electron development. */
  corsOrigin?: string;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  // Security plugins
  if (opts.corsOrigin) {
    await app.register(fastifyCors, {
      origin: (origin, callback) => {
        callback(null, origin === opts.corsOrigin);
      },
      credentials: true,
    });
  }
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  await app.register(fastifyRateLimit, {
    max: opts.logger === false ? 1000 : 100,
    timeWindow: '1 minute'
  });

  // Session (encrypted httpOnly cookie)
  if (!opts.sessionSecret || Buffer.from(opts.sessionSecret).length !== 32) {
    throw new Error('SESSION_SECRET must be exactly 32 bytes');
  }
  await app.register(fastifyCookie);
  await app.register(fastifySecureSession, {
    key: Buffer.from(opts.sessionSecret),
    cookie: {
      path: '/',
      httpOnly: true,
      secure: opts.cookieSecure ?? false,
      sameSite: 'strict',
    },
  });

  // User repo + auth routes
  const userRepo = new FileUserRepository(opts.dataDir);
  const rememberTokenStore = new FileRememberTokenRepository(opts.dataDir);
  const keyStore = new McpKeyStore(opts.dataDir);
  await app.register(authRoutes, {
    userRepo,
    rememberTokenStore,
    registrationKey: opts.registrationKey,
    cookieSecure: opts.cookieSecure ?? false,
  });

  // Per-user workspace repo factory
  const getRepo = (userId: string): WorkspaceRepository =>
    new FileWorkspaceRepository(path.join(opts.dataDir, 'users', userId), opts.dataDir);

  // Protected API routes share one auth hook scope so every request is validated consistently.
  await app.register(async (protectedApi) => {
    protectedApi.addHook('onSend', async (_req, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    protectedApi.addHook('onRequest', authHook(
      userRepo,
      keyStore,
    ));
    await protectedApi.register(mcpRoutes, { keyStore });
    await protectedApi.register(workspaceRoutes, { getRepo });
  });

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
