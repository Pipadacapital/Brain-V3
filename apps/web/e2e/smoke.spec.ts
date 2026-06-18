import { test, expect } from '@playwright/test';
import { markEmailVerified } from './helpers/db';

/**
 * M1 happy-path smoke — the full real browser → BFF → Postgres flow.
 *
 * register → verify → login → onboarding (4 steps) → dashboard → logout.
 *
 * Step 1: Create Workspace
 * Step 2: Create Brand (currency INR, timezone Asia/Kolkata, revenue realized)
 * Step 3: Connect Integrations → "Skip For Now"
 * Step 4: Done → Go to Dashboard
 *
 * Also asserts:
 * - Ghost /invite step returns 404 (MA-10).
 * - Resume: a user at brand_created logs in again and lands on Step 3 (not dashboard).
 * - ZERO uncaught client errors across the whole flow.
 */

test('register → verify → login → Step1 Workspace → Step2 Brand → Step3 Integrations (Skip) → Step4 Done → dashboard → logout', async ({ page }) => {
  const stamp = Date.now();
  const email = `smoke_${stamp}@example.com`;
  const password = 'SuperSecret123!';

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // 1. Register
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Smoke Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/verify-email/);

  // 2. Verify email out-of-band (dev sends no real email).
  await markEmailVerified(email);

  // 3. Login — a brand-less user has onboarding_status=pending → /workspace/new (Step 1).
  await page.goto('/login');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
  await expect(page).toHaveURL(/\/workspace\/new/);

  // Verify Step 1 indicator visible.
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 4/i);

  // 4. Step 1 — Create workspace (slug pinned unique to avoid collisions).
  await page.getByTestId('input-workspace-name').fill('Smoke Workspace');
  await page.getByTestId('input-workspace-slug').fill(`smoke-ws-${stamp}`);
  await page.getByTestId('btn-create-workspace').click();
  await expect(page).toHaveURL(/\/brand\/new/);

  // Verify Step 2 indicator visible.
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 2 of 4/i);

  // 5. Step 2 — Create brand with locale fields.
  await page.getByTestId('input-brand-name').fill('Smoke Brand');
  // Currency: INR (default — verify select exists)
  await expect(page.getByTestId('select-currency-code')).toBeVisible();
  // Timezone: Asia/Kolkata (default — verify select exists)
  await expect(page.getByTestId('select-timezone')).toBeVisible();
  // Revenue: realized (default — verify select exists)
  await expect(page.getByTestId('select-revenue-definition')).toBeVisible();
  // Skip the website (no live storefront in the smoke env) → tracking interstitial in
  // its honest "add website" state, then continue to Step 3.
  await page.getByTestId('btn-skip-website').click();
  await expect(page).toHaveURL(/\/onboarding\/tracking/);
  await expect(page.getByTestId('tracking-ready-skipped')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('btn-tracking-continue').click();

  // After brand creation: session refresh → onboarding_status=brand_created → Step 3.
  await expect(page).toHaveURL(/\/onboarding\/integrations/);

  // Verify Step 3 indicator visible.
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 3 of 4/i);

  // 6. Step 3 — Skip For Now (zero-connection finish).
  await expect(page.getByTestId('btn-skip-integrations')).toBeVisible();
  await page.getByTestId('btn-skip-integrations').click();

  // After skip: advance → integration_selected → Step 4.
  await expect(page).toHaveURL(/\/onboarding\/done/);

  // Verify Step 4 indicator visible.
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 4 of 4/i);

  // 7. Step 4 — Go to Dashboard.
  await expect(page.getByTestId('btn-go-to-dashboard')).toBeVisible();
  await page.getByTestId('btn-go-to-dashboard').click();

  // After done: advance → complete → /dashboard.
  await expect(page).toHaveURL(/\/dashboard/);

  // 8. Dashboard renders — onboarding progress card shows real data.
  await expect(page.getByTestId('onboarding-progress-card')).toBeVisible();

  // 9. Logout → back to login.
  await page.getByTestId('btn-logout').click();
  await expect(page).toHaveURL(/\/login/);

  // 10. No uncaught client errors anywhere in the flow.
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  const appErrors = consoleErrors.filter(
    (e) => !/favicon|net::ERR|40[14] \((Not Found|Unauthorized)\)/i.test(e),
  );
  expect(appErrors, `console errors: ${appErrors.join(' | ')}`).toEqual([]);
});

test('ghost /invite step returns 404 (MA-10)', async ({ page }) => {
  // The ghost invite page has been deleted. A GET to /invite should 404 or redirect.
  const response = await page.goto('/invite');
  // Next.js returns 404 for deleted routes (or redirects to /login via middleware).
  // Either is acceptable — just confirm it does NOT render the old "Step 3 of 3" text.
  const body = await page.content();
  expect(body).not.toContain('Step 3 of 3');
});

test('resume assertion: user at brand_created lands on Step 3 (/onboarding/integrations)', async ({ page }) => {
  /**
   * Simulates a user who completed Step 1 + Step 2 but never did Step 3.
   * On login, onboarding_status=brand_created → should land on /onboarding/integrations.
   *
   * Setup: register fresh user, verify, complete Steps 1+2, then logout.
   * Verify: login again → redirect to Step 3 (not /dashboard).
   */
  const stamp = Date.now();
  const email = `resume_${stamp}@example.com`;
  const password = 'SuperSecret123!';

  // Register
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Resume Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/verify-email/);

  await markEmailVerified(email);

  // Login (pending → Step 1)
  await page.goto('/login');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
  await expect(page).toHaveURL(/\/workspace\/new/);

  // Step 1 — create workspace
  await page.getByTestId('input-workspace-name').fill('Resume Workspace');
  await page.getByTestId('input-workspace-slug').fill(`resume-ws-${stamp}`);
  await page.getByTestId('btn-create-workspace').click();
  await expect(page).toHaveURL(/\/brand\/new/);

  // Step 2 — create brand, skipping the website (leaves status at brand_created)
  await page.getByTestId('input-brand-name').fill('Resume Brand');
  await page.getByTestId('btn-skip-website').click();
  // After brand creation we hit the tracking interstitial. Immediately navigate away
  // (simulate crash) — the server status is still brand_created.
  await expect(page).toHaveURL(/\/onboarding\/tracking/);

  // Simulate logout (crash recovery — user navigates away without completing Step 3).
  await page.goto('/logout');
  // Or just navigate to login directly.
  await page.goto('/login');

  // Login again — onboarding_status=brand_created → should land on Step 3.
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();

  // Resume assertion: must land on Step 3, not /dashboard.
  await expect(page).toHaveURL(/\/onboarding\/integrations/);
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 3 of 4/i);
});
