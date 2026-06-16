import { type Page, expect } from '@playwright/test';
import { markEmailVerified } from './db';

const PASSWORD = 'SuperSecret123!';

/** Unique-ish stamp per test to avoid email/slug collisions across the suite. */
function stamp(): number {
  return Date.now() + Math.floor(Math.random() * 100000);
}

/** Register a fresh user and mark the email verified (dev sends no real email). */
export async function registerAndVerify(
  page: Page,
  prefix = 'e2e',
): Promise<{ email: string; password: string; s: number }> {
  const s = stamp();
  const email = `${prefix}_${s}@example.com`;
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('E2E Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(PASSWORD);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/verify-email/);
  await markEmailVerified(email);
  return { email, password: PASSWORD, s };
}

/** Submit the login form (does not assert the destination). */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
}

/** Full register → verify → login → 4-step onboarding → dashboard. Returns the creds. */
export async function onboardToDashboard(
  page: Page,
  prefix = 'e2e',
): Promise<{ email: string; password: string }> {
  const { email, password, s } = await registerAndVerify(page, prefix);
  await login(page, email, password);
  await expect(page).toHaveURL(/\/workspace\/new/);

  // Step 1 — workspace
  await page.getByTestId('input-workspace-name').fill('E2E Workspace');
  await page.getByTestId('input-workspace-slug').fill(`e2e-ws-${s}`);
  await page.getByTestId('btn-create-workspace').click();
  await expect(page).toHaveURL(/\/brand\/new/);

  // Step 2 — brand (currency/timezone/revenue default to INR/Asia-Kolkata/realized)
  await page.getByTestId('input-brand-name').fill('E2E Brand');
  await page.getByTestId('btn-create-brand').click();
  await expect(page).toHaveURL(/\/onboarding\/integrations/);

  // Step 3 — skip integrations
  // Wait for any lingering toast notifications to clear so they don't intercept
  // the click on btn-skip-integrations. Toasts auto-dismiss after a few seconds.
  await page.locator('[role="region"][aria-label^="Notifications"] li').waitFor({ state: 'detached', timeout: 8_000 }).catch(() => undefined);
  await page.getByTestId('btn-skip-integrations').click();
  await expect(page).toHaveURL(/\/onboarding\/done/);

  // Step 4 — done → dashboard
  await page.getByTestId('btn-go-to-dashboard').click();
  await expect(page).toHaveURL(/\/dashboard/);

  return { email, password };
}
