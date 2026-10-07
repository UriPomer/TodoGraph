import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('dist');
let unavailable = false;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
createServer(async (request, response) => {
  if (request.url === '/__e2e_network' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) body += chunk;
    unavailable = JSON.parse(body).offline === true; response.end('ok'); return;
  }
  if (unavailable) { request.socket.destroy(); return; }
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try { const body = await readFile(file); response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream'); response.end(body); }
  catch { response.writeHead(404).end(); }
}).listen(5194, '127.0.0.1');
