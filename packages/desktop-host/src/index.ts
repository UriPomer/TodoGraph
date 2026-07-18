import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildApp } from '@todograph/server';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function electronServerHost(rendererUrl: URL | null): string {
  const hostname = rendererUrl?.hostname ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`Electron renderer must use a loopback host, received: ${hostname}`);
  }
  return hostname === '[::1]' ? '::1' : hostname;
}

async function loadOrCreateSessionSecret(dataDir: string): Promise<string> {
  const secretPath = path.join(dataDir, '.session-secret');
  try {
    const existing = (await fs.readFile(secretPath, 'utf-8')).trim();
    if (Buffer.byteLength(existing) !== 32) throw new Error(`Invalid Electron session secret: ${secretPath}`);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(24).toString('base64');
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.writeFile(secretPath, secret, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = (await fs.readFile(secretPath, 'utf-8')).trim();
    if (Buffer.byteLength(existing) !== 32) throw new Error(`Invalid Electron session secret: ${secretPath}`);
    return existing;
  }
}

export async function startEmbeddedServer(options: {
  dataDir: string;
  staticDir?: string;
  rendererUrl: URL | null;
  logger?: boolean;
}): Promise<{ apiBase: string; address: string }> {
  const server = await buildApp({
    dataDir: options.dataDir,
    staticDir: options.staticDir,
    registrationKey: '',
    sessionSecret: await loadOrCreateSessionSecret(options.dataDir),
    cookieSecure: false,
    corsOrigin: options.rendererUrl?.origin,
    logger: options.logger,
  });
  const address = await server.listen({ port: 0, host: electronServerHost(options.rendererUrl) });
  const apiUrl = new URL(address);
  if (options.rendererUrl) apiUrl.hostname = options.rendererUrl.hostname;
  return { apiBase: apiUrl.origin, address };
}
