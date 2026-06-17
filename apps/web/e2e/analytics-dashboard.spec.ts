/**
 * Analytics Dashboard E2E — /dashboard (upgraded Phase 1 analytics shell)
 *
 * Coverage:
 *   - Page loads without a page error or uncaught JS exception.
 *   - KPI region is present in the DOM (5 tiles: kpi-realized, kpi-provisional,
 *     kpi-orders, kpi-aov, kpi-rto-rate).
 *   - Section headings ("Key performance indicators", "Revenue trends…",
 *     "Recent activity…") are reachable.
 *   - ConnectionStatusCard is present.
 *   - Honest empty/no-data path renders without a crash (fresh user has no
 *     ledger data — state:'no_data' is the truthful result).
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations).
 *
 * Architecture: fresh user per spec (registerAndVerify + onboardToDashboard),
 * console errors captured via page.on('console'/'pageerror'), mirrors
 * dashboard.spec.ts structure.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/dashboard — analytics shell', () => {
  /**
   * Shared setup: one fresh user + brand per describe block.
   * We navigate to /dashboard once and run structural + a11y assertions together
   * to avoid a second full onboard flow.
   */
  test('renders KPI tiles, section landmarks, ConnectionStatusCard, and is axe-clean', async ({
    page,
  }) => {
    // ── Collect console errors (filter noise) ──────────────────────────────
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Filter known harmless third-party / Next.js dev noise
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

    // ── Full onboarding (fresh brand, no ledger data) ──────────────────────
    await onboardToDashboard(page, 'adash');

    // ── Confirm we are on /dashboard ───────────────────────────────────────
    await expect(page).toHaveURL(/\/dashboard/);

    // ── Page heading ───────────────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10_000 });

    // ── KPI tiles — all five must be present (loading skeleton or no-data) ─
    // The tiles render even in the no-data state (they show "No data yet")
    // so we wait for them to appear (loading completes) then assert presence.
    await expect(page.getByTestId('kpi-realized')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('kpi-provisional')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('kpi-orders')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('kpi-aov')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('kpi-rto-rate')).toBeVisible({ timeout: 10_000 });

    // ── Section landmarks (aria-label) ─────────────────────────────────────
    await expect(
      page.getByRole('region', { name: 'Key performance indicators' }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole('region', { name: 'Revenue trends and recognition' }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole('region', { name: 'Recent activity and connection status' }),
    ).toBeVisible({ timeout: 10_000 });

    // ── ConnectionStatusCard ───────────────────────────────────────────────
    // Fresh user has no connector — card renders the "No Data Yet" empty state
    await expect(page.getByTestId('connection-status-card')).toBeVisible({ timeout: 10_000 });

    // ── Honest empty-state path: no crash, body visible ───────────────────
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (serious + critical violations must be 0) ───────────────
    await expectNoA11yViolations(page);

    // ── Console errors must be empty ──────────────────────────────────────
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(
      consoleErrors,
      `Console errors:\n${consoleErrors.join('\n')}`,
    ).toHaveLength(0);
  });
});
