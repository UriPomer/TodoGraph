import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inc } from 'semver';
import {
  assertCurrentVersion,
  assertNewerVersion,
  localPackShasum,
  publishedLatestVersion,
  publishedShasum,
} from './publish.js';

const releaseType = process.argv[2] ?? 'patch';
if (releaseType !== 'patch' && releaseType !== 'minor' && releaseType !== 'major') {
  throw new Error('Invalid release type; use patch, minor, or major.');
}
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(packageDir, 'package.json');
const serverPath = path.resolve(packageDir, '../server/src/mcp-version.ts');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name: string;
  version: string;
};
const serverSource = readFileSync(serverPath, 'utf8');
const declaration = `export const LATEST_MCP_VERSION = '${manifest.version}';`;
if (serverSource.split(declaration).length !== 2) {
  throw new Error('MCP and server versions must be aligned before preparing a release.');
}
const latest = publishedLatestVersion(manifest.name);
const remoteShasum = publishedShasum(manifest.name, manifest.version);
let changed = false;
if (remoteShasum === null) {
  assertNewerVersion(manifest.version, latest);
} else {
  assertCurrentVersion(manifest.version, latest);
  if (localPackShasum() !== remoteShasum) {
    const version = inc(manifest.version, releaseType);
    if (!version) throw new Error('Unable to increment MCP version.');
    manifest.version = version;
    writeFileSync(
      serverPath,
      serverSource.replace(declaration, `export const LATEST_MCP_VERSION = '${version}';`),
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    changed = true;
  }
}
const output = `changed=${changed}\nversion=${manifest.version}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
console.log(output.trim());
