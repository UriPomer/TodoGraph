import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/secure-session';
import type { StoredUser, UserRepository } from './repositories/UserRepository.js';
import type { McpKeyScope, McpKeyStore } from './mcp-keys.js';
import {
  isOlderMcpVersion,
  isValidMcpVersion,
  LATEST_MCP_VERSION,
  mcpUpdateRequired,
  MCP_LATEST_VERSION_HEADER,
  MCP_VERSION_HEADER,
} from './mcp-version.js';
import type { RememberTokenRepository } from './repositories/RememberTokenRepository.js';

const SALT_LEN = 32;
const KEY_LEN = 64;
const DUMMY_PASSWORD_HASH = `${'00'.repeat(SALT_LEN)}:${'00'.repeat(KEY_LEN)}`;
const REMEMBER_COOKIE = 'todograph_remember';
const REMEMBER_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SESSION_ABSOLUTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NATIVE_EPHEMERAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const NATIVE_PERSISTENT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const NATIVE_TOKEN_PREFIX = 'tdg-native-';

function secureStringEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码过长';
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) {
    return '密码必须同时包含字母和数字';
  }
  return null;
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN).toString('hex');
  const hash = (await derivePassword(password, salt)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const buf = await derivePassword(password, salt);
    return timingSafeEqual(buf, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

declare module '@fastify/secure-session' {
  interface SessionData {
    userId: string;
    sessionVersion?: number;
    issuedAt?: number;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    authUserId?: string;
    apiKeyScopes?: McpKeyScope[];
  }
}

export function getAuthenticatedUserId(req: FastifyRequest): string {
  const userId = req.authUserId ?? req.session.userId;
  if (!userId) throw new Error('authenticated user id missing');
  return userId;
}

/** Browser sessions are unrestricted; API-key requests must carry the requested scope. */
export function hasAuthenticatedScope(req: FastifyRequest, scope: McpKeyScope): boolean {
  return req.apiKeyScopes === undefined || req.apiKeyScopes.includes(scope);
}

interface AuthRouteOpts {
  userRepo: UserRepository;
  rememberTokenStore: RememberTokenRepository;
  registrationKey: string;
  cookieSecure: boolean;
}

type SessionValidationResult =
  | { ok: true; user: StoredUser }
  | { ok: false; error: 'unauthenticated' | 'expired' | 'invalidated' | 'missing-user' };

type AccountResult =
  | { ok: true; user: StoredUser }
  | { ok: false; status: number; error: string };

async function authenticateCredentials(body: unknown, userRepo: UserRepository): Promise<AccountResult> {
  const value = body as Record<string, unknown> | null;
  if (typeof value?.username !== 'string' || typeof value.password !== 'string') {
    return { ok: false, status: 400, error: '用户名和密码不能为空' };
  }
  const username = value.username.trim();
  const password = value.password;
  if (!username || !password) return { ok: false, status: 400, error: '用户名和密码不能为空' };
  if (username.length > 32 || password.length > 200) {
    return { ok: false, status: 401, error: '用户名或密码错误' };
  }
  const user = await userRepo.findByUsername(username);
  const valid = (await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)) && user !== null;
  return valid ? { ok: true, user: user! } : { ok: false, status: 401, error: '用户名或密码错误' };
}

async function registerAccount(
  body: unknown,
  userRepo: UserRepository,
  registrationKey: string,
): Promise<AccountResult> {
  const value = body as Record<string, unknown> | null;
  if (
    typeof value?.username !== 'string'
    || typeof value.password !== 'string'
    || (value.registrationKey !== undefined && typeof value.registrationKey !== 'string')
  ) return { ok: false, status: 400, error: '注册信息格式错误' };
  const username = value.username.trim();
  const password = value.password;
  if (!username || !password) return { ok: false, status: 400, error: '用户名和密码不能为空' };
  if (username.length < 2 || username.length > 32) {
    return { ok: false, status: 400, error: '用户名长度 2-32 字符' };
  }
  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, status: 400, error: passwordError };
  const submittedKey = typeof value.registrationKey === 'string' ? value.registrationKey : '';
  const allowAdditional = Boolean(registrationKey && secureStringEqual(submittedKey, registrationKey));
  const id = 'u' + Date.now().toString(36) + randomBytes(8).toString('base64url');
  const result = await userRepo.register({
    id,
    username,
    passwordHash: await hashPassword(password),
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
  }, allowAdditional);
  if (result === 'closed') {
    return { ok: false, status: 403, error: registrationKey ? '邀请码错误' : '注册已关闭' };
  }
  if (result === 'duplicate') return { ok: false, status: 409, error: '用户名已存在' };
  const user = await userRepo.findById(id);
  if (!user) throw new Error('newly registered user missing');
  return { ok: true, user };
}

