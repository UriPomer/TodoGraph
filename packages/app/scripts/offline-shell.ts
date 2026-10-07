import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Cache only public application assets. API responses and user data never enter this cache. */
export function offlineShell(): Plugin {
  return {
    name: 'todograph-offline-shell', apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['/', '/index.html', '/manifest.webmanifest', '/favicon.ico', ...Array.from({ length: 6 }, (_, index) => `/bg-${index + 1}.jpg`),
        ...Object.keys(bundle).filter(name => /\.(js|css)$/.test(name)).map(name => '/' + name)];
      const version = createHash('sha256').update(Object.values(bundle).map(item => item.type === 'chunk' ? item.code : String(item.source)).join('')).digest('hex').slice(0, 16);
      const source = `const CACHE = 'todograph-shell-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('todograph-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/index.html'))));
  } else if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(event.request)));
  }
});`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
