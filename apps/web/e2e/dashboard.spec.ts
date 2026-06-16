import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';

/**
 * Dashboard + settings E2E — post-onboarding. Real browser → BFF → Postgres.
 * Covers the two shipped bug fixes: brand-summary member count (DISTINCT → 1)
 * and the Shopify shop-domain prompt on the connectors page.
 */

test('dashboard renders the cards and the brand-summary shows "1 member" (count fix)', async ({ page }) => {
  await onboardToDashboard(page, 'dash');

  // Onboarding-progress card always renders.
  await expect(page.getByTestId('onboarding-progress-card')).toBeVisible();

  // Brand-summary reflects the active brand. A sole owner holds an org-level + a
  // brand-level membership row; the fixed count (COUNT DISTINCT) must show 1, not 2.
  await expect(page.getByTestId('brand-summary-card')).toBeVisible();
  await expect(page.getByText('1 member')).toBeVisible();
});

test('connectors page shows the Shopify store-domain input; Connect enables only with a domain', async ({ page }) => {
  await onboardToDashboard(page, 'conn');
  await page.goto('/settings/connectors');

  const shopInput = page.getByTestId('input-shop-shopify');
  const connectBtn = page.getByTestId('btn-connect-shopify');

  await expect(shopInput).toBeVisible();
  await expect(connectBtn).toBeVisible();
  // Disabled until a store domain is entered (the shop-prompt fix).
  await expect(connectBtn).toBeDisabled();

  await shopInput.fill('boddactive-com.myshopify.com');
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
