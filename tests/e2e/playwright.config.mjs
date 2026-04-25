import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 3081;
const BASE_URL = `http://127.0.0.1:${BASE_PORT}`;

export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.mjs',
  // Sequential by default — these tests share one DB and the same server port.
  // Run with --workers=1 explicitly too via CLI if needed.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    // Tablet-ish viewport; many of our regressions are tablet-only.
    viewport: { width: 1280, height: 800 },
  },

  // Global setup boots the test server with PORTOS_ENABLED=false on E2E_PORT
  // and seeds a minimal menu + admin staff. Teardown stops the server.
  globalSetup: path.resolve(__dirname, '_setup', 'global-setup.mjs'),
  globalTeardown: path.resolve(__dirname, '_setup', 'global-teardown.mjs'),

  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
