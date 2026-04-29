import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, FileRepository } from '@todograph/server';

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

async function startServer(): Promise<void> {
  const dataFile = path.join(app.getPath('userData'), 'tasks.json');
  const repo = new FileRepository(dataFile);
  // 生产模式下让 Fastify 也托管静态资源（和 Web 模式同构，双保险）
  const staticDir = isDev ? undefined : path.join(__dirname, '../renderer');
  const server = await buildApp({ repo, staticDir, logger: isDev });
  const addr = await server.listen({ port: 0, host: '127.0.0.1' });
  apiBase = addr;
  console.log('[electron-main] Fastify listening at', addr);
  console.log('[electron-main] Data file:', dataFile);
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
    },
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    // 走 Fastify 的静态托管，这样渲染进程的 /api/graph 请求和页面同源
    void win.loadURL(apiBase);
  }
}

ipcMain.handle('todograph:get-api-base', () => apiBase);

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
