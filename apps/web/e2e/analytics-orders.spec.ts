/**
 * Orders Analytics E2E — /analytics/orders
 *
 * Coverage:
 *   - Page heading "Orders" is present.
 *   - Order KPI section landmark present with three KPI tiles
 *     (orders-kpi-count, orders-kpi-aov, orders-kpi-rto).
 *   - OrdersTrendChart container is present (chart SVG OR EmptyState for no-data).
 *   - Honest empty path: fresh user has no order data — no crash, empty-state visible.
 *   - No uncaught console errors.
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations).
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/analytics/orders', () => {
  test('renders heading, KPI tiles, chart or empty state, axe-clean', async ({ page }) => {
    // ── Collect console errors ─────────────────────────────────────────────
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          text.includes('Failed to load resource') &&
          (text.includes('favicon') || text.includes('hot-update'))
        )
          return;
        consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // ── Onboard fresh user then navigate to orders ─────────────────────────
    await onboardToDashboard(page, 'aord');
    await page.goto('/analytics/orders');
    await expect(page).toHaveURL(/\/analytics\/orders/);

    // ── Page heading ───────────────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible({ timeout: 10_000 });

    // ── Order KPI section ─────────────────────────────────────────────────
    // The section is aria-label="Order KPIs" — this renders even in no-data state
    // because the stats hook resolves quickly (empty response, not error).
    // We give extra time for the client-side query to settle.
    await expect(page.getByRole('region', { name: 'Order KPIs' })).toBeVisible({ timeout: 15_000 });

    // Individual KPI tiles
    await expect(page.getByTestId('orders-kpi-count')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('orders-kpi-aov')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('orders-kpi-rto')).toBeVisible({ timeout: 10_000 });

    // ── Orders trend chart section ─────────────────────────────────────────
    const trendSection = page.getByRole('region', { name: 'Orders trend chart' });
    await expect(trendSection).toBeVisible({ timeout: 10_000 });

    // Content must be non-empty (chart SVG or EmptyState)
    await expect(trendSection.locator('*')).not.toHaveCount(0);

    // ── No crash ──────────────────────────────────────────────────────────
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate ─────────────────────────────────────────────────────────
    await expectNoA11yViolations(page);

    // ── Console error assertions ──────────────────────────────────────────
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(
      consoleErrors,
      `Console errors:\n${consoleErrors.join('\n')}`,
    ).toHaveLength(0);
  });
});
