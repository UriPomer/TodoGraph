import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  api,
  apiFetch,
  getApiBase,
  resetApiSession,
  subscribeToUnauthorized,
} from '../src/api/client';
import { McpSetupDialog, mcpConfig } from '../src/features/mcp/McpSetupDialog';

describe('security API client', () => {
  const workspaceExport = {
    exportedAt: '2026-07-05T00:00:00.000Z',
    meta: {
      version: 2 as const,
      pages: [
        {
          id: 'page-1',
          title: 'Inbox',
          order: 0,
          createdAt: '2026-07-05T00:00:00.000Z',
        },
      ],
      activePageId: 'page-1',
      revision: 1,
    },
    pages: { 'page-1': { nodes: [], edges: [], version: 1 } },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the API base injected by Electron', () => {
    vi.stubGlobal('window', { __API_BASE__: 'http://127.0.0.1:43123' });

    expect(getApiBase()).toBe('http://127.0.0.1:43123');
  });

  it('uses the injected backend and published MCP package in Electron', () => {
    vi.stubGlobal('window', {
      __API_BASE__: 'http://127.0.0.1:43123', todograph: { isElectron: true },
      location: { origin: 'http://127.0.0.1:49876' },
    });
    const config = JSON.parse(mcpConfig('tdg-secret')).mcpServers.todograph;
    expect(config).toMatchObject({
      command: 'npx', args: ['-y', '@todograph/mcp@latest'],
      env: { TODOGRAPH_API_BASE: 'http://127.0.0.1:43123', TODOGRAPH_API_KEY: 'tdg-secret' },
    });
  });

  it('uses the published MCP package from local web development too', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5174' } });
    const config = JSON.parse(mcpConfig('tdg-secret')).mcpServers.todograph;
    expect(config).toMatchObject({
      command: 'npx', args: ['-y', '@todograph/mcp@latest'],
      env: { TODOGRAPH_API_BASE: 'http://localhost:5173' },
    });
  });

  it('renders destructive MCP permission as an aligned application switch', () => {
    const html = renderToStaticMarkup(createElement(McpSetupDialog, { open: true, embedded: true }));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('inline-flex h-6 w-11 shrink-0 items-center');
    expect(html).toContain('h-5 w-5 rounded-full');
    expect(html).not.toContain('type="checkbox"');
  });

  it('includes credentials when Electron injects a cross-origin API base', async () => {
    vi.stubGlobal('window', { __API_BASE__: 'http://127.0.0.1:43123' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));

    await apiFetch('http://127.0.0.1:43123/api/auth/me');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:43123/api/auth/me', {
      credentials: 'include',
    });
  });

  it('reports protected API 401 responses but ignores expected auth failures', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToUnauthorized(listener);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));

    await apiFetch('/api/meta');
    expect(listener).toHaveBeenCalledOnce();

    await apiFetch('/api/auth/login');
    expect(listener).toHaveBeenCalledOnce();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 401, headers: { 'X-Session-Expired': '1' },
    }));
    await apiFetch('/api/auth/change-password');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('restores an expired session once and retries concurrent protected requests', async () => {
    const attempts = new Map<string, number>();
    let restoreCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      if (path === '/api/auth/me') {
        restoreCalls++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      return new Response(null, { status: attempt === 1 ? 401 : 200 });
    });

    const [meta, page] = await Promise.all([
      apiFetch('/api/meta'),
      apiFetch('/api/pages/page-1'),
    ]);

    expect(meta.status).toBe(200);
    expect(page.status).toBe(200);
    expect(restoreCalls).toBe(1);
  });

  it('discards responses started under a previous user session', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );

    const request = apiFetch('/api/meta');
    resetApiSession();
    resolveResponse(new Response('{}'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not reuse an in-flight restore after the user session changes', async () => {
    let resolveRestore!: (response: Response) => void;
    const listener = vi.fn();
    const unsubscribe = subscribeToUnauthorized(listener);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) === '/api/auth/me') {
        return new Promise<Response>((resolve) => {
          resolveRestore = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 401 }));
    });

    const request = apiFetch('/api/meta');
    await vi.waitFor(() => expect(resolveRestore).toBeTypeOf('function'));
    resetApiSession();
    resolveRestore(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('posts password change payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await api.changePassword('old-password', 'new-password-123');

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password-123' }),
    });
  });

  it('surfaces the password validation message without raw HTTP or JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: '密码必须同时包含字母和数字' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.changePassword('old-password', '12345678')).rejects.toThrow(
      '密码必须同时包含字母和数字',
    );
  });

  it('lists page backups', async () => {
    const backups = [{ name: 'backup-1.json', createdAt: '2026-07-05T00:00:00.000Z', size: 123 }];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ backups }), { status: 200 }),
    );

    await expect(api.listBackups('page/a')).resolves.toEqual(backups);

    expect(fetchMock).toHaveBeenCalledWith('/api/pages/page%2Fa/backups');
  });

  it('posts selected backup restore payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { nodes: [], edges: [], version: 3 } }), { status: 200 }),
    );

    await api.restoreBackup('page/a', 'backup-1.json');

    expect(fetchMock).toHaveBeenCalledWith('/api/pages/page%2Fa/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupName: 'backup-1.json' }),
    });
  });

  it('reports metadata conflicts when restoring a trashed page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ serverRevision: 7 }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.restoreTrashedPage('deleted.json', 6)).rejects.toMatchObject({
      conflict: true,
      serverRevision: 7,
    });
  });

  it('loads workspace JSON export', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(workspaceExport), { status: 200 }),
    );

    await expect(api.exportWorkspaceJson()).resolves.toEqual(workspaceExport);

    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/export.json');
  });

  it('posts workspace JSON import payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, meta: workspaceExport.meta }), { status: 200 }),
    );

    await expect(api.importWorkspaceJson(workspaceExport)).resolves.toEqual(workspaceExport.meta);

    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workspaceExport),
    });
  });
});
