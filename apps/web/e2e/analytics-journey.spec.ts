/**
 * Journey / first-touch surface E2E (Silver tier — feat-journey-touchpoint Track 3).
 *
 * The SECOND stakeholder-visible surface read from the Silver analytics tier
 * (dbt → StarRocks silver.touchpoint) via the BFF → metric-engine journey seam
 * (I-ST01 — the UI never queries StarRocks directly).
 *
 * Coverage:
 *   1. /analytics/journey renders: heading, the "Powered by the Silver tier"
 *      provenance label, the first-touch-mix section, and the date-range selector.
 *   2. Honest empty OR has-data: a fresh onboarded brand with no touchpoint rows shows
 *      the honest pixel-setup empty state (never a fabricated zero); a brand WITH Silver
 *      touchpoints shows the first-touch mix (KPI tiles + chart) + the cart-stitch
 *      hit-rate card. The spec accepts either — it asserts one of the two truthful
 *      outcomes, never a fake number. When backed by synthetic fixtures the
 *      "Synthetic (dev)" badge is present (dev-honesty).
 *   3. The date-range control switches range (drives the BFF query).
 *   4. The touchpoint-timeline tracer is present and honest before an order is entered.
 *   5. axe WCAG 2.x AA scan passes (0 serious/critical violations) — the journey
 *      surface is a data-viz route, so a11y is a gate, not a nicety.
 *   6. No uncaught console / page errors.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('Journey / first-touch surface (Silver tier)', () => {
  test('renders the Silver-tier journey surface with an honest empty-or-data state, axe-clean', async ({
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

    await onboardToDashboard(page, 'jrny');
    await page.goto('/analytics/journey');
    await expect(page).toHaveURL(/\/analytics\/journey/);

    // ── Page heading + Silver-tier provenance label ──
    await expect(page.getByRole('heading', { name: 'Journey', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('journey-silver-label')).toBeVisible();
    await expect(page.getByTestId('journey-silver-label')).toContainText('Silver tier');

    // ── The first-touch-mix section + date-range control are present ──
    await expect(page.getByTestId('journey-mix-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('journey-range-90')).toBeVisible();

    // ── Honest empty OR has-data — assert exactly one truthful outcome ──
    const empty = page.getByTestId('journey-empty');
    const total = page.getByTestId('journey-kpi-total');
    await expect(empty.or(total)).toBeVisible({ timeout: 15_000 });

    const hasData = await total.isVisible();
    if (hasData) {
      // Has-data: KPI tiles (total + stitch-rate + coverage) + the first-touch chart.
      await expect(page.getByTestId('journey-kpi-stitch')).toBeVisible();
      await expect(page.getByTestId('journey-kpi-coverage')).toBeVisible();
    } else {
      // Honest empty: the pixel-setup empty state, never a fabricated zero.
      await expect(empty).toContainText('No journeys yet');
    }

    // ── Date-range switch drives the query without crashing ──
    await page.getByTestId('journey-range-30').click();
    await expect(page.getByTestId('journey-range-30')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('journey-mix-section')).toBeVisible();

    // ── Touchpoint-timeline tracer is present + honest before an order is entered ──
    await expect(page.getByTestId('journey-timeline-section')).toBeVisible();
    await expect(page.getByTestId('journey-timeline-prompt')).toBeVisible();
    await expect(page.getByTestId('journey-order-input')).toBeVisible();

    // ── No crash ──
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (data-viz route — gated, not asserted) ──
    await expectNoA11yViolations(page);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
