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
} from '@todograph/shared';
import {
  clearNativeSessionToken,
  getNativeSessionToken,
  isNativeRuntime,
  isNativeSessionPersisted,
  replaceNativeSessionToken,
} from '@/platform/nativeSession';
export interface McpKeyInfo {
  id: string;
  prefix: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  scopes: McpKeyScope[];
}
export type McpKeyScope = 'read' | 'write' | 'destructive';

export interface GeneratedMcpKey extends McpKeyInfo {
  key: string;
}

export interface BackupInfo {
  name: string;
  createdAt: string;
  size: number;
}

export interface TrashedPageInfo {
  name: string;
  deletedAt: string;
  page: PageInfo;
  size: number;
}

export interface WorkspaceExport {
  exportedAt: string;
  meta: Meta;
  pages: Record<string, PageData>;
}

/**
 * 取 API base URL。
 * - Electron：preload 通过 contextBridge 注入 window.__API_BASE__
 * - Web dev：Vite 代理 /api，返回空字符串即可
 * - Web prod：前端和后端同源，同样返回空字符串
 */
export function getApiBase(): string {
  // @ts-expect-error 运行时注入
  const injected: string | undefined = typeof window !== 'undefined' ? window.__API_BASE__ : undefined;
  const configured = import.meta.env.VITE_API_BASE as string | undefined;
  return injected ?? configured?.replace(/\/$/, '') ?? '';
}

const unauthorizedListeners = new Set<() => void>();
let apiSessionGeneration = 0;
let restoreSessionAttempt: { generation: number; promise: Promise<boolean> } | null = null;
export function subscribeToUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export function resetApiSession(): void {
  apiSessionGeneration += 1;
}

export function getApiSessionGeneration(): number {
  return apiSessionGeneration;
}

function requestPath(input: RequestInfo | URL): string {
  const value =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(value, 'http://localhost').pathname;
  } catch {
    return value;
  }
}

async function fetchWithCredentials(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (isNativeRuntime()) {
    const apiBase = getApiBase();
    if (!apiBase.startsWith('https://')) throw new Error('原生应用必须配置 HTTPS API 地址');
    const inputValue =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(inputValue, `${apiBase}/`);
    if (target.origin !== new URL(apiBase).origin || !target.pathname.startsWith('/api/')) {
      throw new Error('原生 API 请求目标不受信任');
    }
    const token = await getNativeSessionToken();
    const headers = new Headers(init?.headers);
    headers.set('X-TodoGraph-Client', 'native');
    if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
    return globalThis.fetch(input, { ...init, headers });
  }
  if (!getApiBase()) {
    return init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
  }
  return globalThis.fetch(input, { ...init, credentials: 'include' });
}

async function restoreBrowserSession(generation: number): Promise<boolean> {
  if (!restoreSessionAttempt || restoreSessionAttempt.generation !== generation) {
    const attempt = {
      generation,
      promise: (async () => {
        try {
          const response = await fetchWithCredentials(`${getApiBase()}/api/auth/me`);
          if (generation !== apiSessionGeneration || !response.ok) return false;
          const body = (await response.json()) as { ok?: boolean };
          return body.ok === true;
        } catch {
          return false;
        }
      })(),
    };
    restoreSessionAttempt = attempt;
    void attempt.promise.finally(() => {
      if (restoreSessionAttempt === attempt) restoreSessionAttempt = null;
    });
  }
  return restoreSessionAttempt.promise;
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const generation = apiSessionGeneration;
  const retryInput = input instanceof Request ? input.clone() : input;
  let response = await fetchWithCredentials(input, init);
  if (generation !== apiSessionGeneration) {
    throw Object.assign(new Error('API session changed'), { name: 'AbortError' });
  }

  const path = requestPath(input);
  const nativeSessionExpired =
    path === '/api/auth/native/me'
    || !path.startsWith('/api/auth/')
    || response.headers.get('x-session-expired') === '1';
  if (response.status === 401 && isNativeRuntime() && nativeSessionExpired) {
    await clearNativeSessionToken();
    notifyUnauthorized();
  } else if (response.status === 401 && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
    const restored = await restoreBrowserSession(generation);
    if (generation !== apiSessionGeneration) {
      throw Object.assign(new Error('API session changed'), { name: 'AbortError' });
    }
    if (restored) {
      response = await fetchWithCredentials(retryInput, init);
      if (generation !== apiSessionGeneration) {
        throw Object.assign(new Error('API session changed'), { name: 'AbortError' });
      }
    }
    if (response.status === 401) notifyUnauthorized();
  } else if (
    response.status === 401 &&
    path.startsWith('/api/auth/') &&
    response.headers.get('x-session-expired') === '1'
  ) {
    notifyUnauthorized();
  }
  return response;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text || res.statusText || `HTTP ${res.status}`;
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === 'string' && body.error) message = body.error;
      } catch { /* keep plain-text response */ }
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

