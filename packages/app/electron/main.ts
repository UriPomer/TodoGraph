import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedServer } from '@todograph/desktop-host';
import { isSafeExternalUrl, isSameOrigin } from '../src/lib/externalUrl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;

// ===== 默认数据目录：开发时放仓库根目录，便携版放可执行文件旁 =====
// electron-builder 的 portable target 在运行时会把 exe 解压到临时目录，
// 但会设置 PORTABLE_EXECUTABLE_DIR 指向**用户实际双击的 exe 所在目录**。
// 开发构建的 main bundle 位于 packages/app/out/main，向上四级即仓库根目录。
// 统一把 userData 重定位到根目录下的 ./data：
// 拷贝整个文件夹到别的机器依然能用，不留痕。
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataRoot = isDev
  ? path.resolve(__dirname, '../../../..')
  : portableDir ?? path.dirname(process.execPath);
app.setPath('userData', path.join(dataRoot, 'data'));

let apiBase = '';

async function startServer(): Promise<void> {
  const dataDir = app.getPath('userData');
  const rendererUrl = isDev && process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL)
    : null;
  // 生产模式下让 Fastify 也托管静态资源（和 Web 模式同构，双保险）
  const staticDir = isDev ? undefined : path.join(__dirname, '../renderer');
  const started = await startEmbeddedServer({
    dataDir,
    staticDir,
    rendererUrl,
    logger: isDev,
  });
  apiBase = started.apiBase;
  console.log('[electron-main] Fastify listening at', started.address);
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
