import path from 'node:path';
import { defineConfig } from '@playwright/test';

const wranglerEnvironment = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(process.cwd(), '.wrangler-config'),
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:8137',
    headless: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.STACKFALL_E2E_SERVERS === 'external' ? undefined : [
    {
      command: 'node node_modules/wrangler/bin/wrangler.js dev --port 8788 --persist-to .wrangler/e2e',
      cwd: './worker',
      url: 'http://127.0.0.1:8788/',
      env: wranglerEnvironment,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'node scripts/duel-dev-server.mjs',
      url: 'http://127.0.0.1:8137/',
      reuseExistingServer: true,
      timeout: 15_000,
    },
  ],
});
