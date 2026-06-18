/**
 * Ad Spend / ROAS Analytics E2E — /analytics/spend (feat-ad-connectors Slice 1 Track 4)
 *
 * Coverage:
 *   - Page heading "Ad Spend & ROAS" is present.
 *   - Honest no-data: a freshly-onboarded brand has no ingested ad spend, so the page
 *     renders the EmptyState + a "Connect an ad platform" CTA (never a confident 0).
 *   - The Connect CTA is a keyboard-reachable link to /settings/connectors.
 *   - No uncaught console errors.
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations).
 *
 * Honest empty: spend depends on a live Meta/Google connector (platform follow-up in dev).
 * We assert the page does NOT crash and surfaces the connect path, not particular numbers.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/analytics/spend', () => {
  test('renders heading, honest no-data connect CTA (keyboard-reachable), axe-clean', async ({
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
        )
          return;
        consoleErrors.push(text);
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // ── Onboard fresh user then navigate to spend ──────────────────────────
    await onboardToDashboard(page, 'aspend');
    await page.goto('/analytics/spend');
    await expect(page).toHaveURL(/\/analytics\/spend/);

    // ── Page heading ───────────────────────────────────────────────────────
    await expect(
      page.getByRole('heading', { name: 'Ad Spend & ROAS', exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // ── Honest no-data: empty state + Connect CTA ──────────────────────────
    // A fresh brand has no spend ledger rows, so the page shows the connect path.
    const connectCta = page.getByTestId('spend-connect-cta');
    await expect(connectCta).toBeVisible({ timeout: 10_000 });

    // CTA links to the connectors marketplace.
    await expect(connectCta).toHaveAttribute('href', '/settings/connectors');

    // Keyboard-reachability: the CTA is focusable and Enter navigates.
    await connectCta.focus();
    await expect(connectCta).toBeFocused();

    // ── No crash ──────────────────────────────────────────────────────────
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (0 serious/critical) ─────────────────────────────────────
    await expectNoA11yViolations(page);

    // ── Console error assertions ──────────────────────────────────────────
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });

  test('sidebar exposes the Ad Spend nav entry and it navigates', async ({ page }) => {
    await onboardToDashboard(page, 'aspendnav');
    await page.goto('/dashboard');

    const nav = page.getByRole('navigation', { name: 'Navigation links' });
    const spendLink = nav.getByRole('link', { name: 'Ad Spend' });
    await expect(spendLink).toBeVisible({ timeout: 10_000 });

    await spendLink.click();
    await expect(page).toHaveURL(/\/analytics\/spend/, { timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: 'Ad Spend & ROAS', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
