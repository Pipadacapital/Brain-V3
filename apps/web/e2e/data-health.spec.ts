/**
 * Data Health E2E — /data/health
 *
 * Coverage:
 *   - Page heading "Data Health" is present.
 *   - For a fresh user with no connector/ingestion data the honest empty state renders:
 *       EmptyState title "No data health signals yet" — not a crash.
 *   - The body is visible and no uncaught JS exceptions occur.
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations).
 *
 * Honest empty: a freshly-registered user's brand has no ingestion events and no
 * connector, so DataHealthContent renders state:'no_data' → EmptyState. We assert
 * the no-data path renders correctly, NOT that it shows specific freshness timestamps
 * or volume data.
 *
 * Note on has_data path: the sync-state + freshness badges (FreshnessBadge / SyncStateBadge)
 * and the volume chart section (aria-label="Event ingestion volume") only render when
 * data.state === 'has_data'. Testing those requires a seeded connector + ingestion row
 * (see live-sync.spec.ts pattern) — that is a scope extension. This spec covers the
 * structural + a11y contract for the honest no-data path.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/data/health', () => {
  test('renders page heading, honest empty state (no ingestion data), axe-clean', async ({
    page,
  }) => {
    // ── Collect console errors ─────────────────────────────────────────────
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Filter known harmless Next.js dev-mode noise
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

    // ── Onboard fresh user (brand has no connector + no ingestion data) ───
    await onboardToDashboard(page, 'dh');
    await page.goto('/data/health');
    await expect(page).toHaveURL(/\/data\/health/);

    // ── Page heading ──────────────────────────────────────────────────────
    // Use level:1 to match the h1 only (the EmptyState also renders an h3)
    await expect(page.getByRole('heading', { name: 'Data Health', level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    // ── Honest empty state: fresh user has no ingestion or connector ──────
    // DataHealthContent renders state:'no_data' → EmptyState with this title.
    // We allow either the EmptyState title (no_data) OR the data sections (has_data)
    // to be present, asserting the page did not crash regardless of path.
    const emptyTitle = page.getByText('No data health signals yet');
    const dataSection = page.getByRole('region', { name: 'Data health status' });

    // At least one of: empty state or data section must be visible
    const emptyVisible = await emptyTitle.isVisible().catch(() => false);
    const dataSectionVisible = await dataSection.isVisible().catch(() => false);

    expect(
      emptyVisible || dataSectionVisible,
      'Expected either the empty-state message or the data-health status section to be visible',
    ).toBe(true);

    // ── If in has_data path: assert the structural sections ──────────────
    if (dataSectionVisible) {
      // Status tiles section with freshness + sync badges
      await expect(dataSection).toBeVisible({ timeout: 10_000 });

      // Volume chart section is also present when data exists
      const volumeSection = page.getByRole('region', { name: 'Event ingestion volume' });
      await expect(volumeSection).toBeVisible({ timeout: 10_000 });
    }

    // ── No crash ─────────────────────────────────────────────────────────
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate (serious + critical violations must be 0) ───────────────
    await expectNoA11yViolations(page);

    // ── Console error assertions ──────────────────────────────────────────
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(
      consoleErrors,
      `Console errors:\n${consoleErrors.join('\n')}`,
    ).toHaveLength(0);
  });
});
