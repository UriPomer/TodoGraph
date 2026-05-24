import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/secure-session';
import type { UserRepository } from './repositories/UserRepository.js';
import type { McpKeyStore } from './mcp-keys.js';

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
    // Always run scryptSync to prevent timing-based user enumeration.
    // When user doesn't exist, verify against a synthetic hash with identical cost.
    const hash = user?.passwordHash ?? '00:00'; // dummy salt:hash, scryptSync runs the same
    const ok = verifyPassword(password, hash) && user !== null;
    if (!ok) {
      reply.status(401);
      return { ok: false, error: '用户名或密码错误' };
    }
    req.session.userId = user!.id;
    return { ok: true, username: user!.username };
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
    const id = 'u' + Date.now().toString(36) + randomBytes(8).toString('base64url');
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

const MCP_API_KEY = process.env.MCP_API_KEY;
const MCP_USER_ID = process.env.MCP_USER_ID;

/** MCP_API_KEYS: JSON map of apiKey → userId，用于多用户场景。
 *  格式: {"key1": "userId1", "key2": "userId2"}
 *  与 MCP_API_KEY 互斥 —— 设了 MCP_API_KEYS 则忽略 MCP_API_KEY。 */
function parseMCPKeys(): Map<string, string> {
  const raw = process.env.MCP_API_KEYS;
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return new Map();
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > 0) map.set(k, v);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function resolveUserId(
  authHeader: string | undefined,
  keyStore: McpKeyStore | null,
): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // 1. 多用户模式（env）：MCP_API_KEYS JSON map
  const mcpKeys = parseMCPKeys();
  if (mcpKeys.size > 0) {
    // 拒绝短 key（env 配置中 key < 20 字符视为 misconfiguration）
    if (token.length < 20) return null;
    return mcpKeys.get(token) ?? null;
  }

  // 2. 单用户模式（env）：MCP_API_KEY + MCP_USER_ID
  if (MCP_API_KEY && MCP_USER_ID && token === MCP_API_KEY) {
    if (MCP_API_KEY.length < 20) return null;
    return MCP_USER_ID;
  }

  // 3. 动态 key（文件存储）：用户在 UI 里生成的 key
  if (keyStore) {
    return keyStore.findUserId(token);
  }

  return null;
}

/** 全局 onRequest hook：保护所有 /api/* （除了 /api/auth/*）。
 *
 *  认证优先级：
 *  1. env MCP_API_KEYS（多用户）或 MCP_API_KEY（单用户）
 *  2. 动态 key 文件（用户在 UI 里生成）
 *  3. Session cookie（浏览器登录态）
 *
 *  API key 认证只能访问 MCP 工具所需的白名单端点；
 *  禁止直接访问全量 REST API，防止 AI 绕过 MCP 的保护层
 *  （布局计算、碰撞检测、自动备份）。
 */
export function authHook(userRepo: UserRepository, keyStore: McpKeyStore | null = null) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (req.url.startsWith('/api/auth/')) return;
    if (!req.url.startsWith('/api/')) return;

    // API key 优先：env 配置或动态 key 文件
    const mcpUserId = await resolveUserId(req.headers.authorization, keyStore);
    if (mcpUserId) {
      // 白名单：API key 只能访问 MCP 工具所需的端点
      if (!isAPIKeyAllowed(req.method, req.url)) {
        reply.status(403);
        return { ok: false, error: 'API key 不能直接访问此端点，请通过 MCP 工具操作' };
      }
      req.session.userId = mcpUserId;
      return;
    }

    // 回退到 session 认证（浏览器用户，无限制）
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

/**
 * API key 端点白名单。
 * key: "METHOD:/api/path/pattern"  用 {id} 代表动态段。
 */
const API_KEY_ALLOWLIST = new Set([
  'GET:/api/meta',
  'GET:/api/pages/{id}',
  'GET:/api/all-tasks',
  'POST:/api/pages',
  'PUT:/api/pages/{id}',
  'DELETE:/api/pages/{id}',
  'POST:/api/pages/{id}/backup',
  'POST:/api/pages/{id}/restore',
  'POST:/api/pages/{id}/move-nodes',
]);

function isAPIKeyAllowed(method: string, url: string): boolean {
  // 去除 query string
  const path = url.split('?')[0]!;
  for (const pattern of API_KEY_ALLOWLIST) {
    const [pm, pp] = pattern.split(':', 2);
    if (pm !== method) continue;
    if (matchPath(pp!, path)) return true;
  }
  return false;
}

/** 简单路径匹配：{id} 匹配不含 / 的任意段 */
function matchPath(pattern: string, path: string): boolean {
  const pp = pattern.split('/');
  const ps = path.split('/');
  if (pp.length !== ps.length) return false;
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === '{id}') continue;
    if (pp[i] !== ps[i]) return false;
  }
  return true;
}
