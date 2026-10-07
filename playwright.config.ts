import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4175',
    viewport: { width: 1280, height: 800 },
    // Existing editing scenarios run with the optional panels expanded.
    // workspace-panels.spec.ts checks the actual collapsed first-run default.
    storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:4175', localStorage: [{ name: 'turzx-studio.workspace-panels.v1', value: JSON.stringify({ widgets: true, inspector: true, tools: true }) }] }] },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm preview --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
});
