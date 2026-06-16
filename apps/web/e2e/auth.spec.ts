import { test, expect } from '@playwright/test';
import { registerAndVerify, login } from './helpers/onboard';

/**
 * Auth-surface E2E — login failure, the auth guard, password reset.
 * Real browser → BFF → Postgres.
 */

test('login with a wrong password shows a generic error and stays on /login', async ({ page }) => {
  const { email } = await registerAndVerify(page, 'badlogin');
  await login(page, email, 'TotallyWrong999!');
  // Stays on /login (no redirect into the app) and shows the neutral error.
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
});

test('unauthenticated visit to /dashboard redirects to /login (auth guard)', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});

test('unauthenticated visit to /settings/connectors redirects to /login', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/settings/connectors');
  await expect(page).toHaveURL(/\/login/);
});

test('forgot-password shows a neutral "if an account exists" message (no enumeration)', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByTestId('input-email').fill('does-not-exist@example.com');
  await page.getByTestId('btn-send-reset').click();
  await expect(page.getByText(/if an account exists/i)).toBeVisible();
});

test('a verified user can log in and lands in onboarding (pending → Step 1)', async ({ page }) => {
  const { email, password } = await registerAndVerify(page, 'login-ok');
  await login(page, email, password);
  await expect(page).toHaveURL(/\/workspace\/new/);
  await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 4/i);
});
