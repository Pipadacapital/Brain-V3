import { test, expect } from '@playwright/test';
import {
  onboardToDashboard,
  registerAndVerify,
  registerUnverified,
  completeMergedStep,
} from '../helpers/onboard';
import { markEmailUnverified } from '../helpers/db';

/**
 * Onboarding wizard E2E (feat-onboarding-ux).
 *
 * Routes: /onboarding/start -> /onboarding/tracking -> /onboarding/integrations -> /onboarding/done -> /dashboard.
 *
 * Every selector below is grounded in the real components:
 *   - apps/web/app/(onboarding)/onboarding/{start,tracking,integrations,done}/page.tsx
 *   - apps/web/components/onboarding/create-brand-workspace-form.tsx (testids, zod messages from lib/api/schemas.ts)
 *   - apps/web/components/onboarding/onboarding-gate.tsx (forward-only guard)
 *   - apps/web/components/onboarding/tracking-ready.tsx (btn-tracking-continue, tracking-ready-skipped)
 *   - apps/web/components/dashboard/verify-email-banner.tsx (soft-gate banner + dismiss)
 *
 * Each test creates its own fresh, isolated user (register auto-logs-in) so there is no shared state.
 */

test.describe('onboarding-wizard', () => {
  test('[positive] full merged create -> tracking -> integrations -> done -> dashboard', async ({ page }) => {
    // onboardToDashboard runs the whole helper-driven happy path end to end and asserts /dashboard.
    const { email } = await onboardToDashboard(page, 'onb_happy');
    expect(email).toContain('@');

    await expect(page).toHaveURL(/\/dashboard/);
    // Email was verified in the helper, so the soft-gate banner must NOT be present.
    await expect(page.getByTestId('verify-email-banner')).toHaveCount(0);
  });

  test('[positive] step 1 lands on /onboarding/start with the merged create form and step indicator', async ({ page }) => {
    await registerAndVerify(page, 'onb_step1');

    await expect(page).toHaveURL(/\/onboarding\/start/);
    await expect(page.getByTestId('step-indicator')).toHaveText('Step 1 of 3');
    await expect(page.getByRole('heading', { name: 'Set up your brand' })).toBeVisible();
    // Both merged inputs are present in ONE form (workspace + first brand).
    await expect(page.getByTestId('input-workspace-name')).toBeVisible();
    await expect(page.getByTestId('input-brand-name')).toBeVisible();
    await expect(page.getByTestId('btn-create-brand')).toBeVisible();
    await expect(page.getByTestId('btn-skip-website')).toBeVisible();
  });

  test('[positive] skipping the website routes to the tracking interstitial (add-website state)', async ({ page }) => {
    await registerAndVerify(page, 'onb_track');
    // completeMergedStep fills names, clicks btn-skip-website, asserts /onboarding/tracking.
    await completeMergedStep(page, { workspace: 'Track WS', brand: 'Track Brand' });

    await expect(page).toHaveURL(/\/onboarding\/tracking/);
    await expect(page.getByRole('heading', { name: 'Set up tracking' })).toBeVisible();
    // Skipped the website -> honest "add website" state, never a fake snippet.
    await expect(page.getByTestId('tracking-ready-skipped')).toBeVisible();
    await expect(page.getByTestId('btn-tracking-continue')).toBeVisible();
  });

  test('[negative] empty workspace and brand names show validation errors and do not advance', async ({ page }) => {
    await registerAndVerify(page, 'onb_valempty');
    await expect(page).toHaveURL(/\/onboarding\/start/);

    // Submit with both required fields blank (form is noValidate -> zod resolver fires).
    await page.getByTestId('btn-create-brand').click();

    await expect(page.getByText('Workspace name is required')).toBeVisible();
    await expect(page.getByText('Brand name is required')).toBeVisible();
    // Stayed on the create step; nothing was provisioned.
    await expect(page).toHaveURL(/\/onboarding\/start/);
  });

  test('[negative] empty brand name alone shows brand validation while workspace is filled', async ({ page }) => {
    await registerAndVerify(page, 'onb_valbrand');
    await expect(page).toHaveURL(/\/onboarding\/start/);

    await page.getByTestId('input-workspace-name').fill('Only Workspace');
    // Brand name left empty.
    await page.getByTestId('btn-create-brand').click();

    await expect(page.getByText('Brand name is required')).toBeVisible();
    await expect(page.getByText('Workspace name is required')).toHaveCount(0);
    await expect(page).toHaveURL(/\/onboarding\/start/);
  });

  test('[negative] slug input is never shown to the user on the create step', async ({ page }) => {
    await registerAndVerify(page, 'onb_noslug');
    await expect(page).toHaveURL(/\/onboarding\/start/);

    // The server derives the workspace slug from the name; there is no slug affordance.
    await expect(page.getByTestId('input-slug')).toHaveCount(0);
    await expect(page.getByLabel(/slug/i)).toHaveCount(0);
    await expect(page.getByText(/slug/i)).toHaveCount(0);
    await expect(page.getByPlaceholder(/slug/i)).toHaveCount(0);
  });

  test('[negative] an invalid website (no dot) shows a website validation message', async ({ page }) => {
    await registerAndVerify(page, 'onb_baddomain');
    await expect(page).toHaveURL(/\/onboarding\/start/);

    await page.getByTestId('input-workspace-name').fill('Domain WS');
    await page.getByTestId('input-brand-name').fill('Domain Brand');
    await page.getByTestId('input-brand-domain').fill('notadomain');
    await page.getByTestId('btn-create-brand').click();

    await expect(
      page.getByText('Enter a valid website (e.g. mystore.com or https://mystore.com)'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\/start/);
  });

  test('[edge] forward-only guard: re-visiting /onboarding/start after provisioning does NOT re-show the create form', async ({ page }) => {
    await registerAndVerify(page, 'onb_guard');
    await completeMergedStep(page, { workspace: 'Guard WS', brand: 'Guard Brand' });
    await expect(page).toHaveURL(/\/onboarding\/tracking/);

    // Navigate back to the already-completed create step. The OnboardingGate reads the
    // authoritative onboarding_status and forward-redirects (status is past "pending").
    await page.goto('/onboarding/start');

    // We must NOT land back on a fresh, empty create form. The gate forwards us off /start.
    await expect(page).not.toHaveURL(/\/onboarding\/start$/);
    // And the create form's workspace input must not be re-rendered as an empty step.
    await expect(page.getByTestId('input-workspace-name')).toHaveCount(0);
  });

  test('[edge] forward-only guard: browser Back from tracking forward-redirects, never re-showing the empty form', async ({ page }) => {
    await registerAndVerify(page, 'onb_back');
    await completeMergedStep(page, { workspace: 'Back WS', brand: 'Back Brand' });
    await expect(page).toHaveURL(/\/onboarding\/tracking/);

    // Browser Back -> the gate re-checks status on mount and replaces the route forward.
    await page.goBack();

    await expect(page.getByTestId('input-brand-name')).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/onboarding\/start$/);
  });

  test('[edge] soft-gate: an unverified user reaches the dashboard and sees a dismissible verify-email banner', async ({ page }) => {
    // Register WITHOUT verifying email; run the wizard manually to /dashboard.
    const { email } = await registerUnverified(page, 'onb_softgate');
    await completeMergedStep(page, { workspace: 'Soft WS', brand: 'Soft Brand' });

    await page.getByTestId('btn-tracking-continue').click();
    await expect(page).toHaveURL(/\/onboarding\/integrations/);
    await page.getByTestId('btn-skip-integrations').click();
    await expect(page).toHaveURL(/\/onboarding\/done/);
    await page.getByTestId('btn-go-to-dashboard').click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Dev auto-verifies on registration; force the email unverified at the LAST moment (after the
    // wizard settles) then reload so the dashboard's /v1/bff/me read returns email_verified=false.
    await markEmailUnverified(email);
    await page.reload();

    // Banner appears because email_verified === false (polled from /v1/bff/me).
    const banner = page.getByTestId('verify-email-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Verify your email to unlock everything')).toBeVisible();
    await expect(page.getByTestId('btn-resend-verification')).toBeVisible();

    // Dismiss is session-only (sessionStorage), not persisted forever.
    await page.getByTestId('btn-dismiss-verify-banner').click();
    await expect(banner).toHaveCount(0);

    // Honest progress: the dismissal is session-scoped — clearing the session (new tab/session)
    // brings the banner back, because the email is still unverified. A plain reload keeps it
    // dismissed (sessionStorage survives reload), so we clear the session to prove it reappears.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId('verify-email-banner')).toBeVisible();
  });

  test('[edge] a fresh fully-onboarded (verified) user sees NO verify-email banner on the dashboard', async ({ page }) => {
    // registerAndVerify marks the email verified; complete the wizard to the dashboard.
    await onboardToDashboard(page, 'onb_verified');
    await expect(page).toHaveURL(/\/dashboard/);

    // Give the /v1/bff/me query a moment to resolve, then assert the banner stays absent.
    await expect(page.getByTestId('btn-go-to-dashboard')).toHaveCount(0);
    await expect(page.getByTestId('verify-email-banner')).toHaveCount(0);
  });
});
