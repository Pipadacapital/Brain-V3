/**
 * Consent / Compliance surface E2E (D13 — feat-d13-consent-cancontact Track C).
 *
 * The per-brand consent/compliance surface (/settings/consent), read ONLY via the BFF
 * (/api/v1/consent/*). It proves the DEFAULT-CLOSED posture is stakeholder-visible:
 * a freshly-onboarded brand with an empty consent system-of-record shows the honest
 * fail-closed message ("blocked by default"), NOT a fabricated zero.
 *
 * Coverage:
 *   1. /settings/consent renders: the page heading + the default-closed framing copy.
 *   2. All four panels mount (suppression, coverage, send-window, gate-activity).
 *   3. The send-window panel ALWAYS renders (no DB dependency) and shows the 9–9 IST
 *      window + the "enforced server-side" label (server-computed, not a client hint).
 *   4. Honest fail-closed empty OR has-data: a brand with no consent rows shows the
 *      "blocked by default" empty state; a brand with rows shows the coverage table.
 *      The spec accepts either truthful outcome — never asserts a fake number.
 *   5. axe WCAG 2.x AA scan passes (0 serious/critical) — a data/status surface, so
 *      a11y is a gate, not a nicety (status is icon+label, never colour-only).
 *   6. No uncaught console / page errors.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('Consent / Compliance surface (D13)', () => {
  test('renders the consent/compliance surface with the fail-closed posture, axe-clean', async ({
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

    await onboardToDashboard(page, 'cnsnt');
    await page.goto('/settings/consent');
    await expect(page).toHaveURL(/\/settings\/consent/);

    // ── 1. Heading + default-closed framing copy ──
    await expect(
      page.getByRole('heading', { name: 'Consent & Compliance', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('default-closed', { exact: false }).first()).toBeVisible();

    // ── 2. All four panels mount ──
    await expect(page.getByTestId('consent-suppression-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('consent-coverage-panel')).toBeVisible();
    await expect(page.getByTestId('consent-window-panel')).toBeVisible();
    await expect(page.getByTestId('consent-gate-panel')).toBeVisible();

    // ── 3. Send-window panel always renders (no DB dependency) ──
    await expect(page.getByTestId('consent-window-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('consent-window-card')).toContainText('09:00');
    await expect(page.getByTestId('consent-window-card')).toContainText('21:00');
    await expect(page.getByTestId('consent-window-card')).toContainText('Enforced server-side');
    await expect(page.getByTestId('consent-window-status')).toBeVisible();

    // ── 4. Honest fail-closed empty OR has-data — assert exactly one truthful outcome ──
    const suppressionEmpty = page.getByTestId('consent-suppression-empty');
    const suppressionData = page.getByTestId('consent-suppressed-count');
    await expect(suppressionEmpty.or(suppressionData)).toBeVisible({ timeout: 15_000 });

    if (await suppressionEmpty.isVisible()) {
      // Fail-closed empty: the default-closed message, never a fabricated zero.
      await expect(suppressionEmpty).toContainText('blocked by default');
      // The coverage panel mirrors the fail-closed empty.
      await expect(page.getByTestId('consent-coverage-empty')).toBeVisible();
    } else {
      // Has-data: the suppression KPI tiles + the coverage table render.
      await expect(page.getByTestId('consent-tombstoned-count')).toBeVisible();
      await expect(page.getByTestId('consent-coverage-card')).toBeVisible();
    }

    // ── 5. No crash ──
    await expect(page.locator('body')).toBeVisible();

    // ── 6. A11y gate (status/data surface — gated, not asserted) ──
    await expectNoA11yViolations(page);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
