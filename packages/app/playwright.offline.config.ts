import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: /offlineShell\.spec\.ts/, timeout: 30_000, workers: 1,
  outputDir: 'test-results/offline',
  reporter: [['list'], ['json', { outputFile: 'test-results/offline-report.json' }]],
  use: { baseURL: 'http://127.0.0.1:5194', trace: 'retain-on-failure', storageState: { cookies: [], origins: [] } },
  projects: [
    { name: 'offline-desktop', use: devices['Desktop Chrome'] },
    { name: 'offline-ipad', use: devices['iPad Pro 11'] },
  ],
  webServer: { command: 'node scripts/offline-preview.mjs', url: 'http://127.0.0.1:5194', reuseExistingServer: false },
});
