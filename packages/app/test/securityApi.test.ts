import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';

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
