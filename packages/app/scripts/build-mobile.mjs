import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const apiBase = process.env.VITE_API_BASE?.replace(/\/$/, '');
let apiOrigin;
try {
  apiOrigin = apiBase ? new URL(apiBase) : null;
} catch {
  apiOrigin = null;
}
if (!apiOrigin || apiOrigin.protocol !== 'https:' || apiOrigin.origin !== apiBase) {
  throw new Error('VITE_API_BASE must be the public HTTPS TodoGraph server origin');
}
process.env.VITE_API_BASE = apiBase;
const pnpmEntry = process.env.npm_execpath;
if (!pnpmEntry) throw new Error('build:mobile must be started through pnpm');
for (const args of [['build:web'], ['exec', 'cap', 'sync']]) {
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Capacitor emits Windows separators into Swift package path strings when sync
// runs on Windows. Normalize the generated file so it remains buildable on macOS.
const swiftPackage = fileURLToPath(new URL('../ios/App/CapApp-SPM/Package.swift', import.meta.url));
const packageSource = readFileSync(swiftPackage, 'utf8');
writeFileSync(swiftPackage, packageSource.replaceAll('\\', '/'));
