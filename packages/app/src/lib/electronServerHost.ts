const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function electronServerHost(rendererUrl: URL | null): string {
  const hostname = rendererUrl?.hostname ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`Electron renderer must use a loopback host, received: ${hostname}`);
  }
  return hostname === '[::1]' ? '::1' : hostname;
}
