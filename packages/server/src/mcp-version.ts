import { lt, valid } from 'semver';

export const LATEST_MCP_VERSION = '0.1.1';
export const MCP_VERSION_HEADER = 'x-todograph-mcp-version';
export const MCP_LATEST_VERSION_HEADER = 'x-todograph-mcp-latest-version';

export function isValidMcpVersion(version: unknown): version is string {
  return typeof version === 'string' && valid(version) !== null;
}

export function isOlderMcpVersion(version: unknown): boolean {
  return !isValidMcpVersion(version) || lt(version, LATEST_MCP_VERSION);
}

export function todographUpdateRequired(currentMcpVersion: unknown) {
  return {
    ok: false,
    code: 'TODOGRAPH_UPDATE_REQUIRED',
    error: '当前 TodoGraph 后端不支持此操作。请更新 TodoGraph 后重试；当前操作已中断。',
    currentMcpVersion: typeof currentMcpVersion === 'string' ? currentMcpVersion : null,
  };
}

export function mcpUpdateRequired(currentVersion: unknown) {
  const current = isValidMcpVersion(currentVersion) ? currentVersion : null;
  return {
    ok: false,
    code: 'MCP_UPDATE_REQUIRED',
    error: current
      ? '当前 MCP 不支持此操作。请更新 MCP（npx -y @todograph/mcp@latest）并重启客户端后重试；当前操作已中断。'
      : '无法确认当前 MCP 版本。请更新 MCP（npx -y @todograph/mcp@latest）并重启客户端后重试；当前操作已中断。',
    currentVersion: current,
    latestVersion: LATEST_MCP_VERSION,
  };
}
