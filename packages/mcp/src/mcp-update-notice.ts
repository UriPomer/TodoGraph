import { AsyncLocalStorage } from 'node:async_hooks';

interface McpUpdateNoticeContext {
  latestVersion?: string;
}

// Isolate advisory state per tools/call when the MCP server handles calls concurrently.
const noticeContext = new AsyncLocalStorage<McpUpdateNoticeContext>();

export function noteMcpUpdate(latestVersion: string): void {
  const context = noticeContext.getStore();
  if (context) context.latestVersion = latestVersion;
}

export function runWithMcpUpdateNotice<T>(
  run: () => Promise<T>,
): Promise<{ value: T; latestVersion?: string }> {
  return noticeContext.run({}, async () => {
    const value = await run();
    return { value, latestVersion: noticeContext.getStore()?.latestVersion };
  });
}
