import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LATEST_MCP_VERSION, isOlderMcpVersion, isValidMcpVersion } from '../src/mcp-version.js';

describe('MCP compatibility version', () => {
  it('stays aligned with the independently published MCP package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../mcp/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(LATEST_MCP_VERSION).toBe(manifest.version);
  });

  it('recommends updates only for missing, malformed, or older versions', () => {
    expect(isValidMcpVersion(undefined)).toBe(false);
    expect(isValidMcpVersion('invalid')).toBe(false);
    expect(isValidMcpVersion(LATEST_MCP_VERSION)).toBe(true);
    expect(isOlderMcpVersion(undefined)).toBe(true);
    expect(isOlderMcpVersion('invalid')).toBe(true);
    expect(isOlderMcpVersion('0.0.0')).toBe(true);
    expect(isOlderMcpVersion(`${LATEST_MCP_VERSION}-beta.1`)).toBe(true);
    expect(isOlderMcpVersion(LATEST_MCP_VERSION)).toBe(false);
    expect(isOlderMcpVersion('999.0.0')).toBe(false);
  });
});
