import { type Page, expect } from '@playwright/test';
import { markEmailVerified, markEmailUnverified, clearAuthRateLimits } from './db';

const PASSWORD = 'SuperSecret123!';

/** Unique-ish stamp per test to avoid email/slug collisions across the suite. */
function stamp(): number {
  return Date.now() + Math.floor(Math.random() * 100000);
}

/**
 * feat-onboarding-ux: register now AUTO-LOGS-IN. A genuinely-new user gets a real session
 * (httpOnly cookie) and lands straight in the wizard (/onboarding/start) — no manual /login,
 * no hard verify-email gate. This helper registers, then marks the email verified in the DB
 * (dev sends no real email) so downstream sensitive-action tests pass the server soft-gate.
 */
export async function registerAndVerify(
  page: Page,
  prefix = 'e2e',
): Promise<{ email: string; password: string; s: number }> {
  await clearAuthRateLimits(); // register is 10/hour/IP — clear so a long suite never 429s
  const s = stamp();
  const email = `${prefix}_${s}@example.com`;
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('E2E Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(PASSWORD);
  await page.getByTestId('btn-register').click();
  // Auto-login: lands in the merged create step already authenticated.
  await expect(page).toHaveURL(/\/onboarding\/start/);
  await markEmailVerified(email);
  return { email, password: PASSWORD, s };
}

/**
 * Register a fresh user WITHOUT marking the email verified — for soft-gate tests that need an
 * unverified-but-authenticated session (banner + sensitive-action 403). Lands on the wizard.
 */
export async function registerUnverified(
  page: Page,
  prefix = 'e2e',
): Promise<{ email: string; password: string; s: number }> {
  await clearAuthRateLimits(); // register is 10/hour/IP — clear so a long suite never 429s
  const s = stamp();
  const email = `${prefix}_${s}@example.com`;
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('E2E Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(PASSWORD);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/onboarding\/start/);
  // Dev auto-verifies on registration — undo it so this helper truly returns an unverified session.
  await markEmailUnverified(email);
  return { email, password: PASSWORD, s };
}

/** Submit the login form (does not assert the destination). */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await clearAuthRateLimits(); // login is IP/email rate-limited — keep negative-path tests stable
  await page.goto('/login');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
}

/**
 * Complete the merged Step 1 (workspace + brand) from /onboarding/start, skipping the website
 * so the test doesn't depend on a live storefront. Lands on the tracking interstitial (?w=0).
 */
export async function completeMergedStep(page: Page, opts?: { workspace?: string; brand?: string }): Promise<void> {
  await expect(page).toHaveURL(/\/onboarding\/start/);
  await page.getByTestId('input-workspace-name').fill(opts?.workspace ?? 'E2E Workspace');
  await page.getByTestId('input-brand-name').fill(opts?.brand ?? 'E2E Brand');
  await page.getByTestId('btn-skip-website').click();
  await expect(page).toHaveURL(/\/onboarding\/tracking/);
}

/**
 * Full register → auto-login → 3-step onboarding → dashboard. Returns the creds.
 * (feat-onboarding-ux: no separate login step; the merged create step provisions both
 * workspace + brand server-side; slug is auto-derived — no slug input.)
 */
export async function onboardToDashboard(
  page: Page,
  prefix = 'e2e',
): Promise<{ email: string; password: string }> {
  const { email, password } = await registerAndVerify(page, prefix);

  // Step 1 — merged create (workspace + brand), website skipped → tracking interstitial.
  await completeMergedStep(page);

  // Tracking interstitial → continue to integrations.
  await page.locator('[role="region"][aria-label^="Notifications"] li').waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  await page.getByTestId('btn-tracking-continue').click();
  await expect(page).toHaveURL(/\/onboarding\/integrations/);

  // Step 2 — skip integrations.
  await page.locator('[role="region"][aria-label^="Notifications"] li').waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  await page.getByTestId('btn-skip-integrations').click();
  await expect(page).toHaveURL(/\/onboarding\/done/);

  // Step 3 — done → dashboard.
  await page.getByTestId('btn-go-to-dashboard').click();
  await expect(page).toHaveURL(/\/dashboard/);

  return { email, password };
}