async function changeAccountPassword(
  body: unknown,
  user: StoredUser,
  userRepo: UserRepository,
  rememberTokenStore: RememberTokenRepository,
): Promise<AccountResult> {
  const value = body as Record<string, unknown> | null;
  if (typeof value?.currentPassword !== 'string' || typeof value.newPassword !== 'string') {
    return { ok: false, status: 400, error: '当前密码和新密码不能为空' };
  }
  const currentPassword = value.currentPassword;
  const newPassword = value.newPassword;
  if (!currentPassword || !newPassword) {
    return { ok: false, status: 400, error: '当前密码和新密码不能为空' };
  }
  if (currentPassword.length > 200) {
    return { ok: false, status: 401, error: '当前密码错误' };
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) return { ok: false, status: 400, error: passwordError };
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, status: 401, error: '当前密码错误' };
  }
  if (await verifyPassword(newPassword, user.passwordHash)) {
    return { ok: false, status: 400, error: '新密码不能与当前密码相同' };
  }

  const nextUser = { ...user, sessionVersion: user.sessionVersion + 1 };
  await userRepo.updatePasswordHash(
    user.id,
    await hashPassword(newPassword),
    nextUser.sessionVersion,
  );
  await rememberTokenStore.revokeUser(user.id);
  return { ok: true, user: nextUser };
}

function nativeRawToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith(`Bearer ${NATIVE_TOKEN_PREFIX}`)) return null;
  return authorization.slice(`Bearer ${NATIVE_TOKEN_PREFIX}`.length) || null;
}

async function validateNativeUser(
  authorization: string | undefined,
  userRepo: UserRepository,
  rememberTokenStore: RememberTokenRepository,
): Promise<(SessionValidationResult & { rawToken?: string })> {
  const rawToken = nativeRawToken(authorization);
  if (!rawToken) return { ok: false, error: 'unauthenticated' };
  const credential = await rememberTokenStore.verify(rawToken, 'native');
  if (credential.status !== 'valid') return { ok: false, error: 'invalidated' };
  const user = await userRepo.findById(credential.userId);
  if (!user) return { ok: false, error: 'missing-user' };
  if (user.sessionVersion !== credential.sessionVersion) return { ok: false, error: 'invalidated' };
  return { ok: true, user, rawToken };
}

async function issueNativeToken(
  store: RememberTokenRepository,
  user: StoredUser,
  remember: boolean,
): Promise<string> {
  const raw = await store.issue(user.id, user.sessionVersion, {
    purpose: 'native',
    lifetimeMs: remember ? NATIVE_PERSISTENT_LIFETIME_MS : NATIVE_EPHEMERAL_LIFETIME_MS,
  });
  return NATIVE_TOKEN_PREFIX + raw;
}

function establishSession(req: FastifyRequest, user: StoredUser): void {
  req.session.regenerate();
  req.session.userId = user.id;
  req.session.sessionVersion = user.sessionVersion;
  req.session.issuedAt = Date.now();
}

function setRememberCookie(
  reply: FastifyReply,
  token: string,
  cookieSecure: boolean,
  maxAge = REMEMBER_MAX_AGE_SECONDS,
): void {
  reply.setCookie(REMEMBER_COOKIE, token, {
    path: '/api',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    maxAge,
  });
}

function clearRememberCookie(reply: FastifyReply, cookieSecure: boolean): void {
  reply.clearCookie(REMEMBER_COOKIE, {
    path: '/api',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
  });
}

