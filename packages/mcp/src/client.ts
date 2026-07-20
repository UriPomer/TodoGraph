import { noteMcpUpdate } from './mcp-update-notice.js';
import { MCP_VERSION } from './version.js';

const API_BASE = process.env.TODOGRAPH_API_BASE ?? 'http://127.0.0.1:5173';
const API_KEY = process.env.TODOGRAPH_API_KEY ?? '';
const configuredTimeout = Number(process.env.TODOGRAPH_REQUEST_TIMEOUT_MS ?? 15_000);
const REQUEST_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 100
  ? configuredTimeout
  : 15_000;

function headers(hasBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'X-TodoGraph-MCP-Version': MCP_VERSION,
  };
  if (hasBody) h['Content-Type'] = 'application/json';
  if (API_KEY) h['Authorization'] = `Bearer ${API_KEY}`;
  return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: headers(!!body),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') {
      throw new Error(`TodoGraph request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw error;
  }
  const latestMcpVersion = res.headers.get('X-TodoGraph-MCP-Latest-Version');
  if (latestMcpVersion) noteMcpUpdate(latestMcpVersion);
  const text = await res.text().catch(() => '');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, error: text || `HTTP ${res.status}` };
  }
  if (!res.ok) {
    const err = new Error(
      ((data as Record<string, unknown>)?.error as string) ?? `HTTP ${res.status}`
    ) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

export const client = {
  get<T>(path: string): Promise<T> {
    return request<T>('GET', path);
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body);
  },
  put<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PUT', path, body);
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, body);
  },
  delete<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('DELETE', path, body);
  },
};
