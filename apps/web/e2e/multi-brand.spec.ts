import { test, expect, type Page } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';

/**
 * Multi-brand create → switch E2E. Real browser → BFF → Postgres.
 *
 * Regression guard for the create→switch SEAM (the chain server-side tests missed):
 * core `POST /v1/brands` returns `{ request_id, brand: {...} }`, so `brandApi.create`
 * MUST unwrap `.brand`. When it didn't, `newBrand.id` was undefined → the dialog called
 * `switchBrand(undefined)` → `JSON.stringify({ brand_id: undefined })` === '{}' →
 * backend 400 MISSING_BRAND_ID. These tests drive the actual UI chain end-to-end.
 */

const UUID_IN_BODY = /"brand_id"\s*:\s*"[0-9a-f-]{36}"/i;

/** Open the switcher, launch the create dialog, fill the name, submit. Returns the name. */
async function createBrandFromSwitcher(page: Page, name: string): Promise<void> {
  await page.getByTestId('brand-switcher-toggle').click();
  await page.getByTestId('btn-create-brand-cta').click();

  await expect(page.getByTestId('create-brand-dialog')).toBeVisible();
  // Only the name is required — currency/timezone/revenue default to INR/Asia-Kolkata/realized.
  await page.getByTestId('input-dialog-brand-name').fill(name);

  // The create→switch chain must POST a real brand_id and get 200 (not the empty {} → 400 the bug produced).
  const setBrand = page.waitForResponse(
    (res) => res.url().includes('/v1/bff/session/set-brand') && res.request().method() === 'POST',
  );
  await page.getByTestId('btn-create-brand-dialog-submit').click();

  const res = await setBrand;
  expect(res.status(), 'set-brand after create must be 200, not 400 MISSING_BRAND_ID').toBe(200);
  expect(res.request().postData() ?? '', 'set-brand body must carry a real brand_id, not {}').toMatch(
    UUID_IN_BODY,
  );
}

/** Active brand name as shown on the switcher toggle's aria-label. */
function activeBrandLabel(name: string): RegExp {
  return new RegExp(`Active brand: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

test('creating a second brand from the dashboard switcher makes it the active brand', async ({ page }) => {
  await onboardToDashboard(page, 'cswitch');

  const second = `Second Brand ${Date.now()}`;
  await createBrandFromSwitcher(page, second);

  // After create→switch→reload: back on /dashboard, dialog gone, new brand active.
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('create-brand-dialog')).toBeHidden();
  await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute('aria-label', activeBrandLabel(second));
});

test('after creating a second brand, switching back to the first brand works (plain set-brand)', async ({ page }) => {
  await onboardToDashboard(page, 'swback'); // onboarding creates brand "E2E Brand"

  const second = `Second Brand ${Date.now()}`;
  await createBrandFromSwitcher(page, second);
  await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute('aria-label', activeBrandLabel(second));

  // Now switch back to the original brand via its row select button.
  await page.getByTestId('brand-switcher-toggle').click();
  const switchBack = page.waitForResponse(
    (res) => res.url().includes('/v1/bff/session/set-brand') && res.request().method() === 'POST',
  );
  await page.getByLabel('Switch to brand E2E Brand').click();
  const res = await switchBack;
  expect(res.status()).toBe(200);

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute('aria-label', activeBrandLabel('E2E Brand'));
});
