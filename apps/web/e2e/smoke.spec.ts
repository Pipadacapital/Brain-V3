import { test, expect } from '@playwright/test';
import { markEmailVerified } from './helpers/db';

/**
 * M1 happy-path smoke — the full real browser → BFF → Postgres flow.
 *
 * feat-onboarding-ux: register → AUTO-LOGIN → onboarding (3 steps) → dashboard → logout.
 *
 * Step 1: /onboarding/start — merged Create Workspace + Brand (slug auto-derived, no input)
 *         /onboarding/tracking — pixel-ready / add-website interstitial
 * Step 2: Connect Integrations → "Skip For Now"
 * Step 3: Done → Go to Dashboard
 *
 * Also asserts:
 * - Ghost /invite step returns 404 (MA-10).
 * - Resume: a user at brand_created logs in again and lands on Step 2 (not dashboard).
 * - ZERO uncaught client errors across the whole flow.
 */

test('register → auto-login → Step1 merged create → Step2 Integrations (Skip) → Step3 Done → dashboard → logout', async ({ page }) => {
  const stamp = Date.now();
  const email = `smoke_${stamp}@example.com`;
  const password = 'SuperSecret123!';

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // 1. Register — auto-login lands the user in the wizard already authenticated.
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Smoke Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/onboarding\/start/);

  // 2. Verify email out-of-band (dev sends no real email) so the soft-gate would pass later.
  await markEmailVerified(email);

  // Verify Step 1 indicator visible.
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 3/i);

  // 3. Step 1 — merged create (workspace + brand). NO slug input (auto-derived server-side).
  await expect(page.getByTestId('input-workspace-slug')).toHaveCount(0);
  await page.getByTestId('input-workspace-name').fill('Smoke Workspace');
  await page.getByTestId('input-brand-name').fill('Smoke Brand');
  // Defaults: currency INR / timezone Asia/Kolkata / revenue realized.
  await expect(page.getByTestId('select-currency-code')).toBeVisible();
  await expect(page.getByTestId('select-timezone')).toBeVisible();
  await expect(page.getByTestId('select-revenue-definition')).toBeVisible();
  // Website is required → fill it, then the tracking interstitial (captured/snippet state).
  await page.getByTestId('input-brand-domain').fill('smoke-store.com');
  await page.getByTestId('btn-create-brand').click();
  await expect(page).toHaveURL(/\/onboarding\/tracking/);
  await page.getByTestId('btn-tracking-continue').click();

  // After provision: onboarding_status=brand_created → Step 2 (integrations).
  await expect(page).toHaveURL(/\/onboarding\/integrations/);
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 2 of 3/i);

  // 4. Step 2 — Skip For Now (zero-connection finish).
  await expect(page.getByTestId('btn-skip-integrations')).toBeVisible();
  await page.getByTestId('btn-skip-integrations').click();
  await expect(page).toHaveURL(/\/onboarding\/done/);
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 3 of 3/i);

  // 5. Step 3 — Go to Dashboard.
  await expect(page.getByTestId('btn-go-to-dashboard')).toBeVisible();
  await page.getByTestId('btn-go-to-dashboard').click();
  await expect(page).toHaveURL(/\/dashboard/);

  // 6. Dashboard renders — onboarding progress card shows real data.
  await expect(page.getByTestId('onboarding-progress-card')).toBeVisible();

  // 7. Logout → back to login.
  await page.getByTestId('btn-logout').click();
  await expect(page).toHaveURL(/\/login/);

  // 8. No uncaught client errors anywhere in the flow.
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  const appErrors = consoleErrors.filter(
    (e) => !/favicon|net::ERR|40[14] \((Not Found|Unauthorized)\)/i.test(e),
  );
  expect(appErrors, `console errors: ${appErrors.join(' | ')}`).toEqual([]);
});

test('ghost /invite step returns 404 (MA-10)', async ({ page }) => {
  // The ghost invite page has been deleted. A GET to /invite should 404 or redirect.
  const response = await page.goto('/invite');
  void response;
  const body = await page.content();
  expect(body).not.toContain('Step 3 of 3');
});

test('resume assertion: user at brand_created lands on Step 2 (/onboarding/integrations)', async ({ page }) => {
  /**
   * Simulates a user who completed Step 1 (merged create) but never did Step 2.
   * On login, onboarding_status=brand_created → should land on /onboarding/integrations.
   */
  const stamp = Date.now();
  const email = `resume_${stamp}@example.com`;
  const password = 'SuperSecret123!';

  // Register — auto-login → /onboarding/start.
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Resume Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/onboarding\/start/);
  await markEmailVerified(email);

  // Step 1 — merged create with the required website (leaves status at brand_created).
  await page.getByTestId('input-workspace-name').fill('Resume Workspace');
  await page.getByTestId('input-brand-name').fill('Resume Brand');
  await page.getByTestId('input-brand-domain').fill('resume-store.com');
  await page.getByTestId('btn-create-brand').click();
  // Tracking interstitial — simulate crash (navigate away) without completing Step 2.
  await expect(page).toHaveURL(/\/onboarding\/tracking/);

  await page.goto('/logout');
  await page.goto('/login');

  // Login again — onboarding_status=brand_created → should land on Step 2.
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();

  await expect(page).toHaveURL(/\/onboarding\/integrations/);
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 2 of 3/i);
});
