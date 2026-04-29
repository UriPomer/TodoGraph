import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * electron-vite 三段构建：
 * - main:    主进程（启动 Fastify、创建 BrowserWindow）
 * - preload: 预加载脚本（contextBridge 暴露 apiBase）
 * - renderer: React 前端（Vite）
 *
 * `externalizeDepsPlugin` 会把 package.json 里的 dependencies 标成 external
 * （不打进 bundle，运行时再 require）。对于 @todograph/* 工作区包，pnpm 的
 * symlink 布局容易让 electron-builder 打包时找不到，所以我们 **把它们
 * 从 externalize 名单里排除**，让 rollup 直接 bundle 进 main.js，省心又好打。
 */
const workspaceDeps = ['@todograph/core', '@todograph/shared', '@todograph/server'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceDeps })],
    build: {
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'electron/main.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'electron/preload.ts') },
      },
    },
  },
  renderer: {
    root: __dirname,
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: path.resolve(__dirname, 'index.html') },
      },
    },
  },
});