interface RequestOptions<T> {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  conflict?: 'page' | 'meta';
  pageId?: string;
  schema?: { parse: (data: unknown) => T };
  failureMessage?: string;
}

/** Transport owns HTTP failures and conflict metadata; schemas own domain validation. */
async function request<T = unknown>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, signal, conflict, pageId, schema } = options;
  const init = method === 'GET' && body === undefined
    ? (signal ? { signal } : undefined)
    : {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      };
  const response = await apiFetch(`${getApiBase()}${path}`, init);
  if (response.status === 409 && conflict) {
    const detail = await response.json().catch(() => ({})) as {
      pageId?: string; serverVersion?: number; serverRevision?: number;
    };
    throw Object.assign(new Error(conflict === 'page'
      ? '版本冲突：页面已被其他设备修改' : '版本冲突：工作区已被其他设备修改'), {
      conflict: true,
      serverVersion: detail.serverVersion,
      serverRevision: detail.serverRevision,
      pageId: detail.pageId ?? pageId,
    });
  }
  const result = await json<T>(response);
  const acknowledgement = result as { ok?: boolean; error?: string } | null;
  if (acknowledgement?.ok === false) {
    throw new Error(acknowledgement.error ?? options.failureMessage ?? 'request failed');
  }
  return schema ? schema.parse(result) : result;
}

const pagePath = (id: string) => `/api/pages/${encodeURIComponent(id)}`;
async function mutateMeta(path: string, method: string, body: unknown): Promise<Meta> {
  const result = await request<{ meta?: unknown }>(path, { method, body, conflict: 'meta' });
  return MetaSchema.parse(result.meta);
}

