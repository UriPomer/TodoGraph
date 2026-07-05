import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildApp } from '../src/app.js';

function makeSecret(): string {
  return 'a'.repeat(32);
}

describe('auth routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = path.join(os.tmpdir(), `todograph-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated /api/meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(res.statusCode).toBe(401);
  });

  it('registers first user without registration key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, username: 'alice' });
  });

  it('rejects second registration without key', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'secret123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('registers with correct registration key', async () => {
    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: 'invite42',
      sessionSecret: makeSecret(),
      logger: false,
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'secret123', registrationKey: 'invite42' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, username: 'bob' });
  });

  it('login with correct credentials', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    // Close and reopen to lose the registration session
    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      logger: false,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, username: 'alice' });
  });

  it('login fails with wrong password', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'wrongpass' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: '用户名或密码错误' });
  });

  it('does not reveal whether username exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nonexistent', password: 'anything' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: '用户名或密码错误' });
  });

  it('/api/auth/me returns user info when logged in', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = regRes.cookies as unknown as { name: string; value: string }[];
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: Object.fromEntries(cookies.map((c) => [c.name, c.value])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, username: 'alice' });
  });

  it('/api/auth/logout clears session', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = regRes.cookies as unknown as { name: string; value: string }[];
    const cookieObj = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    const logoutRes = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: cookieObj });
    // Use the updated session cookie from the logout response (the old one was cleared server-side)
    const logoutCookies = logoutRes.cookies as unknown as { name: string; value: string }[];
    const newCookieObj = Object.fromEntries(logoutCookies.map((c) => [c.name, c.value]));
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: newCookieObj });
    expect(res.json()).toEqual({ ok: false });
  });

  it('validates username length on register', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'a', password: 'secret123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: '用户名长度 2-32 字符' });
  });

  it('validates minimum password length on register', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: '12345' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: '密码至少 8 位' });
  });

  it('sets secure session cookie when cookieSecure is true', async () => {
    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      cookieSecure: true,
      logger: false,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });

    expect(res.cookies.some((cookie) => cookie.secure === true)).toBe(true);
  });

  it('requires stronger passwords on register', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: '1234567' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: '密码至少 8 位' });
  });

  it('changes password when current password is correct', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = Object.fromEntries(
      (regRes.cookies as unknown as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );

    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      cookies,
      payload: { currentPassword: 'secret123', newPassword: 'newsecret123' },
    });
    expect(change.statusCode).toBe(200);

    const loginOld = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    });
    expect(loginOld.statusCode).toBe(401);

    const loginNew = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'newsecret123' },
    });
    expect(loginNew.statusCode).toBe(200);
  });

  it('invalidates old session cookies after password change and rotates the active session', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const originalCookies = Object.fromEntries(
      (regRes.cookies as unknown as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );

    const changeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      cookies: originalCookies,
      payload: { currentPassword: 'secret123', newPassword: 'newsecret123' },
    });
    expect(changeRes.statusCode).toBe(200);

    const rotatedCookies = Object.fromEntries(
      (changeRes.cookies as unknown as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );
    expect(Object.keys(rotatedCookies).length).toBeGreaterThan(0);
    expect(rotatedCookies).not.toEqual(originalCookies);

    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      logger: false,
    });
    await app.ready();

    const staleSession = await app.inject({
      method: 'GET',
      url: '/api/mcp/keys',
      cookies: originalCookies,
    });
    expect(staleSession.statusCode).toBe(401);
    expect(staleSession.json()).toEqual({ ok: false, error: '会话已失效，请重新登录' });

    const rotatedSession = await app.inject({
      method: 'GET',
      url: '/api/mcp/keys',
      cookies: rotatedCookies,
    });
    expect(rotatedSession.statusCode).toBe(200);
  });

  it('rejects stale meta revision when two clients create pages concurrently', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = regRes.cookies as unknown as { name: string; value: string }[];
    const cookieObj = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

    const metaRes = await app.inject({ method: 'GET', url: '/api/meta', cookies: cookieObj });
    expect(metaRes.statusCode).toBe(200);
    const meta = metaRes.json() as { revision: number };

    const first = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookieObj,
      payload: { title: '第一页', expectedRevision: meta.revision },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/pages',
      cookies: cookieObj,
      payload: { title: '第二页', expectedRevision: meta.revision },
    });
    expect(second.statusCode).toBe(409);
  });

  it('returns 400 for invalid backupName on restore route', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = regRes.cookies as unknown as { name: string; value: string }[];
    const cookieObj = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

    const metaRes = await app.inject({ method: 'GET', url: '/api/meta', cookies: cookieObj });
    const meta = metaRes.json() as { activePageId: string };

    const res = await app.inject({
      method: 'POST',
      url: `/api/pages/${meta.activePageId}/restore`,
      cookies: cookieObj,
      payload: { backupName: '../bad.json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: 'invalid payload' });
  });

  it('does not turn MCP bearer auth into a reusable browser session', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = regRes.cookies as unknown as { name: string; value: string }[];
    const cookieObj = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

    const keyRes = await app.inject({
      method: 'POST',
      url: '/api/mcp/keys',
      cookies: cookieObj,
      payload: { label: 'codex' },
    });
    expect(keyRes.statusCode).toBe(200);
    const apiKey = (keyRes.json() as { key: string }).key;

    const bearerMeta = await app.inject({
      method: 'GET',
      url: '/api/meta',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(bearerMeta.statusCode).toBe(200);
    expect(bearerMeta.cookies).toHaveLength(0);

    const bearerCookies = Object.fromEntries(
      (bearerMeta.cookies as unknown as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );
    const browserOnlyRoute = await app.inject({
      method: 'GET',
      url: '/api/mcp/keys',
      cookies: bearerCookies,
    });
    expect(browserOnlyRoute.statusCode).toBe(401);

    const bearerDisallowed = await app.inject({
      method: 'GET',
      url: '/api/mcp/keys',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(bearerDisallowed.statusCode).toBe(403);
  });

  it('returns 400 for workspace imports whose activePageId is missing from meta.pages', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = regRes.cookies as unknown as { name: string; value: string }[];
    const cookieObj = Object.fromEntries(cookies.map((c) => [c.name, c.value]));

    const metaRes = await app.inject({ method: 'GET', url: '/api/meta', cookies: cookieObj });
    expect(metaRes.statusCode).toBe(200);
    const meta = metaRes.json() as { activePageId: string; pages: Array<{ id: string }> };
    const pageId = meta.pages[0]!.id;

    const pageRes = await app.inject({ method: 'GET', url: `/api/pages/${pageId}`, cookies: cookieObj });
    expect(pageRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/import',
      cookies: cookieObj,
      payload: {
        exportedAt: new Date().toISOString(),
        meta: { ...meta, activePageId: 'missing-page' },
        pages: {
          [pageId]: pageRes.json(),
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      ok: false,
      error: 'activePageId must reference a page in meta.pages',
    });
  });
});
