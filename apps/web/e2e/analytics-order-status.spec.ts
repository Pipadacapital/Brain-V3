/**
 * Order-status mix surface E2E (Silver tier — feat-silver-tier-order-state Track 3).
 *
 * The FIRST stakeholder-visible surface read from the Silver analytics tier
 * (dbt → StarRocks silver.order_state) via the BFF → metric-engine Silver seam
 * (I-ST01 — the UI never queries StarRocks directly).
 *
 * Coverage:
 *   1. /analytics/order-status renders: heading, the "Powered by the Silver tier"
 *      provenance label, the status-breakdown section, and the date-range selector.
 *   2. Honest empty OR has-data: a fresh onboarded brand with no order rows shows the
 *      honest connect-CTA empty state (never a fabricated zero); a brand WITH Silver
 *      rows shows the status breakdown (KPI tiles + chart) instead. The spec accepts
 *      either — it asserts one of the two truthful outcomes, never a fake number.
 *   3. The date-range control switches range (drives the BFF query).
 *   4. axe WCAG 2.x AA scan passes (0 serious/critical violations) — the breakdown
 *      surface is a data-viz route, so a11y is a gate, not a nicety.
 *   5. No uncaught console / page errors.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('Order-status mix surface (Silver tier)', () => {
  test('renders the Silver-tier order-status surface with an honest empty-or-data state, axe-clean', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          text.includes('Failed to load resource') &&
          (text.includes('favicon') || text.includes('hot-update'))
        ) {
          return;
        }
        consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await onboardToDashboard(page, 'ordst');
    await page.goto('/analytics/order-status');
    await expect(page).toHaveURL(/\/analytics\/order-status/);

    // ── Page heading + Silver-tier provenance label ──
    await expect(page.getByRole('heading', { name: 'Order Status', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('order-status-silver-label')).toBeVisible();
    await expect(page.getByTestId('order-status-silver-label')).toContainText('Silver tier');

    // ── The status-breakdown section + date-range control are present ──
    await expect(page.getByTestId('order-status-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('order-status-range-90')).toBeVisible();

    // ── Honest empty OR has-data — assert exactly one truthful outcome ──
    const empty = page.getByTestId('order-status-empty');
    const total = page.getByTestId('order-status-kpi-total');
    await expect(empty.or(total)).toBeVisible({ timeout: 15_000 });

    const hasData = await total.isVisible();
    if (hasData) {
      // Has-data: the KPI tiles + the status-mix chart render (counts/share by state).
      await expect(page.getByTestId('order-status-kpi-terminal')).toBeVisible();
      await expect(page.getByTestId('order-status-kpi-delivered')).toBeVisible();
    } else {
      // Honest empty: the connect-CTA empty state, never a fabricated zero.
      await expect(empty).toContainText('No order data yet');
    }

    // ── Date-range switch drives the query without crashing ──
    await page.getByTestId('order-status-range-30').click();
    await expect(page.getByTestId('order-status-range-30')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('order-status-section')).toBeVisible();

    // ── No crash ──
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (data-viz route — gated, not asserted) ──
    await expectNoA11yViolations(page);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
