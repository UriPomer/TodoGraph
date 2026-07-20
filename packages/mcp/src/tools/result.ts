import { runWithMcpUpdateNotice } from '../mcp-update-notice.js';
import { MCP_VERSION } from '../version.js';

export const textResult = (value: unknown, latestVersion?: string) => ({
  content: [
    ...(latestVersion ? [{
      type: 'text' as const,
      text: `⚠ 当前 MCP 版本为 ${MCP_VERSION}，最新版本为 ${latestVersion}。本次操作已正常完成，建议更新并重启：npx -y @todograph/mcp@latest`,
    }] : []),
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ],
});

export async function toolResult(run: () => Promise<unknown>) {
  const { value, latestVersion } = await runWithMcpUpdateNotice(run);
  return textResult(value, latestVersion);
}
