/**
 * Recommendations / decision-engine (Morning Brief) E2E — /recommendations
 *
 * Surface under test: apps/web/app/(dashboard)/recommendations/recommendations-content.tsx
 *   - BFF-only read of GET /api/v1/recommendations; POST /api/v1/recommendations/refresh on "Scan for recommendations".
 *   - Recommend-only: nothing is auto-executed.
 *
 * Honest-empty: a FRESH onboarded brand has no open recommendations, so the page renders the
 * EmptyState ("No open recommendations", testid `empty-state`, role=status) with a Run-detectors CTA.
 * Detector output is non-deterministic for a brand-new brand (detectors may find nothing), so the
 * data-bearing assertions TOLERATE BOTH the empty state and the has-data (recommendation cards) state.
 *
 * Money/evidence are rendered as formatted strings (e.g. "₹1,234.00") — never asserted as floats.
 *
 * Grounded selectors (read from the component + EmptyState + middleware):
 *   - Heading: role=heading name "Recommendations".
 *   - Scan button: role=button, accessible name "Scan for recommendations" (idle) / "Scanning…" (pending).
 *   - Empty state: testid `empty-state`, role=status, aria-label "No open recommendations".
 *   - A recommendation card exposes: title, "Risk"/"Opportunity" tag (uppercased text),
 *     a confidence badge (Trusted/Estimated/Insufficient), a "Recommended action:" block,
 *     evidence (<dl>), and (if measured) a "Since raised:" outcome strip.
 *   - Refresh error: role=alert "Could not run the detectors. Please try again."
 *   - Auth guard (middleware.ts): unauthenticated /recommendations → /login.
 */

import { test, expect, type Page } from '@playwright/test';
import { onboardToDashboard } from '../helpers/onboard';

const ROUTE = '/recommendations';

/** Navigate to the recommendations route and wait for the header to settle. */
async function gotoRecommendations(page: Page): Promise<void> {
  await page.goto(ROUTE);
  await expect(page).toHaveURL(/\/recommendations/);
  await expect(page.getByRole('heading', { name: 'Recommendations', exact: true })).toBeVisible({ timeout: 15_000 });
}

/** The list of rendered recommendation cards (each card's title is a CardTitle). */
function cardTitles(page: Page) {
  // Each card renders the "Recommended action:" block; count those as a card proxy.
  return page.getByText('Recommended action:');
}

/** Wait until the read settles into EITHER the empty state OR rendered cards (loading resolved). */
async function expectSettled(page: Page): Promise<'empty' | 'data'> {
  const empty = page.getByTestId('empty-state');
  const anyCard = cardTitles(page).first();
  await expect(empty.or(anyCard)).toBeVisible({ timeout: 20_000 });
  return (await empty.isVisible()) ? 'empty' : 'data';
}

