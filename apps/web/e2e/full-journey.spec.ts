import { test, expect } from '@playwright/test';

/**
 * FULL APPLICATION JOURNEY — one watchable end-to-end pass through the whole product.
 * Real browser → BFF → Postgres. Run HEADED with slow-motion to watch it:
 *
 *   cd apps/web
 *   PW_SLOWMO=700 DATABASE_URL=postgres://brain:brain@localhost:5432/brain \
 *     npx playwright test e2e/full-journey.spec.ts --headed --project=chromium
 *
 * Covers: register → dev-verify → login → 4-step onboarding → dashboard →
 * multi-brand create + switch → connectors → members → pixel → logout.
 * (Members step is a light page-load so it stays stable while that feature is in flight.)
 */

test('full application journey — register to logout, the whole app', async ({ page }) => {
  const stamp = Date.now();
  const email = `journey_${stamp}@example.com`;
  const password = 'SuperSecret123!';

  await test.step('1 · Register a new account', async () => {
    await page.goto('/register');
    await page.getByTestId('input-full-name').fill('Journey Tester');
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill(password);
    await page.getByTestId('btn-register').click();
    await expect(page).toHaveURL(/\/verify-email/);
  });

  await test.step('2 · Verify email (dev one-click) → sign in', async () => {
    // Dev-only shortcut — no real inbox needed; the backend captured the token.
    await page.getByTestId('btn-dev-verify-now').click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill(password);
    await page.getByTestId('btn-login').click();
    await expect(page).toHaveURL(/\/workspace\/new/);
    await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 4/i);
  });

  await test.step('3 · Onboarding Step 1 — create workspace', async () => {
    await page.getByTestId('input-workspace-name').fill('Journey Workspace');
    await page.getByTestId('input-workspace-slug').fill(`journey-ws-${stamp}`);
    await page.getByTestId('btn-create-workspace').click();
    await expect(page).toHaveURL(/\/brand\/new/);
  });

  await test.step('4 · Onboarding Step 2 — create brand (INR / Asia-Kolkata defaults)', async () => {
    await page.getByTestId('input-brand-name').fill('Journey Brand');
    await expect(page.getByTestId('select-currency-code')).toBeVisible();
    await page.getByTestId('btn-create-brand').click();
    await expect(page).toHaveURL(/\/onboarding\/integrations/);
  });

  await test.step('5 · Onboarding Step 3 — skip integrations', async () => {
    await page.getByTestId('btn-skip-integrations').click();
    await expect(page).toHaveURL(/\/onboarding\/done/);
  });

  await test.step('6 · Onboarding Step 4 — enter the dashboard', async () => {
    await page.getByTestId('btn-go-to-dashboard').click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('brand-summary-card')).toBeVisible();
    await expect(page.getByText('1 member')).toBeVisible();
  });

  await test.step('7 · Multi-brand — create a second brand from the switcher', async () => {
    const second = `Journey Brand 2 ${stamp}`;
    await page.getByTestId('brand-switcher-toggle').click();
    await page.getByTestId('btn-create-brand-cta').click();
    await expect(page.getByTestId('create-brand-dialog')).toBeVisible();
    await page.getByTestId('input-dialog-brand-name').fill(second);
    await page.getByTestId('btn-create-brand-dialog-submit').click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      new RegExp(`Active brand: ${second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  await test.step('8 · Switch back to the first brand', async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    await page.getByLabel('Switch to brand Journey Brand').click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      /Active brand: Journey Brand/,
    );
  });

  await test.step('9 · Connectors — Shopify store-domain prompt', async () => {
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('input-shop-shopify')).toBeVisible();
    await expect(page.getByTestId('connector-tile-shopify-connect')).toBeVisible();
  });

  await test.step('10 · Members / team page renders', async () => {
    await page.goto('/settings/members');
    await expect(page.getByRole('heading', { name: /team members/i })).toBeVisible();
  });

  await test.step('11 · Pixel settings page renders', async () => {
    await page.goto('/settings/pixel');
    await expect(page).toHaveURL(/\/settings\/pixel/);
    await expect(page.locator('body')).toBeVisible();
  });

  await test.step('12 · Log out', async () => {
    await page.goto('/dashboard');
    await page.getByTestId('btn-logout').click();
    await expect(page).toHaveURL(/\/login/);
  });
});
