/**
 * Dashboard & navigation — WATCHABLE demo spec.
 *
 * This is the narrated, headed-run counterpart to the fast CI smoke
 * (e2e/dashboard.spec.ts + e2e/analytics-dashboard.spec.ts). Every meaningful
 * UI action is wrapped in `step(...)` so a stakeholder watching the headed run
 * can read what is happening; `announce(...)` headers each scenario; `pauseFor`
 * gives results a beat to land.
 *
 * Coverage (positive + negative):
 *   1. Dashboard loads post-onboarding (heading, page chrome, no page error).
 *   2. KPI tiles render the HONEST empty state for a brand-new brand (no
 *      ledger data → "No data yet", never a fabricated 0).
 *   3. Brand-summary shows the truthful "1 member" count (the COUNT DISTINCT fix).
 *   4. Every left-nav link navigates to its page without a client error.
 *   5. NEGATIVE: a fresh navigation across the whole dashboard surface produces
 *      no uncaught console errors / page errors.
 *   6. NEGATIVE: an unauthenticated visit to /dashboard is blocked → /login.
 *   7. NEGATIVE: the "Settlements" nav item is coming-soon → not a link, not
 *      navigable (aria-disabled, no href).
 *
 * Selectors are grepped from the real components (NOT invented):
 *   - Dashboard heading:        role=heading name="Dashboard"  (dashboard-content.tsx)
 *   - KPI tiles:                kpi-realized / kpi-provisional / kpi-orders /
 *                               kpi-aov / kpi-rto-rate          (dashboard-content.tsx)
 *   - "No data yet" empty text: KpiTile null-value branch       (kpi-tile.tsx)
 *   - Brand summary card:       brand-summary-card + "1 member" (brand-summary-card.tsx)
 *   - Nav landmark + links:     aside aria-label="Main navigation",
 *                               nav aria-label="Navigation links", Link per item
 *                               (app/(dashboard)/layout.tsx NAV_SECTIONS)
 *   - Coming-soon item:         "Settlements" aria-disabled, role=link, no href
 *   - Auth guard redirect:      RequireSession → router.replace('/login')
 *
 * Run (headed): pnpm --filter @brain/web test:e2e:demo  (optionally PW_SLOWMO=1000)
 * List only:    pnpm --filter @brain/web exec playwright test \
 *                 --config=playwright.demo.config.ts e2e/demo/dashboard.demo.spec.ts --list
 */

import { test, expect, type ConsoleMessage } from '@playwright/test';
import {
  step,
  pauseFor,
  announce,
  onboardToDashboard,
} from './helpers/demo';

/**
 * The left-nav links that are real <Link>s (have an href in NAV_SECTIONS).
 * "Settlements" is intentionally excluded — it is coming-soon (no href) and is
 * asserted as NON-navigable in its own negative test below.
 */
const NAV_LINKS: ReadonlyArray<{ label: string; urlRe: RegExp; heading: RegExp }> = [
  { label: 'Dashboard', urlRe: /\/dashboard$/, heading: /^Dashboard$/ },
  { label: 'Revenue', urlRe: /\/analytics\/revenue/, heading: /^Revenue$/ },
  { label: 'Orders', urlRe: /\/analytics\/orders/, heading: /^Orders$/ },
  { label: 'Connectors', urlRe: /\/settings\/connectors/, heading: /Integration Marketplace/ },
  { label: 'Data Health', urlRe: /\/data\/health/, heading: /^Data Health$/ },
  { label: 'Brain Pixel', urlRe: /\/settings\/pixel/, heading: /Tracking Center/ },
  { label: 'Members', urlRe: /\/settings\/members/, heading: /Team members/ },
  { label: 'Settings', urlRe: /\/settings$/, heading: /^Settings$/ },
];

/**
 * Attach console/page error collectors. Filters known-harmless Next.js dev noise
 * (HMR hot-update + favicon 404s) — exactly as the CI smoke does — so the
 * negative assertion fails ONLY on a real client error.
 */
function collectClientErrors(page: import('@playwright/test').Page): {
  consoleErrors: string[];
  pageErrors: string[];
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (
      text.includes('Failed to load resource') &&
      (text.includes('favicon') || text.includes('hot-update'))
    ) {
      return;
    }
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  return { consoleErrors, pageErrors };
}

