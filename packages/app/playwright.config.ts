import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '../..');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5184',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'android-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'ios-webkit', use: { ...devices['iPhone 15'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @todograph/server dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:5183/api/auth/me',
      reuseExistingServer: false,
      env: {
        DATA_DIR: path.resolve(appRoot, '.e2e-data'),
        SESSION_SECRET: '0123456789abcdef0123456789abcdef',
        REGISTRATION_KEY: 'todograph-e2e',
        PORT: '5183',
        HOST: '127.0.0.1',
      },
    },
    {
      command: 'pnpm --filter @todograph/app exec vite --port 5184',
      cwd: repoRoot,
      url: 'http://127.0.0.1:5184',
      reuseExistingServer: false,
      env: {
        VITE_API_PROXY_TARGET: 'http://127.0.0.1:5183',
      },
    },
  ],
});
