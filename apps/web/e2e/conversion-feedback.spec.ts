/**
 * Conversion-Feedback / CAPI surface E2E (Phase 6 — feat-capi-conversion-feedback Track C).
 *
 * The stakeholder-visible CAPI passback surface (/analytics/conversion-feedback), read ONLY
 * via the BFF (/api/v1/feedback/capi/*). It proves, HONESTLY:
 *   - the passback summary band (Passed back · BLOCKED BY CONSENT · Deletions · Match quality),
 *     where Blocked-by-consent is the SLO=0 (non_consented_sends) made VISIBLE,
 *   - the dev boundary (would-send in dev — no live Meta creds — never faked),
 *   - the passback-events + retroactive-deletions tables, and
 *   - honest empty states (nothing passed back / no withdrawals yet) — never a fake zero.
 *
 * Coverage:
 *   1. /analytics/conversion-feedback renders: heading + the "Meta CAPI" platform label +
 *      the default-closed / hashed-PII framing copy.
 *   2. All three panels mount (summary, events, deletions).
 *   3. Honest empty OR has-data: a fresh brand with an empty 0034 SoR shows the honest
 *      "No conversions matched yet" empty state; a brand with rows shows the summary band
 *      (incl. the Blocked-by-consent SLO tile). The spec accepts either truthful outcome.
 *   4. If the dev-boundary banner is present, it carries the "would-send in dev" copy.
 *   5. axe WCAG 2.x AA scan passes (0 serious/critical) — a status/data surface, so a11y
 *      is a gate, not a nicety (status is icon+label, never colour-only).
 *   6. No uncaught console / page errors.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('Conversion-Feedback / CAPI surface (Phase 6)', () => {
  test('renders the CAPI passback surface with the SLO=0-visible posture, axe-clean', async ({
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

    await onboardToDashboard(page, 'capi');
    await page.goto('/analytics/conversion-feedback');
    await expect(page).toHaveURL(/\/analytics\/conversion-feedback/);

    // ── 1. Heading + platform label + framing copy ──
    await expect(
      page.getByRole('heading', { name: 'Conversion Feedback', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('capi-platform-label')).toBeVisible();
    await expect(page.getByTestId('capi-platform-label')).toContainText('Meta CAPI');
    await expect(page.getByText('default-closed', { exact: false }).first()).toBeVisible();

    // ── 2. All three panels mount ──
    await expect(page.getByTestId('capi-summary-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('capi-events-panel')).toBeVisible();
    await expect(page.getByTestId('capi-deletions-panel')).toBeVisible();

    // ── 3. Honest empty OR has-data — assert exactly one truthful outcome ──
    const summaryEmpty = page.getByTestId('capi-summary-empty');
    const summaryBand = page.getByTestId('capi-summary-band');
    await expect(summaryEmpty.or(summaryBand)).toBeVisible({ timeout: 15_000 });

    if (await summaryBand.isVisible()) {
      // Has-data: the four KPI tiles render, including the SLO=0 Blocked-by-consent tile.
      await expect(page.getByTestId('capi-kpi-passed-back')).toBeVisible();
      await expect(page.getByTestId('capi-kpi-blocked')).toBeVisible();
      await expect(page.getByTestId('capi-kpi-deletions')).toBeVisible();
      await expect(page.getByTestId('capi-kpi-match-quality')).toBeVisible();
      // The Blocked-by-consent tile is the SLO=0 (non_consented_sends) made visible.
      await expect(page.getByTestId('capi-kpi-blocked')).toContainText('Blocked by consent');
    } else {
      // Honest empty: nothing passed back yet, never a fabricated zero.
      await expect(summaryEmpty).toContainText('No conversions matched yet');
    }

    // ── 4. Dev-boundary banner (if any event is would_send_dev) carries the honest copy ──
    const devBanner = page.getByTestId('capi-dev-boundary-banner');
    if (await devBanner.isVisible()) {
      await expect(devBanner).toContainText('Would-send in dev');
      await expect(devBanner).toContainText('no live Meta CAPI credentials');
    }

    // ── 5. No crash ──
    await expect(page.locator('body')).toBeVisible();

    // ── 6. A11y gate (status/data surface — gated, not asserted) ──
    await expectNoA11yViolations(page);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });

  test('is reachable via the sidebar nav link and keyboard-focusable', async ({ page }) => {
    await onboardToDashboard(page, 'capinav');

    // ── Nav: the "Conversion Feedback" sidebar link is present and routes correctly ──
    const navLink = page.getByRole('link', { name: 'Conversion Feedback' }).first();
    await expect(navLink).toBeVisible({ timeout: 10_000 });

    // Keyboard-reach the link, then activate it with Enter (no mouse click).
    await navLink.focus();
    await expect(navLink).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/analytics\/conversion-feedback/, { timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: 'Conversion Feedback', exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // ── Keyboard: an interactive control on the surface is reachable + visibly focusable ──
    // The empty-state Connect-Meta CTA (no_data brand) OR a retry/refetch control surfaces;
    // assert at least the Connect CTA is keyboard-focusable when the honest empty renders.
    const connectCta = page.getByTestId('capi-feedback-connect-cta');
    if (await connectCta.isVisible().catch(() => false)) {
      await connectCta.focus();
      await expect(connectCta).toBeFocused();
    }

    // ── Each panel is a labelled region (landmark) reachable by assistive tech ──
    await expect(page.getByRole('region', { name: 'Passback summary' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Passback events' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Retroactive deletions' })).toBeVisible();
  });
});
