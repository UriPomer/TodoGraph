import { contextBridge, ipcRenderer } from 'electron';

/**
 * 把后端地址透传给渲染进程，供 api/client.ts 读取。
 * 在生产模式我们让 Fastify 直接托管前端，所以 apiBase 就是页面 origin；
 * 开发模式下是独立的 http://127.0.0.1:xxxx，靠注入让前端指向它。
 */
async function resolveApiBase(): Promise<string> {
  try {
    return await ipcRenderer.invoke('todograph:get-api-base');
  } catch {
    return '';
  }
}

resolveApiBase().then((base) => {
  contextBridge.exposeInMainWorld('__API_BASE__', base);
});

contextBridge.exposeInMainWorld('todograph', {
  isElectron: true,
});