async function validateSessionUser(
  req: FastifyRequest,
  userRepo: UserRepository,
): Promise<SessionValidationResult> {
  const userId = req.session.userId;
  if (!userId) return { ok: false, error: 'unauthenticated' };

  if (typeof req.session.issuedAt !== 'number') {
    return { ok: false, error: 'invalidated' };
  }
  if (Date.now() - req.session.issuedAt > SESSION_ABSOLUTE_MAX_AGE_MS) {
    return { ok: false, error: 'expired' };
  }

  const user = await userRepo.findById(userId);
  if (!user) return { ok: false, error: 'missing-user' };

  if (
    typeof req.session.sessionVersion !== 'number' ||
    req.session.sessionVersion !== user.sessionVersion
  ) {
    return { ok: false, error: 'invalidated' };
  }

  return { ok: true, user };
}

async function authenticateBrowser(
  req: FastifyRequest,
  reply: FastifyReply,
  userRepo: UserRepository,
  rememberTokenStore: RememberTokenRepository,
  cookieSecure: boolean,
): Promise<SessionValidationResult> {
  const session = await validateSessionUser(req, userRepo);
  if (session.ok) return session;

  const rawToken = req.cookies[REMEMBER_COOKIE];
  if (!rawToken) return session;

  const remembered = await rememberTokenStore.consume(rawToken);
  if (remembered.status !== 'valid') {
    req.session.delete();
    clearRememberCookie(reply, cookieSecure);
    return { ok: false, error: 'invalidated' };
  }

  const user = await userRepo.findById(remembered.userId);
  if (!user || user.sessionVersion !== remembered.sessionVersion) {
    await rememberTokenStore.revoke(rawToken);
    req.session.delete();
    clearRememberCookie(reply, cookieSecure);
    return { ok: false, error: user ? 'invalidated' : 'missing-user' };
  }

  establishSession(req, user);
  if (remembered.rotatedToken) {
    const secondsRemaining = Math.max(
      1,
      Math.floor((new Date(remembered.expiresAt).getTime() - Date.now()) / 1000),
    );
    setRememberCookie(reply, remembered.rotatedToken, cookieSecure, secondsRemaining);
  }
  return { ok: true, user };
}

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOpts) {
  const { userRepo, rememberTokenStore, registrationKey, cookieSecure } = opts;

  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // POST /api/auth/login
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await authenticateCredentials(req.body, userRepo);
    if (!result.ok) return reply.status(result.status).send({ ok: false, error: result.error });
    const user = result.user;
    const body = req.body as Record<string, unknown>;
    const existingRememberToken = req.cookies[REMEMBER_COOKIE];
    if (existingRememberToken) await rememberTokenStore.revoke(existingRememberToken);
    establishSession(req, user);
    if (body.remember === true) {
      setRememberCookie(
        reply,
        await rememberTokenStore.issue(user.id, user.sessionVersion),
        cookieSecure,
      );
    } else {
      clearRememberCookie(reply, cookieSecure);
    }
    return { ok: true, username: user.username };
  });

  // POST /api/auth/register
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await registerAccount(req.body, userRepo, registrationKey);
    if (!result.ok) return reply.status(result.status).send({ ok: false, error: result.error });
    const createdUser = result.user;
    const body = req.body as Record<string, unknown>;
    establishSession(req, createdUser);
    if (body.remember === true) {
      setRememberCookie(reply, await rememberTokenStore.issue(createdUser.id, 0), cookieSecure);
    }
    return { ok: true, username: createdUser.username };
  });

  app.post('/api/auth/change-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    const hadRememberToken = Boolean(req.cookies[REMEMBER_COOKIE]);
    const session = await authenticateBrowser(req, reply, userRepo, rememberTokenStore, cookieSecure);
    if (!session.ok) {
      reply.status(401);
      if (session.error !== 'unauthenticated') reply.header('X-Session-Expired', '1');
      return { ok: false, error: session.error === 'unauthenticated' ? '请先登录' : '会话已失效，请重新登录' };
    }

    const changed = await changeAccountPassword(req.body, session.user, userRepo, rememberTokenStore);
    if (!changed.ok) return reply.status(changed.status).send({ ok: false, error: changed.error });
    establishSession(req, changed.user);
    if (hadRememberToken) {
      setRememberCookie(
        reply,
        await rememberTokenStore.issue(changed.user.id, changed.user.sessionVersion),
        cookieSecure,
      );
    } else {
      clearRememberCookie(reply, cookieSecure);
    }
    return { ok: true };
  });

  // POST /api/auth/logout
  app.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawToken = req.cookies[REMEMBER_COOKIE];
    if (rawToken) await rememberTokenStore.revoke(rawToken);
    req.session.delete();
    clearRememberCookie(reply, cookieSecure);
    return { ok: true };
  });

  // GET /api/auth/me
  app.get('/api/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await authenticateBrowser(req, reply, userRepo, rememberTokenStore, cookieSecure);
    if (!session.ok) return { ok: false };
    return { ok: true, id: session.user.id, username: session.user.username };
  });

  app.post('/api/auth/native/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const result = await authenticateCredentials(req.body, userRepo);
    if (!result.ok) return reply.status(result.status).send({ ok: false, error: result.error });
    const remember = (req.body as Record<string, unknown>).remember === true;
    return {
      ok: true,
      user: { id: result.user.id, username: result.user.username },
      token: await issueNativeToken(rememberTokenStore, result.user, remember),
    };
  });

  app.post('/api/auth/native/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const result = await registerAccount(req.body, userRepo, registrationKey);
    if (!result.ok) return reply.status(result.status).send({ ok: false, error: result.error });
    const remember = (req.body as Record<string, unknown>).remember === true;
    return {
      ok: true,
      user: { id: result.user.id, username: result.user.username },
      token: await issueNativeToken(rememberTokenStore, result.user, remember),
    };
  });

  app.get('/api/auth/native/me', async (req, reply) => {
    const result = await validateNativeUser(req.headers.authorization, userRepo, rememberTokenStore);
    if (!result.ok) return reply.status(401).send({ ok: false });
    return { ok: true, user: { id: result.user.id, username: result.user.username } };
  });

  app.post('/api/auth/native/logout', async (req) => {
    const raw = nativeRawToken(req.headers.authorization);
    if (raw) await rememberTokenStore.revoke(raw);
    return { ok: true };
  });

  app.post('/api/auth/native/change-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const auth = await validateNativeUser(req.headers.authorization, userRepo, rememberTokenStore);
    if (!auth.ok) {
      reply.header('X-Session-Expired', '1');
      return reply.status(401).send({ ok: false, error: '会话已失效，请重新登录' });
    }
    const changed = await changeAccountPassword(req.body, auth.user, userRepo, rememberTokenStore);
    if (!changed.ok) return reply.status(changed.status).send({ ok: false, error: changed.error });
    const remember = (req.body as Record<string, unknown>).remember === true;
    return { ok: true, token: await issueNativeToken(rememberTokenStore, changed.user, remember) };
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

export async function resolveMcpPrincipal(
  authHeader: string | undefined,
  keyStore: McpKeyStore | null,
): Promise<{ userId: string; scopes: McpKeyScope[] } | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // 1. 多用户模式（env）：MCP_API_KEYS JSON map
  const mcpKeys = parseMCPKeys();
  if (mcpKeys.size > 0) {
    // 拒绝短 key（env 配置中 key < 20 字符视为 misconfiguration）
    if (token.length < 20) return null;
    const userId = mcpKeys.get(token);
    return userId ? { userId, scopes: ['read', 'write', 'destructive'] } : null;
  }

  // 2. 单用户模式（env）：MCP_API_KEY + MCP_USER_ID
  if (MCP_API_KEY && MCP_USER_ID && secureStringEqual(token, MCP_API_KEY)) {
    if (MCP_API_KEY.length < 20) return null;
    return { userId: MCP_USER_ID, scopes: ['read', 'write', 'destructive'] };
  }

  // 3. 动态 key（文件存储）：用户在 UI 里生成的 key
  if (keyStore) {
    return keyStore.findPrincipal(token);
  }

  return null;
}

