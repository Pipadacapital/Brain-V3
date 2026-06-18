/**
 * CoD / RTO surface + GoKwik/Shopflo connectability E2E (Track C).
 *
 * Coverage:
 *   1. Marketplace: GoKwik + Shopflo tiles render as connectable (credential connect
 *      flow) with their provider-specific credential fields (NOT Razorpay's fields).
 *   2. /analytics/cod-rto renders the three sections (RTO by pincode, CoD mix/CM2,
 *      checkout funnel) with honest empty states for a fresh brand (no fabricated zeros).
 *   3. The "Synthetic (dev)" label is present on the CoD mix section (always synthetic
 *      in dev) — DEV-HONESTY proof that synthetic data is never presented as live.
 *   4. axe WCAG 2.x AA scan passes (0 serious/critical violations).
 *   5. No uncaught console / page errors.
 *
 * Honest-empty posture: a fresh onboarded brand has no GoKwik/Shopflo data, so each
 * section shows its connect-CTA empty state. The synthetic badge on the CoD-mix section
 * renders regardless (it labels the surface's data provenance, shown beside the heading).
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('CoD / RTO surface + GoKwik/Shopflo connectors', () => {
  test('GoKwik + Shopflo tiles are connectable with provider-specific credential fields', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('Failed to load resource') && (text.includes('favicon') || text.includes('hot-update'))) return;
        consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await onboardToDashboard(page, 'codrc');
    await page.goto('/settings/connectors');
    await expect(page).toHaveURL(/\/settings\/connectors/);

    // ── Shopflo tile is connectable (credential form, provider-specific fields) ──
    const shopfloTile = page.getByTestId('connector-tile-shopflo');
    await expect(shopfloTile).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('credential-form-shopflo')).toBeVisible();
    // Shopflo-specific fields — NOT Razorpay's key_id/key_secret.
    await expect(page.getByTestId('input-shopflo-api_token')).toBeVisible();
    await expect(page.getByTestId('input-shopflo-merchant_id')).toBeVisible();
    await expect(page.getByTestId('input-shopflo-webhook_secret')).toBeVisible();
    // Secret fields are password-typed (never read back).
    await expect(page.getByTestId('input-shopflo-api_token')).toHaveAttribute('type', 'password');
    // Connect button present (disabled until creds entered).
    await expect(page.getByTestId('connector-tile-shopflo-connect')).toBeVisible();
    await expect(page.getByTestId('connector-tile-shopflo-connect')).toBeDisabled();

    // ── GoKwik tile is connectable (appid/appsecret) ──
    const gokwikTile = page.getByTestId('connector-tile-gokwik');
    await expect(gokwikTile).toBeVisible();
    await expect(page.getByTestId('credential-form-gokwik')).toBeVisible();
    await expect(page.getByTestId('input-gokwik-appid')).toBeVisible();
    await expect(page.getByTestId('input-gokwik-appsecret')).toBeVisible();
    await expect(page.getByTestId('input-gokwik-appsecret')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('connector-tile-gokwik-connect')).toBeVisible();

    // Fill GoKwik creds → connect button enables (no Razorpay fields required).
    await page.getByTestId('input-gokwik-appid').fill('app_e2e_test');
    await page.getByTestId('input-gokwik-appsecret').fill('secret_e2e_test');
    await expect(page.getByTestId('connector-tile-gokwik-connect')).toBeEnabled();

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });

  test('CoD/RTO surface renders three sections, honest empties, synthetic label, axe-clean', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('Failed to load resource') && (text.includes('favicon') || text.includes('hot-update'))) return;
        consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await onboardToDashboard(page, 'codrs');
    await page.goto('/analytics/cod-rto');
    await expect(page).toHaveURL(/\/analytics\/cod-rto/);

    // ── Page heading ──
    await expect(page.getByRole('heading', { name: 'CoD / RTO', exact: true })).toBeVisible({ timeout: 10_000 });

    // ── Three sections present ──
    await expect(page.getByTestId('cod-rto-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('cod-mix-section')).toBeVisible();
    await expect(page.getByTestId('checkout-funnel-section')).toBeVisible();

    // ── Honest empty states for a fresh brand (no fabricated zeros) ──
    await expect(page.getByTestId('cod-rto-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('cod-mix-empty')).toBeVisible();
    await expect(page.getByTestId('checkout-funnel-empty')).toBeVisible();

    // ── Synthetic (dev) label present (DEV-HONESTY) ──
    // The CoD-mix section labels its provenance beside the heading regardless of data state.
    await expect(page.getByTestId('cod-mix-synthetic-badge')).toBeVisible();
    await expect(page.getByTestId('cod-mix-synthetic-badge')).toContainText('Synthetic (dev)');

    // ── No crash ──
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate ──
    await expectNoA11yViolations(page);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
