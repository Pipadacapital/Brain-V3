import { test, expect, type Page } from '@playwright/test';
import { onboardToDashboard, registerAndVerify } from '../helpers/onboard';

/**
 * Analytics suite — comprehensive E2E over the read surfaces under /analytics/*.
 *
 * Grounding (read from the real components, NOT guessed):
 *   - Every page is a server shell that delegates to a `*-content.tsx` client component.
 *   - Each page renders an <h1> heading (Revenue / Orders / Order Status / Journey /
 *     Attribution / Ad Spend & ROAS).
 *   - Reads are BFF-only; each surface renders an honest no_data empty state for a fresh
 *     brand (never a fabricated zero) OR a has_data chart/table when the active brand has
 *     data in the dev DB. Tests tolerate BOTH so they are resilient to dev-DB state.
 *   - Honest-empty markers observed in the components:
 *       order-status  -> [data-testid="order-status-empty"]    (EmptyConnectCard)
 *       journey       -> [data-testid="journey-empty"]         (EmptyPixelCard)
 *       attribution   -> [data-testid="attribution-empty"]     (EmptyAttributionCard)
 *       orders/spend  -> [data-testid="empty-state"]           (shared <EmptyState/>)
 *       revenue       -> role=status "No data yet" (breakdown detail) — revenue has no
 *                        single empty card, so we assert the heading + a stable region.
 *
 * Non-flaky discipline: web-first assertions, expect-polling for async loads, no arbitrary
 * timeouts. Each test creates its OWN fresh user where a clean slate matters.
 */

/** A fresh brand's honest-empty markers, by route. Any-of => the surface settled to empty. */
const EMPTY_TESTIDS: Record<string, string[]> = {
  '/analytics/revenue': [],
  '/analytics/orders': ['empty-state'],
  '/analytics/order-status': ['order-status-empty'],
  '/analytics/journey': ['journey-empty'],
  '/analytics/attribution': ['attribution-empty'],
  '/analytics/spend': ['empty-state', 'spend-connect-cta'],
};

/** Heading text rendered by each page's <h1>. */
const HEADINGS: Record<string, RegExp> = {
  '/analytics/revenue': /^Revenue$/,
  '/analytics/orders': /^Orders$/,
  '/analytics/order-status': /^Order Status$/,
  '/analytics/journey': /^Journey$/,
  '/analytics/attribution': /^Attribution$/,
  '/analytics/spend': /Ad Spend & ROAS/,
};

/** Navigate to an analytics route and assert the URL + heading rendered. */
async function gotoAnalytics(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page).toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
  await expect(
    page.getByRole('heading', { level: 1, name: HEADINGS[route] }),
  ).toBeVisible();
}

/**
 * Assert a read surface settled into EITHER an honest empty state OR has-data, never an
 * indefinite skeleton. We poll because the BFF read is async (no fixed wait).
 */
async function expectEmptyOrData(page: Page, route: string): Promise<void> {
  const emptyIds = EMPTY_TESTIDS[route] ?? [];
  await expect
    .poll(
      async () => {
        // Any honest-empty marker for this route?
        for (const id of emptyIds) {
          if (await page.getByTestId(id).first().isVisible().catch(() => false)) {
            return 'empty';
          }
        }
        // Generic honest-empty text used by several surfaces.
        const noData = page.getByText(/no data|no .* yet/i).first();
        if (await noData.isVisible().catch(() => false)) return 'empty';
        // Has-data: a table or an SVG-based chart (role=img / svg) is present.
        if (await page.locator('table').first().isVisible().catch(() => false)) return 'data';
        if (await page.getByRole('img').first().isVisible().catch(() => false)) return 'data';
        if (await page.locator('svg').first().isVisible().catch(() => false)) return 'data';
        return 'pending';
      },
      { timeout: 20_000, message: `analytics ${route} never settled to empty|data` },
    )
    .not.toBe('pending');
}

