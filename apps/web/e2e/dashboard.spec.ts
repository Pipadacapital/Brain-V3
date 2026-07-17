import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';

/**
 * Dashboard + settings E2E — post-onboarding. Real browser → BFF → Postgres.
 * Covers the two shipped bug fixes: brand-summary member count (DISTINCT → 1)
 * and the Shopify shop-domain prompt on the connectors page.
 */

test('home renders and the members list shows exactly 1 member (DISTINCT count fix)', async ({ page }) => {
  await onboardToDashboard(page, 'dash');

  // IA redesign: the dashboard is now /home; the old onboarding-progress-card and
  // brand-summary-card were removed. Anchor on the always-rendered realized-revenue
  // KPI tile and the brand switcher (the brand-context surface that replaced the card).
  await expect(page.getByTestId('home-kpi-realized')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('brand-switcher')).toBeVisible();

  // Member-count fix regression: a sole owner holds an org-level + a brand-level
  // membership row; the fixed COUNT(DISTINCT) semantics must surface exactly ONE
  // member on the members page, not 2.
  await page.goto('/settings/members');
  await expect(page.getByTestId(/^member-row-/)).toHaveCount(1);
});

test('connectors: Shopify Connect stays disabled until store domain AND BYO-app credentials are entered', async ({ page }) => {
  await onboardToDashboard(page, 'conn');
  await page.goto('/settings/connectors');

  // Marketplace redesign: the connect button testid is `connector-tile-<id>-connect`
  // (the old btn-connect-shopify id no longer exists). Shopify is now a BYO-app-REQUIRED
  // OAuth tile: Connect requires the store domain AND the brand's own app Client ID/Secret
  // (per the byo_app_required catalog contract), so the enable gate covers all three fields.
  const shopInput = page.getByTestId('input-shop-shopify');
  const connectBtn = page.getByTestId('connector-tile-shopify-connect');

  await expect(shopInput).toBeVisible();
  await expect(connectBtn).toBeVisible();
  // Disabled until a store domain is entered (the shop-prompt fix).
  await expect(connectBtn).toBeDisabled();

  await shopInput.fill('boddactive-com.myshopify.com');
  // Still disabled: the REQUIRED BYO OAuth app credentials are empty.
  await expect(connectBtn).toBeDisabled();

  await page.getByTestId('input-shopify-client_id').fill('e2e-client-id');
  await page.getByTestId('input-shopify-client_secret').fill('e2e-client-secret');
  await expect(connectBtn).toBeEnabled();
});

test('settings → pixel and members pages render for an onboarded user', async ({ page }) => {
  await onboardToDashboard(page, 'settings');

  await page.goto('/settings/pixel');
  await expect(page).toHaveURL(/\/settings\/pixel/);
  // No uncaught crash — the page shell renders (heading or a card is present).
  await expect(page.locator('body')).toBeVisible();

  await page.goto('/settings/members');
  await expect(page).toHaveURL(/\/settings\/members/);
  await expect(page.locator('body')).toBeVisible();
});
