/**
 * customer-360.spec.ts — the Customer-360 Gold endpoint, end-to-end in the browser (Phase E).
 *
 * Onboards a fresh brand, then calls the new /api/v1/dashboard/customer-360 BFF endpoint through the
 * authenticated page context. A brand-new brand has no Gold customers yet, so the contract is an
 * HONEST no_data (200, never a 500) — proving the gold_customer_360 → metric-engine seam → BFF path
 * is wired and fails safely. (Populated-data assertions are covered by the metric-engine live test.)
 */
import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';

test('GET /api/v1/dashboard/customer-360 returns honest no_data for a fresh brand (Gold seam wired)', async ({ page }) => {
  await onboardToDashboard(page, 'c360');

  const res = await page.request.get('/api/v1/dashboard/customer-360');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data?.state).toBe('no_data');
});
