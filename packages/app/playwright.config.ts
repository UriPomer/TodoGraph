import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, '../..');
const authFile = path.resolve(appRoot, 'test-results/.auth/user.json');
const e2eDataDir = path.join(tmpdir(), 'todograph-e2e', `run-${process.pid}-${Date.now()}`);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: path.resolve(appRoot, 'test-results/e2e-report.json') }]],
  use: {
    baseURL: 'http://127.0.0.1:5184',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'android-chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Pixel 7'], storageState: authFile },
    },
    {
      name: 'ios-webkit',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['iPhone 15'], storageState: authFile },
    },
    {
      name: 'desktop-chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: authFile },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @todograph/server dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:5183/api/auth/me',
      reuseExistingServer: false,
      env: {
        DATA_DIR: e2eDataDir,
        SESSION_SECRET: '0123456789abcdef0123456789abcdef',
        REGISTRATION_KEY: 'todograph-e2e',
        TODOGRAPH_E2E: '1',
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
