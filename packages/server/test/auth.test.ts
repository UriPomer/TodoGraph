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

  it('validates password length on register', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: '12345' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: '密码至少 6 位' });
  });
});
