import { test, expect } from '@playwright/test';
import {
  step,
  pauseFor,
  announce,
  registerAndVerify,
  registerUnverified,
  completeMergedStep,
  onboardToDashboard,
  expectNoA11yViolations,
} from './helpers/demo';

/**
 * WATCHABLE DEMO — Onboarding flow (Brain), feat-onboarding-ux.
 *
 * A narrated, headed walk through the IMPROVED onboarding:
 *   - Auto-login: register → land in the wizard already authenticated (no manual /login).
 *   - 3 steps (workspace + brand merged into ONE create step; slug auto-derived/hidden):
 *       Step 1 /onboarding/start         — create workspace + brand (one form)
 *              /onboarding/tracking       — pixel-ready / add-website interstitial
 *       Step 2 /onboarding/integrations  — connect Shopify OR skip
 *       Step 3 /onboarding/done          — finish → /dashboard
 *   - Soft-gate: an unverified user reaches the dashboard, sees a dismissible verify-email
 *     banner, and the sensitive actions carry a verify-reason hint (server is the real gate).
 *   - Forward-only: browser Back from a later step does NOT re-show the created form.
 *
 * Every action is wrapped in `step(...)` for a watching stakeholder; assertions are REAL.
 */

test.describe('Onboarding flow — watchable demo', () => {
  // POSITIVE 1 — Happy path: register → auto-login → 3 steps → dashboard.
  test('Happy path — register, auto-login, onboard, reach dashboard', async ({ page }) => {
    await announce(page, 'Onboarding — the happy path (auto-login, merged step, skip integrations)');

    await step(page, 'Register → AUTO-LOGIN → run the 3 onboarding steps → dashboard', async () => {
      await onboardToDashboard(page, 'demo_skip');
    });

    await step(page, 'We have landed on the dashboard', async () => {
      await expect(page).toHaveURL(/\/dashboard/);
    });

    await step(page, 'The brand summary card is visible — onboarding really finished', async () => {
      await expect(page.getByTestId('brand-summary-card')).toBeVisible();
    });

    await step(page, 'The new workspace has exactly one member (the founder)', async () => {
      await expect(page.getByText('1 member')).toBeVisible();
    });

    await step(page, 'Accessibility gate — scan the dashboard for WCAG violations', async () => {
      await expectNoA11yViolations(page);
    });

    await pauseFor(page, 1200);
  });

  // POSITIVE 2 — Drive the merged create step BY HAND, filling the Website URL.
  test('Filled path — type every field incl. the brand Website URL, then finish', async ({ page }) => {
    await announce(page, 'Onboarding — typing every field on the ONE merged create step');

    await step(page, 'Register — auto-login drops us on Step 1, the merged "Create your brand"', async () => {
      await registerAndVerify(page, 'demo_fill');
      await expect(page).toHaveURL(/\/onboarding\/start/);
      await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 3/i);
    });

    await announce(page, 'Step 1 of 3 — one form provisions BOTH workspace and brand');

    await step(page, 'There is NO slug input — the workspace URL is derived server-side', async () => {
      await expect(page.getByTestId('input-workspace-slug')).toHaveCount(0);
    });

    await step(page, 'Type the workspace name', async () => {
      await page.getByTestId('input-workspace-name').fill('Aurora Goods');
    });

    await step(page, 'Type the brand name', async () => {
      await page.getByTestId('input-brand-name').fill('Aurora Flagship Store');
    });

    await step(page, 'Fill the Website — a live preview shows the canonical host we will track', async () => {
      await page.getByTestId('input-brand-domain').fill('https://Aurora-Goods.example.com');
      await expect(page.getByTestId('brand-domain-preview')).toContainText('aurora-goods.example.com');
    });

    await step(page, 'Currency / timezone / revenue default to the India profile', async () => {
      await expect(page.getByTestId('select-currency-code')).toBeVisible();
      await expect(page.getByTestId('select-timezone')).toBeVisible();
      await expect(page.getByTestId('select-revenue-definition')).toBeVisible();
    });

    await step(page, 'Create — one transaction provisions both → the tracking-ready snippet', async () => {
      await page.getByTestId('btn-create-brand').click();
      await expect(page).toHaveURL(/\/onboarding\/tracking\?w=1/);
      await expect(page.getByTestId('tracking-ready-snippet')).toBeVisible({ timeout: 15_000 });
    });

    await step(page, 'Continue → Step 2 integrations → skip → Step 3 done → dashboard', async () => {
      await page.getByTestId('btn-tracking-continue').click();
      await expect(page).toHaveURL(/\/onboarding\/integrations/);
      await page
        .locator('[role="region"][aria-label^="Notifications"] li')
        .waitFor({ state: 'detached', timeout: 8_000 })
        .catch(() => undefined);
      await page.getByTestId('btn-skip-integrations').click();
      await expect(page).toHaveURL(/\/onboarding\/done/);
      await page.getByTestId('btn-go-to-dashboard').click();
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByTestId('brand-summary-card')).toBeVisible();
    });

    await pauseFor(page, 1200);
  });

  // NEGATIVE 1 — Merged step refuses an empty brand name (inline required error).
  test('Negative — empty brand name shows the required-field error', async ({ page }) => {
    await announce(page, 'Negative — empty brand name is rejected');

    await step(page, 'Register → auto-login → Step 1', async () => {
      await registerAndVerify(page, 'demo_neg_brand');
      await expect(page).toHaveURL(/\/onboarding\/start/);
    });

    await step(page, 'Fill the workspace but leave the brand name empty, then submit', async () => {
      await page.getByTestId('input-workspace-name').fill('Brandneg Workspace');
      await expect(page.getByTestId('input-brand-name')).toHaveValue('');
      await page.getByTestId('btn-create-brand').click();
    });

    await step(page, 'The required-field error appears and we stay on Step 1', async () => {
      await expect(page.getByText('Brand name is required')).toBeVisible();
      await expect(page).toHaveURL(/\/onboarding\/start/);
      await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 3/i);
    });

    await pauseFor(page, 1200);
  });

  // NEGATIVE 2 — Brand Website must look like a host. A bare word (no dot) is rejected.
  test('Negative — malformed brand Website is rejected', async ({ page }) => {
    await announce(page, 'Negative — a malformed Website is rejected');

    await step(page, 'Register → auto-login → Step 1; give the brand a valid name', async () => {
      await registerAndVerify(page, 'demo_neg_url');
      await expect(page).toHaveURL(/\/onboarding\/start/);
      await page.getByTestId('input-workspace-name').fill('Urlneg Workspace');
      await page.getByTestId('input-brand-name').fill('Urlneg Store');
    });

    await step(page, 'Type a clearly-invalid Website (no dot at all)', async () => {
      await page.getByTestId('input-brand-domain').fill('notarealurl');
    });

    await step(page, 'Submit — the "valid website" error appears and the wizard does not advance', async () => {
      await page.getByTestId('btn-create-brand').click();
      await expect(
        page.getByText('Enter a valid website (e.g. mystore.com or https://mystore.com)'),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/onboarding\/start/);
    });

    await step(page, 'Fix it with a proper host — the error clears', async () => {
      await page.getByTestId('input-brand-domain').fill('urlneg-store.example.com');
      await expect(
        page.getByText('Enter a valid website (e.g. mystore.com or https://mystore.com)'),
      ).toHaveCount(0);
    });

    await pauseFor(page, 1200);
  });

  // NEGATIVE 3 — Currency/timezone MISMATCH guard blocks submit until confirmed.
  test('Negative — currency/timezone mismatch must be confirmed before proceeding', async ({ page }) => {
    await announce(page, 'Negative — currency vs timezone mismatch guard');

    await step(page, 'Register → auto-login → Step 1; name the workspace + brand', async () => {
      await registerAndVerify(page, 'demo_mismatch');
      await expect(page).toHaveURL(/\/onboarding\/start/);
      await page.getByTestId('input-workspace-name').fill('Mismatch Workspace');
      await page.getByTestId('input-brand-name').fill('Mismatch Store');
    });

    await step(page, 'Force a mismatch: keep INR currency but switch the timezone to Asia/Dubai', async () => {
      await page.getByTestId('select-timezone').click();
      await page.getByRole('option', { name: /Asia\/Dubai/ }).click();
      await expect(page.getByTestId('select-timezone')).toContainText(/Asia\/Dubai/);
    });

    await step(page, 'Submit — a confirmation prompt blocks the mismatch', async () => {
      await page.getByTestId('btn-create-brand').click();
      await expect(page.getByText('Currency and timezone may not match')).toBeVisible();
      await expect(page.getByTestId('btn-mismatch-confirm')).toBeVisible();
      await expect(page.getByTestId('btn-mismatch-cancel')).toBeVisible();
      await expect(page.getByTestId('btn-create-brand')).toBeDisabled();
      await expect(page).toHaveURL(/\/onboarding\/start/);
    });

    await step(page, 'Choose "Go back" — the prompt clears and we stay on the form', async () => {
      await page.getByTestId('btn-mismatch-cancel').click();
      await expect(page.getByText('Currency and timezone may not match')).toHaveCount(0);
      await expect(page.getByTestId('btn-create-brand')).toBeEnabled();
      await expect(page).toHaveURL(/\/onboarding\/start/);
    });

    await pauseFor(page, 1200);
  });

  // POSITIVE 3 — Forward-only wizard: browser Back from a later step does NOT re-show
  // the created form (the fix for the live-test finding 2026-06-18).
  test('Forward-only — browser Back from a later step does not re-show the created form', async ({ page }) => {
    await announce(page, 'Forward-only wizard — Back no longer rewinds to a completed step');

    await step(page, 'Register → auto-login → complete the merged create step', async () => {
      await registerAndVerify(page, 'demo_fwd');
      await completeMergedStep(page);
      await page.getByTestId('btn-tracking-continue').click();
      await expect(page).toHaveURL(/\/onboarding\/integrations/);
    });

    await step(page, 'Press browser Back — the gate forward-redirects; the create form is gone', async () => {
      await page.goBack();
      await expect(page).not.toHaveURL(/\/onboarding\/start/);
      await expect(page).toHaveURL(/\/onboarding\/integrations/);
      await expect(page.getByTestId('input-brand-name')).toHaveCount(0);
    });

    await step(page, 'Even a direct navigation to /onboarding/start forward-redirects', async () => {
      await page.goto('/onboarding/start');
      await expect(page).toHaveURL(/\/onboarding\/integrations/);
    });

    await pauseFor(page, 1200);
  });

  // POSITIVE 4 — Soft-gate: unverified user reaches the dashboard + sees the banner.
  test('Soft-gate — unverified user reaches the dashboard with a dismissible verify banner', async ({ page }) => {
    await announce(page, 'Soft-gate — verify-email is a banner, not a wall');

    await step(page, 'Register WITHOUT verifying → finish onboarding → dashboard', async () => {
      await registerUnverified(page, 'demo_soft');
      await completeMergedStep(page);
      await page.getByTestId('btn-tracking-continue').click();
      await page.getByTestId('btn-skip-integrations').click();
      await page.getByTestId('btn-go-to-dashboard').click();
      await expect(page).toHaveURL(/\/dashboard/);
    });

    await step(page, 'A dismissible verify-email banner is shown (the funnel was NOT gated)', async () => {
      const banner = page.getByTestId('verify-email-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(/verify your email/i);
      await expectNoA11yViolations(page);
    });

    await step(page, 'Sensitive action — Connect a store shows the verify-reason hint', async () => {
      await page.goto('/settings/connectors');
      await expect(page.getByTestId('connect-verify-hint-shopify')).toContainText(/verify your email/i);
      await expect(page.getByTestId('connector-tile-shopify-connect')).toBeDisabled();
    });

    await pauseFor(page, 1200);
  });
});
