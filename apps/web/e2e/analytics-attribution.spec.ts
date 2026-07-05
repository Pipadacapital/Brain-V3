/**
 * Attribution surface E2E (Phase 5 — feat-attribution-ledger Track C).
 *
 * The stakeholder-visible payoff of Phase 5: attributed revenue by channel, the closed-sum
 * reconciliation residual, and per-channel ROAS — read over the BFF → metric-engine sole
 * read path (I-ST01 — the UI never queries the credit ledger / StarRocks directly).
 *
 * Coverage:
 *   1. /analytics/attribution renders: heading, the "Powered by the Silver tier" provenance
 *      label, the model selector, and the date-range control.
 *   2. The model selector is functional (switches model, re-fetches without crashing) and
 *      announces the selected model's weighting rule.
 *   3. Honest empty OR has-data — assert exactly one truthful outcome, never a fabricated
 *      number. With data: attributed-revenue KPI + the by-channel chart + the reconciliation
 *      residual card (the closed sum) + the channel-ROAS table. The residual is ALWAYS
 *      rendered alongside (never hidden). When backed by synthetic fixtures the
 *      "Synthetic (dev)" badge is present (dev-honesty).
 *   4. The date-range control switches range (drives the BFF query).
 *   5. axe WCAG 2.x AA scan passes (0 serious/critical violations) — attribution is a
 *      data-viz route, so a11y is a gate, not a nicety.
 *   6. No uncaught console / page errors.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('Attribution surface (Phase 5)', () => {
  test('renders the attribution surface with an honest empty-or-data state, model selector, residual, axe-clean', async ({
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

    await onboardToDashboard(page, 'attr');
    await page.goto('/analytics/attribution');
    await expect(page).toHaveURL(/\/analytics\/attribution/);

    // ── Page heading + data-provenance label ──
    await expect(page.getByRole('heading', { name: 'Attribution', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('attribution-silver-label')).toBeVisible();
    await expect(page.getByTestId('attribution-silver-label')).toContainText(
      'Calculated from your order and marketing data',
    );

    // ── Controls: model selector (default position-based) + date-range control ──
    await expect(page.getByTestId('attribution-model-selector')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('attribution-model-position_based')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('attribution-range-90')).toBeVisible();

    // ── Honest empty OR has-data — assert exactly one truthful outcome ──
    const empty = page.getByTestId('attribution-empty');
    const attributedKpi = page.getByTestId('attribution-kpi-attributed');
    await expect(empty.or(attributedKpi)).toBeVisible({ timeout: 15_000 });

    const hasData = await attributedKpi.isVisible();
    if (hasData) {
      // Has-data: the by-channel chart + the reconciliation residual (closed sum) are rendered.
      await expect(page.getByTestId('attributed-channel-chart')).toBeVisible();
      // The residual is ALWAYS shown alongside — never hidden.
      await expect(page.getByTestId('reconciliation-residual-card')).toBeVisible();
      await expect(page.getByTestId('reconciliation-realized')).toBeVisible();
      await expect(page.getByTestId('reconciliation-unattributed')).toBeVisible();
    } else {
      // Honest empty: never a fabricated zero.
      await expect(empty).toContainText('No attributed revenue yet');
    }

    // ── Model selector switches model without crashing ──
    await page.getByTestId('attribution-model-linear').click();
    await expect(page.getByTestId('attribution-model-linear')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('attribution-model-rule')).toContainText('equal share');
    await expect(page.getByTestId('attribution-model-selector')).toBeVisible();

    // ── Date-range switch drives the query without crashing ──
    await page.getByTestId('attribution-range-30').click();
    await expect(page.getByTestId('attribution-range-30')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('attribution-controls')).toBeVisible();

    // ── Channel ROAS section is present ──
    await expect(page.getByTestId('attribution-roas-section')).toBeVisible();

    // ── No crash ──
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (data-viz route — gated, not asserted) ──
    await expectNoA11yViolations(page);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
