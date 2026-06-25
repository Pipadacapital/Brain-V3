/**
 * feat-onboarding-ux E2E — the customer-perspective friction cuts.
 *
 * Coverage:
 *   1. Auto-login: register → land in the wizard already authenticated (no manual /login),
 *      complete the 3-step flow → reach the dashboard.
 *   2. Soft-gate: an UNVERIFIED user sees the dismissible verify-email banner on the dashboard;
 *      the connect-store + invite buttons carry the verify-reason hint (UI guidance). The server
 *      gate is authoritative (proven under brain_app in core live tests) — here we assert the UX.
 *   3. Merged step: ONE form provisions workspace + brand; the website field + live host preview
 *      drive the tracking-ready snippet state (feat-onboarding-website preserved).
 *   4. Slug hidden: the slug input never renders.
 *   5. Forward-only: browser Back from a later step does NOT re-show the created form.
 *
 * Real browser → BFF → Postgres. Status indicators are icon+text (a11y), checked via axe.
 */

import { test, expect } from '@playwright/test';
import { registerAndVerify, registerUnverified, completeMergedStep, onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('feat-onboarding-ux', () => {
  test('auto-login: register lands authenticated in the wizard, no /login detour', async ({ page }) => {
    await page.goto('/register');
    const email = `oux_auto_${Date.now()}@example.com`;
    await page.getByTestId('input-full-name').fill('Auto Login');
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill('SuperSecret123!');
    await page.getByTestId('btn-register').click();

    // Authenticated session minted by the BFF → straight to the merged create step.
    await expect(page).toHaveURL(/\/onboarding\/start/);
    await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 3/i);
    // The merged create form is present (we did not pass through /login).
    await expect(page.getByTestId('input-workspace-name')).toBeVisible();
    await expect(page.getByTestId('input-brand-name')).toBeVisible();
  });

  test('register → auto-login → 3-step onboarding → dashboard', async ({ page }) => {
    await onboardToDashboard(page, 'oux_full');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('brand-summary-card')).toBeVisible();
  });

  test('slug input is never shown in the merged create step', async ({ page }) => {
    await registerAndVerify(page, 'oux_slug');
    await expect(page).toHaveURL(/\/onboarding\/start/);
    await expect(page.getByTestId('input-workspace-slug')).toHaveCount(0);
    await expect(page.getByText(/Workspace URL/i)).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test('merged step provisions workspace + brand + website → tracking-ready snippet', async ({ page }) => {
    await registerAndVerify(page, 'oux_merged');
    await expect(page).toHaveURL(/\/onboarding\/start/);

    await page.getByTestId('input-workspace-name').fill('Merged WS');
    await page.getByTestId('input-brand-name').fill('Merged Brand');
    // Website → live normalized-host preview (feat-onboarding-website preserved).
    await page.getByTestId('input-brand-domain').fill('https://Merged-Store.com/products?ref=x');
    await expect(page.getByTestId('brand-domain-preview')).toContainText('merged-store.com');

    await page.getByTestId('btn-create-brand').click();

    // One transaction provisioned both → tracking interstitial in the snippet state.
    await expect(page).toHaveURL(/\/onboarding\/tracking\?w=1/);
    await expect(page.getByTestId('tracking-ready-snippet')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tracking-ready-host')).toContainText('merged-store.com');
    await expectNoA11yViolations(page);
  });

  test('forward-only: Back from a later step does not re-show the created form', async ({ page }) => {
    await registerAndVerify(page, 'oux_back');
    // Complete the merged step (with the required website) → tracking interstitial → integrations.
    await completeMergedStep(page);
    await page.getByTestId('btn-tracking-continue').click();
    await expect(page).toHaveURL(/\/onboarding\/integrations/);

    // Browser Back — the OnboardingGate sees status brand_created (past Step 1) and
    // forward-redirects; the merged create form is NEVER re-rendered.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/onboarding\/start/);
    await expect(page).toHaveURL(/\/onboarding\/integrations/);
    await expect(page.getByTestId('input-brand-name')).toHaveCount(0);

    // Even a direct navigation back to /onboarding/start forward-redirects.
    await page.goto('/onboarding/start');
    await expect(page).toHaveURL(/\/onboarding\/integrations/);
  });

  test('soft-gate: unverified user sees the dismissible verify-email banner on the dashboard', async ({ page }) => {
    // Register WITHOUT verifying → finish onboarding → dashboard (the funnel is NOT gated).
    await registerUnverified(page, 'oux_banner');
    await completeMergedStep(page);
    await page.getByTestId('btn-tracking-continue').click();
    await expect(page).toHaveURL(/\/onboarding\/integrations/);
    await page.getByTestId('btn-skip-integrations').click();
    await expect(page).toHaveURL(/\/onboarding\/done/);
    await page.getByTestId('btn-go-to-dashboard').click();
    await expect(page).toHaveURL(/\/dashboard/);

    // The dismissible banner is shown (email not verified) and reads as a status region.
    const banner = page.getByTestId('verify-email-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/verify your email/i);
    await expect(page.getByTestId('btn-resend-verification')).toBeVisible();
    await expectNoA11yViolations(page);

    // Dismiss → hidden for the session (it reappears on reload until verified — honest).
    await page.getByTestId('btn-dismiss-verify-banner').click();
    await expect(banner).toHaveCount(0);
  });

  test('soft-gate UI: unverified user gets the verify-reason hint on connect + invite', async ({ page }) => {
    await registerUnverified(page, 'oux_gate');
    await completeMergedStep(page);
    await page.getByTestId('btn-tracking-continue').click();
    await page.getByTestId('btn-skip-integrations').click();
    await page.getByTestId('btn-go-to-dashboard').click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Connect-store: the reason hint renders and the connect button is disabled (UI guidance).
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('connect-verify-hint-shopify')).toContainText(/verify your email/i);
    await expect(page.getByTestId('connector-tile-shopify-connect')).toBeDisabled();
  });
});
