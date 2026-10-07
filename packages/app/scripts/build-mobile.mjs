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
if (apiBase && (!apiOrigin || apiOrigin.protocol !== 'https:' || apiOrigin.origin !== apiBase)) {
  throw new Error('When provided, VITE_API_BASE must be the public HTTPS TodoGraph server origin');
}
process.env.VITE_API_BASE = apiBase ?? '';
process.env.VITE_LOCAL_FIRST = apiBase ? 'false' : 'true';
const cloudContainer = process.env.TODOGRAPH_CLOUDKIT_CONTAINER ?? '';
if (cloudContainer && !/^iCloud\.[A-Za-z0-9.-]+$/.test(cloudContainer)) throw new Error('TODOGRAPH_CLOUDKIT_CONTAINER must be an iCloud container identifier');
process.env.VITE_CLOUDKIT_CONTAINER = cloudContainer;
const entitlementsPath = fileURLToPath(new URL('../ios/App/App/App.entitlements', import.meta.url));
writeFileSync(entitlementsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${cloudContainer ? `
<key>com.apple.developer.icloud-container-identifiers</key><array><string>${cloudContainer}</string></array>
<key>com.apple.developer.icloud-services</key><array><string>CloudKit</string></array>
<key>com.apple.developer.icloud-container-environment</key><string>$(TODOGRAPH_CLOUDKIT_ENVIRONMENT)</string>` : ''}
</dict></plist>
`);
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
