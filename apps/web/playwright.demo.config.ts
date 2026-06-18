import { defineConfig, devices } from '@playwright/test';

/**
 * WATCHABLE DEMO CONFIG — slow, headed, narrated.
 *
 * Purpose: give stakeholders a chance to see the UI during an E2E run.
 * This is a SEPARATE config from playwright.config.ts; the CI smoke config is untouched.
 *
 * Run:
 *   pnpm --filter @brain/web test:e2e:demo
 *   # or with custom slow-motion:
 *   PW_SLOWMO=1000 pnpm --filter @brain/web test:e2e:demo
 *
 * PREREQUISITE: dev stack must be running (`pnpm dev` from repo root).
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const SLOW_MO = Number(process.env.PW_SLOWMO ?? 700);

export default defineConfig({
  testDir: './e2e/demo',

  // Reuse the existing global-setup to clear rate-limit counters in Redis
  globalSetup: './e2e/global-setup.ts',

  // One worker, strictly sequential — we want the viewer to follow one story at a time
  fullyParallel: false,
  workers: 1,

  // No retries in demo mode — each step is deliberate and slow enough to be reliable
  retries: 0,
  forbidOnly: false,

  timeout: 180_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    headless: false,
    launchOptions: {
      slowMo: SLOW_MO,
    },
    // Record everything so stakeholders can replay what they saw
    video: 'on',
    trace: 'on',
    screenshot: 'only-on-failure',
  },

  reporter: [['list'], ['html', { open: 'never' }]],

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
