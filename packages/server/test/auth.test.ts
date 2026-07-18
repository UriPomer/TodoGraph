import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("script-src-attr 'none'");
  });

  it('allows credentialed API requests only from the configured Electron renderer origin', async () => {
    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      corsOrigin: 'http://localhost:5174',
      logger: false,
    });

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/me',
      headers: {
        origin: 'http://localhost:5174',
        'access-control-request-method': 'GET',
      },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5174');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: 'http://localhost:5174' },
      payload: { username: 'alice', password: 'secret123' },
    });
    expect(registration.statusCode).toBe(200);
    expect(registration.headers['access-control-allow-origin']).toBe('http://localhost:5174');
    const cookies = Object.fromEntries(
      (registration.cookies as unknown as { name: string; value: string }[]).map((cookie) => [
        cookie.name,
        cookie.value,
      ]),
    );

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { origin: 'http://localhost:5174' },
      cookies,
    });
    expect(me.json()).toMatchObject({ ok: true, username: 'alice' });

    const meta = await app.inject({
      method: 'GET',
      url: '/api/meta',
      headers: { origin: 'http://localhost:5174' },
      cookies,
    });
    expect(meta.statusCode).toBe(200);

    const rejected = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/me',
      headers: {
        origin: 'http://evil.test',
        'access-control-request-method': 'GET',
      },
    });
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
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

  it('allows only one concurrent first registration without a key', async () => {
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'alice', password: 'secret123' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'bob', password: 'secret123' },
      }),
    ]);

    expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 403]);
    const users = JSON.parse(
      await fs.readFile(path.join(dataDir, 'users', 'users.json'), 'utf-8'),
    ) as unknown[];
    expect(users).toHaveLength(1);
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

  it('rejects oversized login credentials before password hashing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'x'.repeat(201) },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: '用户名或密码错误' });
  });

  it('rejects malformed authentication fields instead of throwing', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: {}, password: 'secret123' },
    });
    expect(login.statusCode).toBe(400);

    const register = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123', registrationKey: {} },
    });
    expect(register.statusCode).toBe(400);
  });

  it('rate limits repeated login attempts', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'missing', password: 'wrong123' },
      });
      expect(res.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'missing', password: 'wrong123' },
    });
    expect(blocked.statusCode).toBe(429);
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

  it('enforces the thirty-day absolute session lifetime without a device credential', async () => {
    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123', remember: false },
    });
    const cookies = Object.fromEntries(registration.cookies.map((cookie) => [cookie.name, cookie.value]));

    vi.useFakeTimers();
    let expired;
    try {
      vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
      expired = await app.inject({ method: 'GET', url: '/api/auth/me', cookies });
    } finally {
      vi.useRealTimers();
    }

    expect(expired.json()).toEqual({ ok: false });
  });

  it('uses an HttpOnly one-year device credential only when requested', async () => {
    const remembered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123', remember: true },
    });
    const rememberCookie = remembered.cookies.find((cookie) => cookie.name === 'todograph_remember');
    expect(remembered.headers['cache-control']).toBe('no-store');
    expect(rememberCookie).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: 365 * 24 * 60 * 60,
      path: '/api',
    });

    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      logger: false,
    });
    await app.ready();
    const notRemembered = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123', remember: false },
    });
    expect(notRemembered.cookies.find((cookie) => cookie.name === 'todograph_remember')?.value).toBe('');
  });

  it('allows concurrent rotation, then revokes the token family on delayed replay', async () => {
    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123', remember: true },
    });
    const original = registration.cookies.find((cookie) => cookie.name === 'todograph_remember')!;

    const [firstRestore, secondRestore] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { todograph_remember: original.value },
      }),
      app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { todograph_remember: original.value },
      }),
    ]);
    expect(firstRestore.json()).toMatchObject({ ok: true, username: 'alice' });
    expect(secondRestore.json()).toMatchObject({ ok: true, username: 'alice' });
    const firstRotated = firstRestore.cookies.find((cookie) => cookie.name === 'todograph_remember')!;
    const secondRotated = secondRestore.cookies.find((cookie) => cookie.name === 'todograph_remember')!;
    expect(firstRotated.value).not.toBe(original.value);
    expect(secondRotated.value).not.toBe(firstRotated.value);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 6_000);
      const replay = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { todograph_remember: original.value },
      });
      expect(replay.json()).toEqual({ ok: false });
    } finally {
      vi.useRealTimers();
    }

    const revokedCurrentToken = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { todograph_remember: secondRotated.value },
    });
    expect(revokedCurrentToken.json()).toEqual({ ok: false });
  });

  it('revokes the device credential server-side on logout', async () => {
    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123', remember: true },
    });
    const cookies = Object.fromEntries(registration.cookies.map((cookie) => [cookie.name, cookie.value]));
    const rememberToken = cookies.todograph_remember!;

    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies });
    const restore = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { todograph_remember: rememberToken },
    });
    expect(restore.json()).toEqual({ ok: false });
  });

  it('revokes other devices when the password changes', async () => {
    const firstDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123', remember: true },
    });
    const firstCookies = Object.fromEntries(firstDevice.cookies.map((cookie) => [cookie.name, cookie.value]));
    const secondDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123', remember: true },
    });
    const secondRememberToken = secondDevice.cookies.find(
      (cookie) => cookie.name === 'todograph_remember',
    )!.value;

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      cookies: firstCookies,
      payload: { currentPassword: 'secret123', newPassword: 'changed456' },
    });
    expect(changed.statusCode).toBe(200);

    const staleDevice = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { todograph_remember: secondRememberToken },
    });
    expect(staleDevice.json()).toEqual({ ok: false });
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

  it('requires letters and numbers in passwords', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'abcdefgh' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: '密码必须同时包含字母和数字' });
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
      payload: {
        currentPassword: 'secret123',
        newPassword: 'newsecret123',
      },
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

  it('invalidates existing session cookies after password change', async () => {
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
      payload: {
        currentPassword: 'secret123',
        newPassword: 'newsecret123',
      },
    });
    expect(changeRes.statusCode).toBe(200);
    const refreshedCookies = Object.fromEntries(
      (changeRes.cookies as unknown as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );

    const staleChange = await app.inject({
      method: 'POST', url: '/api/auth/change-password', cookies: originalCookies,
      payload: { currentPassword: 'newsecret123', newPassword: 'thirdsecret123' },
    });
    expect(staleChange.statusCode).toBe(401);
    expect(staleChange.headers['x-session-expired']).toBe('1');

    await app.close();
    app = await buildApp({
      dataDir,
      registrationKey: '',
      sessionSecret: makeSecret(),
      logger: false,
    });
    await app.ready();

    const existingSession = await app.inject({
      method: 'GET',
      url: '/api/mcp/keys',
      cookies: originalCookies,
    });
    expect(existingSession.statusCode).toBe(401);

    const refreshedSession = await app.inject({
      method: 'GET',
      url: '/api/mcp/keys',
      cookies: refreshedCookies,
    });
    expect(refreshedSession.statusCode).toBe(200);
  });

  it('rejects reusing the current password', async () => {
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
      payload: {
        currentPassword: 'secret123',
        newPassword: 'secret123',
      },
    });

    expect(change.statusCode).toBe(400);
    expect(change.json()).toEqual({ ok: false, error: '新密码不能与当前密码相同' });
  });

  it('rejects an oversized current password before hashing it', async () => {
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
      payload: { currentPassword: 'x'.repeat(201), newPassword: 'newsecret123' },
    });

    expect(change.statusCode).toBe(401);
    expect(change.json()).toEqual({ ok: false, error: '当前密码错误' });
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
    expect(metaRes.headers['cache-control']).toBe('no-store');
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

  it('rejects invalid task hierarchies through the page API', async () => {
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    });
    const cookies = Object.fromEntries(
      (regRes.cookies as unknown as { name: string; value: string }[]).map((cookie) => [
        cookie.name,
        cookie.value,
      ]),
    );
    const meta = await app.inject({ method: 'GET', url: '/api/meta', cookies });
    const pageId = meta.json<{ activePageId: string }>().activePageId;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      cookies,
      payload: {
        nodes: [{ id: 'a', title: 'a', status: 'todo', parentId: 'b' }],
        edges: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid task hierarchy',
      reason: 'missing-parent',
      taskId: 'a',
    });

    const oversizedTitle = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      cookies,
      payload: {
        nodes: [{ id: 'long-title', title: 'x'.repeat(201), status: 'todo' }],
        edges: [],
      },
    });
    expect(oversizedTitle.statusCode).toBe(400);
    expect(oversizedTitle.json()).toMatchObject({
      error: 'task title too long',
      taskId: 'long-title',
      maxLength: 200,
    });

    const overlapping = await app.inject({
      method: 'PUT',
      url: `/api/pages/${pageId}`,
      cookies,
      payload: {
        nodes: [
          { id: 'overlap-a', title: 'a', status: 'todo', x: 0, y: 0, width: 180 },
          { id: 'overlap-b', title: 'b', status: 'todo', x: 0, y: 0, width: 180 },
        ],
        edges: [],
      },
    });
    expect(overlapping.statusCode).toBe(422);
    expect(overlapping.json()).toMatchObject({
      ok: false,
      code: 'node-overlap',
      conflicts: [{ firstId: 'overlap-a', secondId: 'overlap-b' }],
    });

    for (const edge of [
      { from: 'a', to: 'a' },
      { from: 'a', to: 'missing' },
    ]) {
      const invalidEdge = await app.inject({
        method: 'PUT',
        url: `/api/pages/${pageId}`,
        cookies,
        payload: { nodes: [{ id: 'a', title: 'a', status: 'todo' }], edges: [edge] },
      });
      expect(invalidEdge.statusCode).toBe(400);
      expect(invalidEdge.json()).toMatchObject({ error: 'invalid dependency' });
    }
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

  it('accepts valid workspace imports larger than Fastify default body limit', async () => {
    const regRes = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { username: 'large-import', password: 'secret123' },
    });
    const cookies = Object.fromEntries(
      (regRes.cookies as unknown as { name: string; value: string }[]).map((c) => [c.name, c.value]),
    );
    const meta = (await app.inject({ method: 'GET', url: '/api/meta', cookies })).json() as {
      activePageId: string; pages: Array<{ id: string }>;
    };
    const nodes = Array.from({ length: 300 }, (_, i) => ({
      id: `large-${i}`, title: `Task ${i}`, status: 'todo', description: 'x'.repeat(4000),
    }));
    const res = await app.inject({
      method: 'POST', url: '/api/workspace/import', cookies,
      payload: { exportedAt: new Date().toISOString(), meta, pages: { [meta.activePageId]: { nodes, edges: [] } } },
    });

    expect(res.statusCode).toBe(200);
  });
});