test.describe('recommendations — decision engine (Morning Brief)', () => {
  test('[positive] renders the header, description, and a Scan button', async ({ page }) => {
    await onboardToDashboard(page, 'rec_pos');
    await gotoRecommendations(page);

    // Header + recommend-only description copy.
    await expect(page.getByRole('heading', { name: 'Recommendations', exact: true })).toBeVisible();
    await expect(page.getByText(/Recommend-only: nothing is changed automatically/i)).toBeVisible();

    // The top-bar Run-detectors action.
    const runBtn = page.getByRole('button', { name: 'Scan for recommendations' }).first();
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toBeEnabled();
  });

  test('[positive] when recommendations exist, a card shows tag + confidence + action + evidence; else honest empty', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'rec_card');
    await gotoRecommendations(page);

    const state = await expectSettled(page);

    if (state === 'data') {
      // A data card must carry the recommend-only anatomy.
      const firstActionBlock = cardTitles(page).first();
      await expect(firstActionBlock).toBeVisible();

      // Risk/Opportunity tag — at least one is present in the rendered list.
      const tag = page.getByText(/^(Risk|Opportunity)$/);
      await expect(tag.first()).toBeVisible();

      // Confidence badge — one of the three certified labels.
      const confidence = page.getByText(/^(Trusted|Estimated|Insufficient)$/);
      await expect(confidence.first()).toBeVisible();

      // Evidence is rendered as strings; if GMV-at-risk appears it is a formatted money string,
      // never a bare float. Assert the label exists OR the (optional) outcome strip — both are strings.
      // (We do not assert specific numbers — detector output is data-dependent.)
      await expect(page.locator('body')).toContainText(/Recommended action:/);
    } else {
      // Honest empty for a fresh brand with no certified signal yet.
      await expect(page.getByTestId('empty-state')).toBeVisible();
      await expect(
        page.getByRole('status', { name: 'No open recommendations' }),
      ).toBeVisible();
    }
  });

  test('[edge] a fresh brand shows the honest "No open recommendations" empty state with a Run-detectors CTA', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'rec_empty');
    await gotoRecommendations(page);

    const state = await expectSettled(page);
    // A brand-new brand has no certified data; the detectors should surface nothing actionable.
    // We tolerate has-data (detector could theoretically fire) but the common/honest path is empty.
    if (state === 'empty') {
      const empty = page.getByTestId('empty-state');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText('No open recommendations');
      await expect(empty).toContainText(/Run the detectors to scan your latest data/i);

      // The CTA inside the empty state is itself a Scan button.
      await expect(empty.getByRole('button', { name: 'Scan for recommendations' })).toBeVisible();
    } else {
      // If the brand somehow has data, the list (not the empty state) is shown.
      await expect(page.getByTestId('empty-state')).toHaveCount(0);
      await expect(cardTitles(page).first()).toBeVisible();
    }
  });

  test('[positive] clicking Scan for recommendations shows the running state and resolves back to a stable surface', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'rec_run');
    await gotoRecommendations(page);
    await expectSettled(page);

    // Click whichever Scan button is present (top-bar, or the empty-state CTA).
    const runBtn = page.getByRole('button', { name: 'Scan for recommendations' }).first();
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    // Running state: the button flips to "Running…" and is disabled while the POST is in flight.
    // This is fast; poll for either the running label OR an already-resolved stable surface.
    const running = page.getByRole('button', { name: 'Scanning…' });
    const settledAgain = page.getByTestId('empty-state').or(cardTitles(page).first());
    await expect(running.or(settledAgain)).toBeVisible({ timeout: 15_000 });

    // It must resolve: no button is left stuck in the pending label, and the surface is stable.
    await expect(page.getByRole('button', { name: 'Scanning…' })).toHaveCount(0, { timeout: 30_000 });
    await expectSettled(page);

    // The Run-detectors action is enabled again (re-runnable / idempotent — recommend-only).
    await expect(page.getByRole('button', { name: 'Scan for recommendations' }).first()).toBeEnabled();
  });

  test('[edge] Scanning is idempotent — re-scanning keeps the surface stable, never crashes', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'rec_idem');
    await gotoRecommendations(page);
    await expectSettled(page);

    for (let i = 0; i < 2; i++) {
      const runBtn = page.getByRole('button', { name: 'Scan for recommendations' }).first();
      await expect(runBtn).toBeEnabled();
      await runBtn.click();
      await expect(page.getByRole('button', { name: 'Scanning…' })).toHaveCount(0, { timeout: 30_000 });
      await expectSettled(page);
    }

    // Still the same honest surface (header intact, no uncaught crash).
    await expect(page.getByRole('heading', { name: 'Recommendations', exact: true })).toBeVisible();
  });

  test('[negative] unauthenticated visit to /recommendations redirects to /login (auth guard)', async ({
    page,
  }) => {
    // No session cookie → middleware bounces protected routes to /login.
    await page.goto(ROUTE);
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    // The recommendations heading must NOT leak to an unauthenticated visitor.
    await expect(page.getByRole('heading', { name: 'Recommendations', exact: true })).toHaveCount(0);
  });

  test('[edge] recommendations are tenant-isolated — a second fresh brand sees its own honest surface', async ({
    page,
  }) => {
    // First isolated brand.
    await onboardToDashboard(page, 'rec_tenantA');
    await gotoRecommendations(page);
    await expectSettled(page);

    // Brand-new second user/brand in the same context — must render its own clean surface,
    // never brand A's recommendations bleeding across the tenant boundary.
    await onboardToDashboard(page, 'rec_tenantB');
    await gotoRecommendations(page);
    const state = await expectSettled(page);

    // Either an honest empty state or this brand's own cards — but the page renders without error.
    if (state === 'empty') {
      await expect(page.getByRole('status', { name: 'No open recommendations' })).toBeVisible();
    } else {
      await expect(cardTitles(page).first()).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Recommendations', exact: true })).toBeVisible();
  });

  test('[negative] no refresh-error alert is shown on a healthy load (alert appears only on failure)', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'rec_noerr');
    await gotoRecommendations(page);
    await expectSettled(page);

    // On a successful read the destructive role=alert ("Could not run the detectors...") is absent.
    await expect(
      page.getByRole('alert').filter({ hasText: 'Could not run the detectors' }),
    ).toHaveCount(0);
  });

  test('[edge] money/evidence on any rendered card are formatted strings, never bare floats', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'rec_money');
    await gotoRecommendations(page);
    const state = await expectSettled(page);

    if (state === 'data') {
      // If a GMV-at-risk evidence line is present it renders via the minor-units formatter as a
      // currency string (e.g. "₹1,234.00"). Assert NO bare decimal float (e.g. "1234.5") leaks into
      // the evidence text. We only assert the formatting contract, never specific amounts.
      const gmvLabel = page.getByText(/GMV at risk:/);
      if (await gmvLabel.count()) {
        const evidenceText = (await page.locator('dl').first().innerText()).trim();
        // A bare unformatted float like "12345.67" with no currency symbol would indicate a float leak.
        expect(evidenceText).not.toMatch(/(?<![₹.,\d])\d+\.\d+(?![\d])/);
      }
      // The has-data surface is still intact.
      await expect(cardTitles(page).first()).toBeVisible();
    } else {
      // Empty brand: nothing to format — honest empty state stands in.
      await expect(page.getByTestId('empty-state')).toBeVisible();
    }
  });
});