/** 全局 onRequest hook：保护所有 /api/* （除了 /api/auth/*）。
 *
 *  认证优先级：
 *  1. 原生设备 token（完整用户权限）
 *  2. env MCP_API_KEYS（多用户）或 MCP_API_KEY（单用户）
 *  3. 动态 key 文件（用户在 UI 里生成）
 *  4. Session cookie（浏览器登录态）
 *
 *  API key 认证只能访问 MCP 工具所需的白名单端点；
 *  禁止直接访问全量 REST API，防止 AI 绕过 MCP 的保护层
 *  （布局计算、碰撞检测、自动备份）。
 */
export function authHook(
  userRepo: UserRepository,
  keyStore: McpKeyStore | null,
  rememberTokenStore: RememberTokenRepository,
) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (req.url.startsWith('/api/auth/')) return;
    if (!req.url.startsWith('/api/')) return;

    const nativeToken = nativeRawToken(req.headers.authorization);
    const nativeClient = req.headers['x-todograph-client'] === 'native';
    if (nativeToken || nativeClient) {
      if (!nativeToken) {
        return reply.status(401).send({ ok: false, error: '请先登录' });
      }
      const native = await validateNativeUser(req.headers.authorization, userRepo, rememberTokenStore);
      if (!native.ok) {
        return reply.status(401).send({ ok: false, error: '会话已失效，请重新登录' });
      }
      req.authUserId = native.user.id;
      return;
    }

    // API key 优先：env 配置或动态 key 文件
    const mcpPrincipal = await resolveMcpPrincipal(req.headers.authorization, keyStore);
    if (mcpPrincipal) {
      const mcpVersion = req.headers[MCP_VERSION_HEADER];
      // Clients without a valid version header cannot reliably render advisory responses.
      if (!isValidMcpVersion(mcpVersion)) {
        return reply.status(426).send(mcpUpdateRequired(mcpVersion));
      }
      if (isOlderMcpVersion(mcpVersion)) {
        reply.header(MCP_LATEST_VERSION_HEADER, LATEST_MCP_VERSION);
      }
      // 白名单：API key 只能访问 MCP 工具所需的端点
      if (!isAPIKeyAllowed(req.method, req.url, mcpPrincipal.scopes)) {
        return reply.status(403).send({ ok: false, error: 'API key 不能直接访问此端点，请通过 MCP 工具操作' });
      }
      req.authUserId = mcpPrincipal.userId;
      req.apiKeyScopes = mcpPrincipal.scopes;
      return;
    }

    // 回退到 session 认证（浏览器用户，无限制）
    const session = await validateSessionUser(req, userRepo);
    if (!session.ok) {
      if (session.error !== 'unauthenticated') {
        req.session.delete();
      }
      return reply.status(401).send({
        ok: false,
        error:
          session.error === 'unauthenticated' ? '请先登录'
          : session.error === 'missing-user' ? '用户不存在，请重新登录'
        : '会话已失效，请重新登录',
      });
    }
    req.authUserId = session.user.id;
  };
}

