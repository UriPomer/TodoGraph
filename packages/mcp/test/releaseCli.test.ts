import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const receipts: unknown[] = [];
let sandbox: string;
let mcp: string;
let server: Server;
let registry: string;
let published: string | null;
let latest: string;
let outage: boolean;
let requests: string[];

async function command(script: string, args: string[] = []) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^npm_config_|^NODE_AUTH_TOKEN$|^GITHUB_OUTPUT$/i.test(name),
    ),
  );
  const result = await exec(process.execPath, [tsx, path.join(mcp, 'scripts', script), ...args], {
    cwd: mcp,
    env: {
      ...environment,
      NODE_AUTH_TOKEN: '',
      npm_config_registry: registry,
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '2000',
      GITHUB_OUTPUT: path.join(sandbox, 'outputs'),
    },
    timeout: 15000,
  }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  receipts.push({ script, args, ...result, requests: [...requests] });
  return result;
}
function version() {
  return JSON.parse(readFileSync(path.join(mcp, 'package.json'), 'utf8')).version;
}
function serverVersion() {
  return readFileSync(path.join(sandbox, 'packages/server/src/mcp-version.ts'), 'utf8');
}

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'todograph-release-cli-'));
  mcp = path.join(sandbox, 'packages/mcp');
  mkdirSync(path.join(mcp, 'scripts'), { recursive: true });
  cpSync(path.join(packageDir, 'scripts'), path.join(mcp, 'scripts'), { recursive: true });
  mkdirSync(path.join(mcp, 'node_modules'));
  symlinkSync(
    path.dirname(createRequire(import.meta.url).resolve('semver/package.json')),
    path.join(mcp, 'node_modules/semver'),
    'junction',
  );
  mkdirSync(path.join(mcp, 'dist'));
  writeFileSync(path.join(mcp, 'dist/index.js'), 'console.log("fixture MCP");\n');
  writeFileSync(
    path.join(mcp, 'package.json'),
    JSON.stringify(
      { name: '@todograph/mcp', version: '0.1.1', type: 'module', files: ['dist'] },
      null,
      2,
    ) + '\n',
  );
  mkdirSync(path.join(sandbox, 'packages/server/src'), { recursive: true });
  writeFileSync(
    path.join(sandbox, 'packages/server/src/mcp-version.ts'),
    "export const LATEST_MCP_VERSION = '0.1.1';\n",
  );
  const pack = await exec(
    process.platform === 'win32' ? process.execPath : 'npm',
    [...(process.platform === 'win32' ? [npm] : []), 'pack', '--dry-run', '--json'],
    { cwd: mcp },
  );
  published = JSON.parse(pack.stdout)[0].shasum;
  latest = '0.1.1';
  outage = false;
  requests = [];
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (outage) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: 'registry unavailable' }));
      return;
    }
    if (!published) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.end(
      JSON.stringify({
        name: '@todograph/mcp',
        'dist-tags': { latest },
        versions: {
          [latest]: { name: '@todograph/mcp', version: latest, dist: { shasum: published } },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  writeFileSync(
    path.join(tmpdir(), 'todograph-release-cli-report.json'),
    JSON.stringify(receipts, null, 2),
  );
  if (path.dirname(sandbox) !== tmpdir()) throw new Error('Unexpected fixture location');
  rmSync(sandbox, { recursive: true });
});

describe('MCP release public CLI against an isolated registry', { timeout: 30000 }, () => {
  it('keeps a published, identical package unchanged and checks it without publishing', async () => {
    expect((await command('prepare-version.ts')).code).toBe(0);
    expect(version()).toBe('0.1.1');
    expect(readFileSync(path.join(sandbox, 'outputs'), 'utf8')).toContain('changed=false');
    expect((await command('publish.ts', ['--dry-run'])).code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  });
  it('prepares a new patch in both packages, remains idempotent, and passes the dry run', async () => {
    published = 'different-published-content';
    const conflict = await command('publish.ts', ['--dry-run']);
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain('already exists with different contents');
    expect((await command('prepare-version.ts')).code).toBe(0);
    expect(version()).toBe('0.1.2');
    expect(serverVersion()).toBe("export const LATEST_MCP_VERSION = '0.1.2';\n");
    expect(readFileSync(path.join(sandbox, 'outputs'), 'utf8')).toContain('changed=true');
    expect((await command('prepare-version.ts')).code).toBe(0);
    expect(version()).toBe('0.1.2');
    expect((await command('publish.ts', ['--dry-run'])).code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
  });
  it('allows a deliberate minor release while rejecting malformed release types', async () => {
    published = 'different-published-content';
    const invalid = await command('prepare-version.ts', ['invalid']);
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain('Invalid release type');
    expect(version()).toBe('0.1.1');
    expect((await command('prepare-version.ts', ['minor'])).code).toBe(0);
    expect(version()).toBe('0.2.0');
    expect(serverVersion()).toContain("'0.2.0'");
  });
  it('leaves version files untouched when registry access fails or this checkout is outdated', async () => {
    outage = true;
    const unavailable = await command('prepare-version.ts');
    expect(unavailable.code).not.toBe(0);
    expect(unavailable.stderr).toContain('503');
    expect(version()).toBe('0.1.1');
    expect(serverVersion()).toContain("'0.1.1'");
    outage = false;
    latest = '0.2.0';
    const outdated = await command('prepare-version.ts');
    expect(outdated.code).not.toBe(0);
    expect(outdated.stderr).toContain('newer');
    expect(version()).toBe('0.1.1');
  });
});
