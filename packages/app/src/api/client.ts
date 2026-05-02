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

export const api = {
  // ---- meta ----
  async loadMeta(): Promise<Meta> {
    const res = await fetch(`${getApiBase()}/api/meta`);
    const data = await json<unknown>(res);
    return MetaSchema.parse(data);
  },

  async updateSettings(settings: WorkspaceSettings): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/meta/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    await jsonOk(res);
  },

  // ---- pages ----
  async loadPage(pageId: string): Promise<PageData> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`);
    const data = await json<unknown>(res);
    return PageDataSchema.parse(data);
  },

  async savePage(pageId: string, data: PageData): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    await jsonOk(res);
  },

  async createPage(title: string): Promise<PageInfo> {
    const res = await fetch(`${getApiBase()}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const data = await json<unknown>(res);
    return PageInfoSchema.parse(data);
  },

  async deletePage(pageId: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'DELETE',
    });
    await jsonOk(res);
  },

  async renamePage(pageId: string, title: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    await jsonOk(res);
  },

  async setActivePage(pageId: string): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activate: true }),
    });
    await jsonOk(res);
  },

  async reorderPages(ids: string[]): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/pages/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    await jsonOk(res);
  },

  async moveNodes(
    sourcePageId: string,
    targetPageId: string,
    nodeIds: string[],
  ): Promise<MoveNodesResponse> {
    const res = await fetch(
      `${getApiBase()}/api/pages/${encodeURIComponent(sourcePageId)}/move-nodes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPageId, nodeIds }),
      },
    );
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
};
