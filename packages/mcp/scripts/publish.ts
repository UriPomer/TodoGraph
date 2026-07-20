import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gt, valid } from 'semver';

type PublishDecision = 'publish' | 'skip';

interface PackSummary {
  shasum: string;
}

export function decidePublish(localShasum: string, remoteShasum: string | null): PublishDecision {
  if (remoteShasum === null) return 'publish';
  if (localShasum === remoteShasum) return 'skip';
  throw new Error(
    'This package version already exists with different contents; bump the MCP version.',
  );
}

export function assertNewerVersion(localVersion: string, latestVersion: string | null): void {
  if (!valid(localVersion)) throw new Error(`Invalid local MCP version: ${localVersion}`);
  if (latestVersion !== null && (!valid(latestVersion) || !gt(localVersion, latestVersion))) {
    throw new Error(`MCP version ${localVersion} must be newer than npm latest ${latestVersion}.`);
  }
}

export function assertCurrentVersion(localVersion: string, latestVersion: string | null): void {
  if (!valid(localVersion)) throw new Error(`Invalid local MCP version: ${localVersion}`);
  if (!latestVersion || !valid(latestVersion) || localVersion !== latestVersion) {
    throw new Error(
      `MCP version ${localVersion} must match npm latest ${latestVersion ?? 'none'}.`,
    );
  }
}

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmArgs =
  process.platform === 'win32'
    ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [];

function runNpm(args: string[]) {
  return spawnSync(npmCommand, [...npmArgs, ...args], {
    cwd: packageDir,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function localPackShasum(): string {
  const result = runNpm(['pack', '--json', '--dry-run']);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed');
  const summaries = JSON.parse(result.stdout) as PackSummary[];
  const shasum = summaries[0]?.shasum;
  if (!shasum) throw new Error('npm pack did not return a package shasum');
  return shasum;
}

function publishedShasum(name: string, version: string): string | null {
  const result = runNpm(['view', `${name}@${version}`, 'dist.shasum', '--json']);
  if (result.error) throw result.error;
  if (result.status === 0) {
    const shasum = JSON.parse(result.stdout) as unknown;
    if (typeof shasum !== 'string' || !shasum) {
      throw new Error(`npm returned no shasum for ${name}@${version}`);
    }
    return shasum;
  }

  const errorOutput = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b|404 Not Found/i.test(errorOutput)) return null;
  throw new Error(result.stderr || `Unable to query ${name}@${version} from npm`);
}

function publishedLatestVersion(name: string): string | null {
  const result = runNpm(['view', name, 'version', '--json']);
  if (result.error) throw result.error;
  if (result.status === 0) {
    const version = JSON.parse(result.stdout) as unknown;
    if (typeof version !== 'string' || !version) {
      throw new Error(`npm returned no latest version for ${name}`);
    }
    return version;
  }

  const errorOutput = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b|404 Not Found/i.test(errorOutput)) return null;
  throw new Error(result.stderr || `Unable to query the latest ${name} version from npm`);
}

function publish(): void {
  const result = spawnSync(npmCommand, [...npmArgs, 'publish', '--access', 'public'], {
    cwd: packageDir,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm publish failed with exit code ${result.status}`);
}

function main(): void {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('MCP package name or version is missing');
  }

  const localShasum = localPackShasum();
  const remoteShasum = publishedShasum(manifest.name, manifest.version);
  const decision = decidePublish(localShasum, remoteShasum);
  if (decision === 'skip') {
    assertCurrentVersion(manifest.version, publishedLatestVersion(manifest.name));
    console.log(
      `${manifest.name}@${manifest.version} is already published with identical contents.`,
    );
    return;
  }
  assertNewerVersion(manifest.version, publishedLatestVersion(manifest.name));
  if (process.argv.includes('--dry-run')) {
    console.log(
      `${manifest.name}@${manifest.version} is not published; dry run will not publish it.`,
    );
    return;
  }
  if (!process.env.NODE_AUTH_TOKEN) {
    throw new Error('NPM_TOKEN is required to publish the MCP package.');
  }
  publish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
