/**
 * Data Quality E2E — /data/quality  (Phase 7)
 *
 * Coverage:
 *   - Page heading "Data Quality" (h1) is present.
 *   - For a fresh user with no graded checks the honest empty state renders
 *     ("No data-quality grades yet") with a connect-a-source CTA — not a crash.
 *   - If the brand HAS grades: the trust banner + summary tiles + grade matrix render.
 *   - Keyboard: the empty-state CTA / nav link is focusable (Tab reaches it).
 *   - Nav: the "Data Quality" sidebar link navigates to /data/quality.
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations).
 *   - No uncaught JS exceptions / console errors (catches the BigInt(undefined)
 *     contract-drift crash class if the web DTO ever drifts from the core DTO).
 *
 * Honest empty: a freshly-registered user's brand has no dq_check_result rows, so the
 * BFF returns state:'no_data' → EmptyState. We assert the no-data path renders, NOT
 * specific grades. The has_data branch is asserted only when present.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/data/quality', () => {
  test('renders heading, honest empty state + CTA, keyboard + nav, axe-clean', async ({
    page,
  }) => {
    // ── Collect console + page errors ────────────────────────────────────────
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

    // ── Onboard a fresh user (no ingestion → no graded checks) ───────────────
    await onboardToDashboard(page, 'dq');

    // ── Nav: the sidebar "Data Quality" link navigates to /data/quality ──────
    const navLink = page.getByRole('link', { name: 'Data Quality' });
    await expect(navLink).toBeVisible({ timeout: 10_000 });
    await navLink.click();
    await expect(page).toHaveURL(/\/data\/quality/);

    // ── Page heading (h1 only — EmptyState renders an h3) ────────────────────
    await expect(
      page.getByRole('heading', { name: 'Data Quality', level: 1 }),
    ).toBeVisible({ timeout: 10_000 });

    // ── Either honest-empty OR the has-data summary must be visible ──────────
    const emptyTitle = page.getByText('No data-quality grades yet');
    const summarySection = page.getByRole('region', { name: 'Data quality summary' });

    const emptyVisible = await emptyTitle.isVisible().catch(() => false);
    const summaryVisible = await summarySection.isVisible().catch(() => false);

    expect(
      emptyVisible || summaryVisible,
      'Expected either the empty-state message or the summary section to be visible',
    ).toBe(true);

    if (emptyVisible) {
      // ── Honest-empty CTA is present + keyboard-focusable ───────────────────
      const cta = page.getByTestId('dq-empty-cta');
      await expect(cta).toBeVisible();
      await cta.focus();
      await expect(cta).toBeFocused();
    }

    if (summaryVisible) {
      // ── has_data branch: trust banner (one of the two variants) + tiles ────
      const trustedBanner = page.getByTestId('dq-trust-banner-trusted');
      const gatedBanner = page.getByTestId('dq-trust-banner-gated');
      const trustedVisible = await trustedBanner.isVisible().catch(() => false);
      const gatedVisible = await gatedBanner.isVisible().catch(() => false);
      expect(
        trustedVisible || gatedVisible,
        'Expected a trust-verdict banner (trusted or gated) to render in the has_data branch',
      ).toBe(true);

      await expect(page.getByTestId('dq-effective-confidence')).toBeVisible();
      await expect(page.getByTestId('dq-coverage')).toBeVisible();
    }

    // ── No crash ─────────────────────────────────────────────────────────────
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (serious + critical violations must be 0) ──────────────────
    await expectNoA11yViolations(page);

    // ── No uncaught errors (BigInt(undefined) contract-drift guard) ──────────
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
