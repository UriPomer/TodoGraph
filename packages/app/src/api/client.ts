import { GraphSchema, type Graph } from '@todograph/shared';

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

export const api = {
  async loadGraph(): Promise<Graph> {
    const res = await fetch(`${getApiBase()}/api/graph`);
    const data = await json<unknown>(res);
    return GraphSchema.parse(data);
  },

  async saveGraph(graph: Graph): Promise<void> {
    const res = await fetch(`${getApiBase()}/api/graph`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graph),
    });
    await json<{ ok: boolean }>(res);
  },
};