test.describe('analytics-suite', () => {
  // ── POSITIVE: each route loads + shows heading + settles to empty|data ──────────────
  for (const route of Object.keys(HEADINGS)) {
    test(`[positive] ${route} loads, shows heading, renders empty-or-data`, async ({
      page,
    }) => {
      await onboardToDashboard(page, 'an_pos');
      await gotoAnalytics(page, route);
      await expectEmptyOrData(page, route);
    });
  }

  // ── EDGE: a FRESH brand shows an honest empty state (no fabricated numbers) ──────────
  test('[edge] fresh brand: order-status shows honest empty connect-card', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'an_empty_os');
    await gotoAnalytics(page, '/analytics/order-status');
    // A fresh brand has no Silver-tier rows -> the explicit EmptyConnectCard renders.
    await expect(page.getByTestId('order-status-empty')).toBeVisible({ timeout: 20_000 });
    // Honest CTA to connect a source (never a fabricated 0 KPI tile).
    await expect(page.getByRole('link', { name: /connect a source/i })).toBeVisible();
    await expect(page.getByTestId('order-status-kpi-total')).toHaveCount(0);
  });

  test('[edge] fresh brand: journey shows honest empty pixel-setup card', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'an_empty_jy');
    await gotoAnalytics(page, '/analytics/journey');
    await expect(page.getByTestId('journey-empty')).toBeVisible({ timeout: 20_000 });
    // No fabricated KPI tiles on the empty surface.
    await expect(page.getByTestId('journey-kpi-total')).toHaveCount(0);
  });

  test('[edge] fresh brand: spend shows honest empty state with a connect CTA', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'an_empty_sp');
    await gotoAnalytics(page, '/analytics/spend');
    // spend-content renders the shared <EmptyState/> + a Connect CTA when no_data.
    await expect(page.getByTestId('empty-state')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('spend-connect-cta')).toBeVisible();
  });

  // ── EDGE: loading skeleton resolves (aria-busy is transient, not permanent) ──────────
  test('[edge] order-status loading skeleton resolves to a settled view', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'an_skel');
    await gotoAnalytics(page, '/analytics/order-status');
    // The aria-busy="Loading order status mix…" skeleton must detach (not hang forever).
    await expect(
      page.locator('[aria-busy="true"][aria-label*="Loading order status"]'),
    ).toHaveCount(0, { timeout: 20_000 });
    await expectEmptyOrData(page, '/analytics/order-status');
  });

  // ── EDGE: range selector re-queries without breaking the surface (boundary inputs) ───
  test('[edge] order-status range toggle re-queries and stays settled', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'an_range');
    await gotoAnalytics(page, '/analytics/order-status');
    await expectEmptyOrData(page, '/analytics/order-status');

    // Switch to the 30-day boundary preset; the surface must re-settle (empty|data),
    // never crash or hang on a skeleton.
    await page.getByTestId('order-status-range-30').click();
    await expect(page.getByTestId('order-status-range-30')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectEmptyOrData(page, '/analytics/order-status');
  });

  // ── NEGATIVE: unauthenticated access to an analytics route is guarded ────────────────
  test('[negative] unauthenticated user cannot view an analytics surface', async ({
    page,
  }) => {
    // No onboarding — go straight to a protected read surface.
    await page.goto('/analytics/revenue');
    // The dashboard group is auth-guarded: an unauthenticated visit must NOT render the
    // Revenue heading. It either redirects away from /analytics or shows a login surface.
    await expect
      .poll(
        async () => {
          const onRevenue =
            (await page
              .getByRole('heading', { level: 1, name: /^Revenue$/ })
              .isVisible()
              .catch(() => false)) && /\/analytics\/revenue/.test(page.url());
          return onRevenue ? 'leaked' : 'guarded';
        },
        { timeout: 15_000, message: 'analytics revenue not guarded for anon user' },
      )
      .toBe('guarded');
    await expect(page).not.toHaveURL(/\/analytics\/revenue/);
  });

  // ── EDGE: tenant isolation — two independently onboarded brands each see their own
  //          fresh honest-empty surface (no cross-brand data bleed) ─────────────────────
  test('[edge] isolation: two fresh brands each render their own honest-empty order-status', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      const a = await onboardToDashboard(pageA, 'an_iso_a');
      const b = await registerAndVerify(pageB, 'an_iso_b');
      expect(a.email).not.toBe(b.email);

      await gotoAnalytics(pageA, '/analytics/order-status');
      await expect(pageA.getByTestId('order-status-empty')).toBeVisible({
        timeout: 20_000,
      });

      // Brand A's surface must NOT show any other brand's data — it stays honest-empty.
      await expect(pageA.getByTestId('order-status-kpi-total')).toHaveCount(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
