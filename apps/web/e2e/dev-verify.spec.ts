import { test, expect } from '@playwright/test';

/**
 * DEV-ONLY email-token surfacing (LOW-DEV-TOKEN-01). Real browser → BFF → Postgres.
 *
 * feat-onboarding-ux: register now AUTO-LOGS-IN (no /verify-email detour) and email
 * verification is a soft-gate. This spec proves the dev token flow still works when the
 * user reaches the verification surface via the verify-email banner's "Verify email" link
 * (/verify-email?email=…): the backend captured the token at register time and the page
 * offers a one-click "Verify now (dev)". This is the ONLY e2e path through the real token
 * flow (the shared helper uses a SQL shortcut).
 */

test('register → auto-login → "Verify now (dev)" via verify surface → verified (no SQL, no inbox)', async ({ page }) => {
  const email = `devverify_${Date.now()}@example.com`;
  const password = 'SuperSecret123!';

  // Register in the browser — auto-login lands in the wizard already authenticated.
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Dev Verify Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/onboarding\/start/);

  // Reach the verification surface the way the soft-gate banner does (carrying the email).
  await page.goto(`/verify-email?email=${encodeURIComponent(email)}`);
  const devVerify = page.getByTestId('btn-dev-verify-now');
  await expect(devVerify).toBeVisible(); // backend captured the token, endpoint returned it

  // One click completes verification (token flow → auto-verify → redirect to /login).
  await devVerify.click();
  await expect(page).toHaveURL(/\/login/);

  // The account is now verified: a real login succeeds and routes into onboarding.
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
  await expect(page).toHaveURL(/\/onboarding\/start/);
});
