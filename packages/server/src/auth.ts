import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/secure-session';
import type { UserRepository } from './repositories/UserRepository.js';

const SALT_LEN = 32;
const KEY_LEN = 64;

function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN).toString('hex');
  const hash = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const buf = scryptSync(password, salt, KEY_LEN);
    return timingSafeEqual(buf, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
  }
}

interface AuthRouteOpts {
  userRepo: UserRepository;
  registrationKey: string;
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOpts) {
  const { userRepo, registrationKey } = opts;

  // POST /api/auth/login
  app.post('/api/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { username?: string; password?: string } | null;
    const username = body?.username?.trim();
    const password = body?.password;
    if (!username || !password) {
      reply.status(400);
      return { ok: false, error: '用户名和密码不能为空' };
    }
    const user = await userRepo.findByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      reply.status(401);
      return { ok: false, error: '用户名或密码错误' };
    }
    req.session.userId = user.id;
    return { ok: true, username: user.username };
  });

  // POST /api/auth/register
  app.post('/api/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { username?: string; password?: string; registrationKey?: string } | null;
    const username = body?.username?.trim();
    const password = body?.password;
    if (!username || !password) {
      reply.status(400);
      return { ok: false, error: '用户名和密码不能为空' };
    }
    if (username.length < 2 || username.length > 32) {
      reply.status(400);
      return { ok: false, error: '用户名长度 2-32 字符' };
    }
    if (password.length < 6) {
      reply.status(400);
      return { ok: false, error: '密码至少 6 位' };
    }
    // 注册控制：有邀请码则需要匹配；无邀请码 + 不是首次启动 → 拒绝
    const existingUsers = await userRepo.findAll();
    if (existingUsers.length > 0) {
      if (!registrationKey) {
        reply.status(403);
        return { ok: false, error: '注册已关闭' };
      }
      if (body?.registrationKey !== registrationKey) {
        reply.status(403);
        return { ok: false, error: '邀请码错误' };
      }
    }
    if (await userRepo.findByUsername(username)) {
      reply.status(409);
      return { ok: false, error: '用户名已存在' };
    }
    const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await userRepo.create({
      id,
      username,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    });
    req.session.userId = id;
    return { ok: true, username };
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', async (req: FastifyRequest) => {
    req.session.userId = '';
    return { ok: true };
  });

  // GET /api/auth/me
  app.get('/api/auth/me', async (req: FastifyRequest) => {
    const userId = req.session.userId;
    if (!userId) return { ok: false };
    const user = await userRepo.findById(userId);
    if (!user) return { ok: false };
    return { ok: true, id: user.id, username: user.username };
  });
}

/** 全局 onRequest hook：保护所有 /api/* （除了 /api/auth/*） */
export function authHook(userRepo: UserRepository) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (req.url.startsWith('/api/auth/')) return;
    if (!req.url.startsWith('/api/')) return;
    const userId = req.session.userId;
    if (!userId) {
      reply.status(401);
      return { ok: false, error: '请先登录' };
    }
    // 校验用户仍存在
    const user = await userRepo.findById(userId);
    if (!user) {
      req.session.userId = '';
      reply.status(401);
      return { ok: false, error: '用户不存在，请重新登录' };
    }
  };
}
