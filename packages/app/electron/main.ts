import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '@todograph/server';
import { isSafeExternalUrl, isSameOrigin } from '../src/lib/externalUrl';
import { electronServerHost } from '../src/lib/electronServerHost';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

// ===== 便携模式：把用户数据与可执行文件放在一起 =====
// electron-builder 的 portable target 在运行时会把 exe 解压到临时目录，
// 但会设置 PORTABLE_EXECUTABLE_DIR 指向**用户实际双击的 exe 所在目录**。
// 所以把 userData 重定位到它下面的 ./data，这样应用就是真正的绿色软件：
// 拷贝整个文件夹到别的机器依然能用，不留痕。
if (!isDev) {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const baseDir = portableDir ?? path.dirname(process.execPath);
  app.setPath('userData', path.join(baseDir, 'data'));
}

let apiBase = '';

async function loadOrCreateSessionSecret(dataDir: string): Promise<string> {
  const secretPath = path.join(dataDir, '.session-secret');
  try {
    const existing = (await fs.readFile(secretPath, 'utf-8')).trim();
    if (Buffer.byteLength(existing) !== 32) {
      throw new Error(`Invalid Electron session secret: ${secretPath}`);
    }
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
    if (Buffer.byteLength(existing) !== 32) {
      throw new Error(`Invalid Electron session secret: ${secretPath}`);
    }
    return existing;
  }
}

async function startServer(): Promise<void> {
  const dataDir = app.getPath('userData');
  const sessionSecret = await loadOrCreateSessionSecret(dataDir);
  const rendererUrl = isDev && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL)
    : null;
  // 生产模式下让 Fastify 也托管静态资源（和 Web 模式同构，双保险）
  const staticDir = isDev ? undefined : path.join(__dirname, '../renderer');
  const server = await buildApp({
    dataDir,
    staticDir,
    registrationKey: '',
    sessionSecret,
    cookieSecure: false,
    corsOrigin: rendererUrl?.origin,
    logger: isDev,
  });
  const addr = await server.listen({ port: 0, host: electronServerHost(rendererUrl) });
  const apiUrl = new URL(addr);
  if (rendererUrl) apiUrl.hostname = rendererUrl.hostname;
  apiBase = apiUrl.origin;
  console.log('[electron-main] Fastify listening at', addr);
  console.log('[electron-main] Data directory:', dataDir);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const rendererUrl = isDev && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : apiBase;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSameOrigin(url, rendererUrl) && isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isSameOrigin(url, rendererUrl)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(rendererUrl);
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    // 走 Fastify 的静态托管，这样渲染进程的 /api/graph 请求和页面同源
    void win.loadURL(apiBase);
  }
}

ipcMain.on('todograph:get-api-base-sync', (event) => {
  event.returnValue = apiBase;
});

app.whenReady().then(async () => {
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