test.describe('Dashboard & navigation — demo', () => {
  test('Dashboard loads post-onboarding with honest empty KPI tiles', async ({ page }) => {
    await announce(page, 'Dashboard loads after onboarding');

    // Full register → verify → 4-step onboarding → /dashboard, fresh stamped user.
    await step(
      page,
      'Onboard a brand-new user all the way to the dashboard',
      async () => {
        await onboardToDashboard(page, 'demo-dash');
      },
    );

    await step(page, 'Confirm we landed on the dashboard', async () => {
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(
        page.getByRole('heading', { name: 'Dashboard' }),
      ).toBeVisible({ timeout: 10_000 });
    });

    await announce(page, 'KPI tiles — honest empty state');

    // All five KPI tiles must render even with zero ledger data.
    await step(page, 'All five KPI tiles render (Realized, Provisional, Orders, AOV, RTO)', async () => {
      await expect(page.getByTestId('kpi-realized')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('kpi-provisional')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('kpi-orders')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('kpi-aov')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('kpi-rto-rate')).toBeVisible({ timeout: 10_000 });
    });

    // The HONEST empty signal — a brand-new brand has no data, so KpiTile renders
    // "No data yet" rather than a fabricated 0. Assert it on at least one tile.
    await step(page, 'A fresh brand shows the honest "No data yet" — never a fake 0', async () => {
      const realized = page.getByTestId('kpi-realized');
      await expect(realized.getByText('No data yet')).toBeVisible({ timeout: 15_000 });
      // Defensive: it must NOT have rendered a fabricated zero value.
      await expect(realized.getByText(/^0$/)).toHaveCount(0);
    });

    await pauseFor(page, 1200);

    await announce(page, 'Brand summary — truthful member count');

    // The brand-summary card surfaces the active brand and a COUNT DISTINCT of
    // members. A sole owner holds an org-level + a brand-level membership row;
    // the fixed count must read "1 member", not "2".
    await step(page, 'Brand summary shows the corrected "1 member" count', async () => {
      await expect(page.getByTestId('brand-summary-card')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('1 member')).toBeVisible({ timeout: 10_000 });
    });

    await pauseFor(page, 1000);
  });

  test('Every left-nav link navigates to its page (no client error)', async ({ page }) => {
    await announce(page, 'Left-nav navigation tour');

    const { consoleErrors, pageErrors } = collectClientErrors(page);

    await step(page, 'Onboard a fresh user and reach the dashboard', async () => {
      await onboardToDashboard(page, 'demo-nav');
      await expect(page).toHaveURL(/\/dashboard/);
    });

    // The nav landmark itself must be present and labelled.
    await step(page, 'The main navigation sidebar is present and labelled', async () => {
      await expect(
        page.getByRole('navigation', { name: 'Main navigation' }),
      ).toBeVisible({ timeout: 10_000 });
    });

    const nav = page.getByRole('navigation', { name: 'Main navigation' });

    // Walk every real nav link, click it, assert the URL AND a real on-page
    // heading — proving the page mounted, not just that the URL changed.
    for (const link of NAV_LINKS) {
      await step(page, `Open "${link.label}" from the sidebar`, async () => {
        await nav.getByRole('link', { name: link.label, exact: true }).click();
        await expect(page).toHaveURL(link.urlRe, { timeout: 10_000 });
        await expect(
          page.getByRole('heading', { name: link.heading }).first(),
        ).toBeVisible({ timeout: 10_000 });
      });
    }

    await step(page, 'No uncaught client errors across the whole navigation tour', async () => {
      expect(
        pageErrors,
        `Uncaught page errors during nav tour:\n${pageErrors.join('\n')}`,
      ).toHaveLength(0);
      expect(
        consoleErrors,
        `Console errors during nav tour:\n${consoleErrors.join('\n')}`,
      ).toHaveLength(0);
    });

    await pauseFor(page, 1000);
  });

  test('NEGATIVE — "Settlements" is coming-soon and is NOT navigable', async ({ page }) => {
    await announce(page, 'Negative: a coming-soon item must not navigate');

    await step(page, 'Onboard a fresh user and reach the dashboard', async () => {
      await onboardToDashboard(page, 'demo-soon');
      await expect(page).toHaveURL(/\/dashboard/);
    });

    // "Settlements" has no href in NAV_SECTIONS — it renders as a div with
    // role="link" aria-disabled="true" and a "Soon" badge. It must NOT be a
    // real anchor and clicking it must NOT navigate away from /dashboard.
    await step(page, 'The "Settlements" item is rendered disabled, not as a real link', async () => {
      const settlements = page.getByRole('link', { name: /Settlements/ });
      await expect(settlements).toBeVisible({ timeout: 10_000 });
      await expect(settlements).toHaveAttribute('aria-disabled', 'true');
      // A coming-soon item carries no href (it's a <div role="link">, not an <a>).
      await expect(settlements).not.toHaveAttribute('href', /.+/);
    });

    await step(page, 'Clicking "Settlements" does NOT leave the dashboard', async () => {
      await page.getByRole('link', { name: /Settlements/ }).click({ force: true }).catch(() => undefined);
      await pauseFor(page, 600);
      // Still on the dashboard — the disabled item went nowhere.
      await expect(page).toHaveURL(/\/dashboard/);
    });

    await pauseFor(page, 1000);
  });

  test('NEGATIVE — unauthenticated /dashboard visit is blocked and redirects to /login', async ({ page }) => {
    await announce(page, 'Negative: the auth guard blocks the dashboard');

    // Fresh context (no session). RequireSession resolves /me → 401 → /login.
    await step(page, 'Visit /dashboard with no session', async () => {
      await page.goto('/dashboard');
    });

    await step(page, 'The auth guard redirects an anonymous visitor to /login', async () => {
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
      // The login form is actually rendered — not a blank/broken redirect.
      await expect(page.getByTestId('btn-login')).toBeVisible({ timeout: 10_000 });
    });

    await pauseFor(page, 1200);
  });
});
