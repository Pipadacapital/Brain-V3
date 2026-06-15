import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke config.
 *
 * PREREQUISITE: the dev stack must already be running (`pnpm dev` from the repo root —
 * docker infra + core :3001 + web :3000). The smoke runs against the live stack rather
 * than booting it, so it exercises the real browser → BFF → Postgres path.
 *
 * Run: pnpm --filter @brain/web test:e2e
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