export const api = {
  loadMeta: (): Promise<Meta> => request('/api/meta', { schema: MetaSchema }),
  loadPage: (pageId: string): Promise<PageData> => request(pagePath(pageId), { schema: PageDataSchema }),
  loadAllTasks: (): Promise<AllTasksResponse> => request('/api/all-tasks', { schema: AllTasksResponseSchema }),

  async savePage(pageId: string, data: PageData, expectedVersion?: number): Promise<{ version: number }> {
    const result = await request<{ version?: number }>(pagePath(pageId), {
      method: 'PUT', body: { ...data, expectedVersion }, conflict: 'page', pageId, failureMessage: 'save failed',
    });
    return { version: result.version ?? 0 };
  },
  async createPage(title: string, expectedRevision?: number): Promise<{ page: PageInfo; meta: Meta }> {
    const result = await request<{ page?: unknown; meta?: unknown }>('/api/pages', {
      method: 'POST', body: { title, expectedRevision }, conflict: 'meta',
    });
    return { page: PageInfoSchema.parse(result.page), meta: MetaSchema.parse(result.meta) };
  },
  deletePage: (pageId: string, expectedRevision?: number): Promise<Meta> =>
    mutateMeta(pagePath(pageId), 'DELETE', { expectedRevision }),
  renamePage: (pageId: string, title: string, expectedRevision?: number): Promise<Meta> =>
    mutateMeta(pagePath(pageId), 'PATCH', { title, expectedRevision }),
  setActivePage: (pageId: string, expectedRevision?: number): Promise<Meta> =>
    mutateMeta(pagePath(pageId), 'PATCH', { activate: true, expectedRevision }),
  reorderPages: (ids: string[], expectedRevision?: number): Promise<Meta> =>
    mutateMeta('/api/pages/reorder', 'POST', { ids, expectedRevision }),

  moveNodes(sourcePageId: string, targetPageId: string, nodeIds: string[],
    expectedSourceVersion?: number, expectedTargetVersion?: number): Promise<MoveNodesResponse> {
    return request(`${pagePath(sourcePageId)}/move-nodes`, {
      method: 'POST', body: { targetPageId, nodeIds, expectedSourceVersion, expectedTargetVersion },
      conflict: 'page', pageId: sourcePageId, schema: MoveNodesResponseSchema,
    });
  },
  async createBackup(pageId: string): Promise<void> {
    await request(`${pagePath(pageId)}/backup`, { method: 'POST' });
  },
  async listBackups(pageId: string, signal?: AbortSignal): Promise<BackupInfo[]> {
    return (await request<{ backups: BackupInfo[] }>(`${pagePath(pageId)}/backups`, { signal })).backups;
  },
  async restoreBackup(pageId: string, backupName?: string, expectedVersion?: number): Promise<PageData> {
    const result = await request<{ data?: unknown }>(`${pagePath(pageId)}/restore`, {
      method: 'POST', body: { ...(backupName ? { backupName } : {}), expectedVersion }, conflict: 'page', pageId,
    });
    return PageDataSchema.parse(result.data);
  },
  async listTrashedPages(signal?: AbortSignal): Promise<TrashedPageInfo[]> {
    return (await request<{ pages: TrashedPageInfo[] }>('/api/trash/pages', { signal })).pages;
  },
  async restoreTrashedPage(name: string, expectedRevision?: number): Promise<{
    meta: Meta; page: PageInfo; data: PageData; cleanupWarning?: string;
  }> {
    const result = await request<{ meta: Meta; page: PageInfo; data: unknown; cleanupWarning?: string }>(
      `/api/trash/pages/${encodeURIComponent(name)}/restore`, {
        method: 'POST', body: { expectedRevision }, conflict: 'meta',
      },
    );
    return { ...result, data: PageDataSchema.parse(result.data) };
  },
  async exportMarkdown(): Promise<string> {
    const response = await apiFetch(`${getApiBase()}/api/workspace/markdown`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  async exportWorkspaceJson(): Promise<WorkspaceExport> {
    const data = await request<WorkspaceExport>('/api/workspace/export.json');
    return {
      exportedAt: data.exportedAt,
      meta: MetaSchema.parse(data.meta),
      pages: Object.fromEntries(Object.entries(data.pages).map(([id, page]) => [id, PageDataSchema.parse(page)])),
    };
  },
  async importWorkspaceJson(data: WorkspaceExport): Promise<Meta> {
    const result = await request<{ meta?: unknown }>('/api/workspace/import', { method: 'POST', body: data });
    return MetaSchema.parse(result.meta);
  },
  async listMcpKeys(signal?: AbortSignal): Promise<McpKeyInfo[]> {
    return (await request<{ keys: McpKeyInfo[] }>('/api/mcp/keys', { signal })).keys;
  },
  generateMcpKey: (label: string, scopes: McpKeyScope[] = ['read', 'write']): Promise<GeneratedMcpKey> =>
    request('/api/mcp/keys', { method: 'POST', body: { label, scopes } }),
  async revokeMcpKey(id: string): Promise<void> {
    await request(`/api/mcp/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const body = { currentPassword, newPassword };
    if (isNativeRuntime()) {
      const result = await request<{ ok: boolean; token: string }>('/api/auth/native/change-password', {
        method: 'POST', body: { ...body, remember: isNativeSessionPersisted() },
      });
      await replaceNativeSessionToken(result.token);
    } else {
      await request('/api/auth/change-password', { method: 'POST', body });
    }
  },
};
