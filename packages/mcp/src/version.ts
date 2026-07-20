import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version?: unknown;
};

if (typeof manifest.version !== 'string' || !manifest.version) {
  throw new Error('Missing MCP version in package.json');
}

export const MCP_VERSION = manifest.version;
