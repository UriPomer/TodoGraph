import {
  AllTasksResponseSchema,
  MetaSchema,
  MoveNodesResponseSchema,
  PageDataSchema,
  PageInfoSchema,
  type AllTasksResponse,
  type Meta,
  type MoveNodesResponse,
  type PageData,
  type PageInfo,
  type WorkspaceSettings,
} from '@todograph/shared';

/**
 * 取 API base URL。
 * - Electron：preload 通过 contextBridge 注入 window.__API_BASE__
 * - Web dev：Vite 代理 /api，返回空字符串即可
 * - Web prod：前端和后端同源，同样返回空字符串
 */
function getApiBase(): string {
  // @ts-expect-error 运行时注入
  const injected: string | undefined = typeof window !== 'undefined' ? window.__API_BASE__ : undefined;
  return injected ?? '';
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

async function jsonOk(res: Response): Promise<void> {
  const body = await json<{ ok?: boolean; error?: string }>(res);
  if (body.ok === false) throw new Error(body.error ?? 'request failed');
}

function buildConflictError(
  message: string,
  extra: { serverVersion?: number; serverRevision?: number; pageId?: string } = {},
): Error & { conflict: boolean; serverVersion?: number; serverRevision?: number; pageId?: string } {
  const err = new Error(message) as Error & {
    conflict: boolean;
    serverVersion?: number;
    serverRevision?: number;
    pageId?: string;
  };
  err.conflict = true;
  err.serverVersion = extra.serverVersion;
  err.serverRevision = extra.serverRevision;
  err.pageId = extra.pageId;
  return err;
}

export const api = {
  // ---- meta ----
  async loadMeta(): Promise<Meta> {
    const res = await fetch(`${getApiBase()}/api/meta`);
    const data = await json<unknown>(res);
    return MetaSchema.parse(data);
  },

  async updateSettings(settings: WorkspaceSettings, expectedRevision?: number): Promise<Meta> {
    const res = await fetch(`${getApiBase()}/api/meta/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, expectedRevision }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRevision?: number };
      throw buildConflictError('版本冲突：工作区已被其他设备修改', {
        serverRevision: body.serverRevision,
      });
    }
    const body = await json<{ meta?: unknown }>(res);
    return MetaSchema.parse(body.meta);
  },

  // ---- pages ----
  async loadPage(pageId: string): Promise<PageData> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`);
    const data = await json<unknown>(res);
    return PageDataSchema.parse(data);
  },

  async savePage(
    pageId: string,
    data: PageData,
    expectedVersion?: number,
  ): Promise<{ version: number }> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, expectedVersion }),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { serverVersion?: number };
       throw buildConflictError('版本冲突：页面已被其他设备修改', {
         serverVersion: body.serverVersion,
         pageId,
       });
     }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    const body = await res.json() as { ok?: boolean; version?: number };
    if (body.ok === false) throw new Error('save failed');
    return { version: body.version ?? 0 };
  },

  async createPage(title: string, expectedRevision?: number): Promise<{ page: PageInfo; meta: Meta }> {
    const res = await fetch(`${getApiBase()}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, expectedRevision }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRevision?: number };
      throw buildConflictError('版本冲突：工作区已被其他设备修改', {
        serverRevision: body.serverRevision,
      });
    }
    const data = await json<unknown>(res);
    const parsed = data as { page?: unknown; meta?: unknown };
    return {
      page: PageInfoSchema.parse(parsed.page),
      meta: MetaSchema.parse(parsed.meta),
    };
  },

  async deletePage(pageId: string, expectedRevision?: number): Promise<Meta> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRevision?: number };
      throw buildConflictError('版本冲突：工作区已被其他设备修改', {
        serverRevision: body.serverRevision,
      });
    }
    const body = await json<{ meta?: unknown }>(res);
    return MetaSchema.parse(body.meta);
  },

  async renamePage(pageId: string, title: string, expectedRevision?: number): Promise<Meta | null> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, expectedRevision }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRevision?: number };
      throw buildConflictError('版本冲突：工作区已被其他设备修改', {
        serverRevision: body.serverRevision,
      });
    }
    const body = await json<{ meta?: unknown }>(res);
    return body.meta ? MetaSchema.parse(body.meta) : null;
  },

  async setActivePage(pageId: string, expectedRevision?: number): Promise<Meta | null> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activate: true, expectedRevision }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRevision?: number };
      throw buildConflictError('版本冲突：工作区已被其他设备修改', {
        serverRevision: body.serverRevision,
      });
    }
    const body = await json<{ meta?: unknown }>(res);
    return body.meta ? MetaSchema.parse(body.meta) : null;
  },

  async reorderPages(ids: string[], expectedRevision?: number): Promise<Meta> {
    const res = await fetch(`${getApiBase()}/api/pages/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, expectedRevision }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { serverRevision?: number };
      throw buildConflictError('版本冲突：工作区已被其他设备修改', {
        serverRevision: body.serverRevision,
      });
    }
    const body = await json<{ meta?: unknown }>(res);
    return MetaSchema.parse(body.meta);
  },

  async moveNodes(
    sourcePageId: string,
    targetPageId: string,
    nodeIds: string[],
    expectedSourceVersion?: number,
    expectedTargetVersion?: number,
  ): Promise<MoveNodesResponse> {
    const res = await fetch(
      `${getApiBase()}/api/pages/${encodeURIComponent(sourcePageId)}/move-nodes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ targetPageId, nodeIds, expectedSourceVersion, expectedTargetVersion }),
       },
     );
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        pageId?: string;
        serverVersion?: number;
      };
      throw buildConflictError('版本冲突：页面已被其他设备修改', {
        pageId: body.pageId,
        serverVersion: body.serverVersion,
      });
    }
    const data = await json<unknown>(res);
    return MoveNodesResponseSchema.parse(data);
  },

  async createBackup(pageId: string): Promise<void> {
    const res = await fetch(
      `${getApiBase()}/api/pages/${encodeURIComponent(pageId)}/backup`,
      { method: 'POST' },
    );
    await jsonOk(res);
  },

  async loadAllTasks(): Promise<AllTasksResponse> {
    const res = await fetch(`${getApiBase()}/api/all-tasks`);
    const data = await json<unknown>(res);
    return AllTasksResponseSchema.parse(data);
  },

  async exportMarkdown(): Promise<string> {
    const res = await fetch(`${getApiBase()}/api/workspace/markdown`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
};
