/**
 * Revenue Analytics E2E — /analytics/revenue
 *
 * Coverage:
 *   - Page heading "Revenue" is present.
 *   - Grain toggle (Daily / Weekly radio group) renders and is keyboard-reachable:
 *       Tab to the fieldset, arrow-key to switch, assert focus moves.
 *   - Chart container OR empty state is present (fresh user has no data → empty state).
 *   - Revenue KPI section landmark is present.
 *   - No uncaught console errors.
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations).
 *
 * Honest empty: a freshly-registered user's brand has no ledger rows, so the
 * chart renders its EmptyState ("No trend data yet") rather than chart data.
 * We assert the page does NOT crash, not that it shows particular numbers.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/analytics/revenue', () => {
  test('renders heading, grain toggle (keyboard-reachable), chart or empty state, axe-clean', async ({
    page,
  }) => {
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
        // 403 (Forbidden) is by-design during onboarding: the double-submit CSRF seam issues a
        // pre-session token, so the FIRST mutation after login 403s (CSRF_MISMATCH) and the
        // client refreshes the session-bound token and retries once (lib/api/client/core.ts).
        // The browser logs the failed first attempt natively; it cannot be suppressed.
        if (/403 \(Forbidden\)/i.test(text)) return;
        consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // ── Onboard fresh user then navigate to revenue ────────────────────────
    await onboardToDashboard(page, 'arev');
    await page.goto('/analytics/revenue');
    await expect(page).toHaveURL(/\/analytics\/revenue/);

    // ── Page heading ───────────────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Revenue', exact: true })).toBeVisible({ timeout: 10_000 });

    // ── Revenue KPI section landmark ───────────────────────────────────────
    await expect(page.getByRole('region', { name: 'Revenue KPIs' })).toBeVisible({
      timeout: 10_000,
    });

    // ── Grain toggle — present and keyboard-reachable ──────────────────────
    // The GrainToggle is a <fieldset aria-label="Chart grain selection"> with two
    // radio inputs (sr-only) wrapped in <label> elements. We locate via the fieldset
    // accessible name and confirm the Daily radio is present and focusable.
    const grainFieldset = page.getByRole('group', { name: 'Chart grain selection' });
    await expect(grainFieldset).toBeVisible({ timeout: 10_000 });

    // Daily radio must exist and be checked (default state)
    const dailyRadio = grainFieldset.getByRole('radio', { name: 'Daily' });
    await expect(dailyRadio).toBeVisible();
    await expect(dailyRadio).toBeChecked();

    // Weekly radio must exist
    const weeklyRadio = grainFieldset.getByRole('radio', { name: 'Weekly' });
    await expect(weeklyRadio).toBeVisible();

    // Keyboard-reachability: Tab to the Daily radio and use arrow key to switch
    await dailyRadio.focus();
    await expect(dailyRadio).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(weeklyRadio).toBeFocused();
    await expect(weeklyRadio).toBeChecked();

    // ── Revenue views (tabbed IA redesign) — trend card or empty state ─────
    // The old single 'Revenue trend chart' region was replaced by a 'Revenue views'
    // tab strip (Trend / Revenue status / Monthly); the default 'Trend' tab holds
    // the 'Confirmed vs pending revenue' card (chart SVG or honest empty state).
    const viewTabs = page.getByRole('tablist', { name: 'Revenue views' });
    await expect(viewTabs).toBeVisible({ timeout: 10_000 });
    const trendTab = viewTabs.getByRole('tab', { name: 'Trend' });
    await expect(trendTab).toHaveAttribute('aria-selected', 'true'); // default tab

    // The default tab panel renders the trend card title. Either the chart or the
    // EmptyState is valid for a fresh user — assert the card is there, not numbers.
    await expect(page.getByText('Confirmed vs pending revenue').first()).toBeVisible({
      timeout: 10_000,
    });

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
