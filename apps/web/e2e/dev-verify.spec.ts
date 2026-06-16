import { test, expect } from '@playwright/test';

/**
 * DEV-ONLY email-token surfacing (LOW-DEV-TOKEN-01). Real browser → BFF → Postgres.
 *
 * Proves register→verify→login works in the browser without DB/console access:
 * the backend captures the verification token at register time and exposes it via a
 * dev-only endpoint; the /verify-email page offers a one-click "Verify now (dev)".
 * This is the ONLY e2e path that verifies through the real token flow (the shared
 * helper uses a SQL shortcut). Guards the corrected /verify-email link path too.
 */

test('register → "Verify now (dev)" → verified → can log in (no SQL, no inbox)', async ({ page }) => {
  const email = `devverify_${Date.now()}@example.com`;
  const password = 'SuperSecret123!';

  // Register in the browser.
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Dev Verify Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();

  // Lands on /verify-email with the email — the dev shortcut auto-loads the token.
  await expect(page).toHaveURL(/\/verify-email/);
  const devVerify = page.getByTestId('btn-dev-verify-now');
  await expect(devVerify).toBeVisible(); // backend captured the token, endpoint returned it

  // One click completes verification (token flow → auto-verify → redirect to /login).
  await devVerify.click();
  await expect(page).toHaveURL(/\/login/);

  // The account is now verified: a real login succeeds and routes into onboarding.
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
  await expect(page).toHaveURL(/\/workspace\/new/);
});