/**
 * API key 端点白名单。
 * key: "METHOD:/api/path/pattern"  用 {id} 代表动态段。
 */
const API_KEY_ALLOWLIST = new Map<string, McpKeyScope>([
  ['GET:/api/meta', 'read'],
  ['GET:/api/pages/{id}', 'read'],
  ['GET:/api/pages/{id}/backups', 'read'],
  ['GET:/api/all-tasks', 'read'],
  ['POST:/api/pages', 'write'],
  ['PUT:/api/pages/{id}', 'write'],
  ['POST:/api/pages/{id}/backup', 'write'],
  ['POST:/api/pages/{id}/commands', 'write'],
  ['DELETE:/api/pages/{id}', 'destructive'],
  ['POST:/api/pages/{id}/restore', 'destructive'],
  ['POST:/api/pages/{id}/move-nodes', 'destructive'],
  ['POST:/api/pages/{id}/merge', 'destructive'],
]);

function isAPIKeyAllowed(method: string, url: string, scopes: McpKeyScope[]): boolean {
  // 去除 query string
  const path = url.split('?')[0]!;
  for (const [pattern, requiredScope] of API_KEY_ALLOWLIST) {
    const [pm, pp] = pattern.split(':', 2);
    if (pm !== method) continue;
    if (matchPath(pp!, path)) return scopes.includes(requiredScope);
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
