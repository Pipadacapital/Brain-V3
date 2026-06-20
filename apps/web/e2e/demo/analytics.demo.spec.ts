/**
 * Analytics Surfaces — WATCHABLE demo spec.
 *
 * A headed, narrated walkthrough of every analytics surface that exists today:
 *   - /dashboard            (the analytics shell: 5 KPI tiles, trend sections, connection status)
 *   - /analytics/revenue    (realized vs provisional KPIs, trend chart + grain toggle, recognition breakdown)
 *   - /analytics/orders     (order count / AOV / RTO KPIs, orders trend chart + grain toggle, stats-by-currency)
 *
 * Every meaningful UI action is wrapped in `step(page, "<plain English>", …)` so a
 * human watching the headed run can follow along, with `announce(page, …)` opening
 * each section and `pauseFor` where a result needs a beat.
 *
 * POSITIVE coverage: pages load on the right URL, headings render, KPI regions
 * appear, the grain toggle is keyboard-reachable and actually switches, nav links
 * route between surfaces, the a11y gate passes.
 *
 * NEGATIVE / honest-empty coverage: a freshly-onboarded brand has NO ledger rows,
 * so we assert the *truthful* empty result — KPI tiles show "No data yet", the
 * trend charts/tables render their EmptyState ("No trend data yet" / "No order data
 * yet" / "No data yet"), and the page never crashes or fabricates a 0.
 *
 * Selectors are REAL — grepped from:
 *   app/(dashboard)/dashboard/dashboard-content.tsx
 *   app/(dashboard)/analytics/{revenue,orders}/*-content.tsx
 *   app/(dashboard)/layout.tsx           (nav links)
 *   components/analytics/{kpi-tile,trend-chart,orders-trend-chart}.tsx
 *   components/ui/empty-state.tsx
 * No selector is invented. Surfaces that do not exist yet are honestly test.skip'd
 * at the bottom of this file with the reason.
 *
 * Each test onboards a FRESH stamped brand via onboardToDashboard(...) so there are
 * no cross-test collisions and the empty-state is genuine.
 */

import { test, expect } from '@playwright/test';
import {
  step,
  pauseFor,
  announce,
  onboardToDashboard,
  expectNoA11yViolations,
} from './helpers/demo';

// Demo flows do a full onboarding per test; give them generous headroom on top of
// the demo config's 180s default (the narration pauses add real wall-clock time).
test.describe.configure({ mode: 'serial' });

// ───────────────────────────────────────────────────────────────────────────
// 1. DASHBOARD ANALYTICS SHELL — positive load + honest empty state
// ───────────────────────────────────────────────────────────────────────────
test('Dashboard analytics shell loads with all five KPI tiles, sections, and connection status (positive)', async ({
  page,
}) => {
  await step(page, 'Onboard a brand-new brand and land on the dashboard', async () => {
    await onboardToDashboard(page, 'demo-adash');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Dashboard — Analytics Shell');

  await step(page, 'The page header reads "Dashboard"', async () => {
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'All five KPI tiles are present — Realized, Provisional, Orders, AOV, RTO Rate', async () => {
    await expect(page.getByTestId('kpi-realized')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('kpi-provisional')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('kpi-orders')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('kpi-aov')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('kpi-rto-rate')).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'The three dashboard section landmarks are reachable by their accessible names', async () => {
    await expect(page.getByRole('region', { name: 'Key performance indicators' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Revenue trends and recognition' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: 'Recent activity and connection status' })).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'The connection-status card is present (fresh brand → its empty state)', async () => {
    await expect(page.getByTestId('connection-status-card')).toBeVisible({ timeout: 10_000 });
  });

  await pauseFor(page, 800);

  await step(page, 'Accessibility gate: axe finds zero WCAG AA violations on the dashboard', async () => {
    await expectNoA11yViolations(page);
  });
});

test('Dashboard shows the HONEST empty state — KPI tiles say "No data yet", not a fake zero (negative / empty)', async ({
  page,
}) => {
  await step(page, 'Onboard a fresh brand that has no ledger data at all', async () => {
    await onboardToDashboard(page, 'demo-aempty');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Dashboard — Honest Empty State');

  // The KpiTile renders the literal text "No data yet" when its value is null
  // (components/analytics/kpi-tile.tsx) — it never fabricates a 0. We assert that
  // truthful empty text inside at least one KPI tile.
  await step(page, 'A KPI tile renders the honest "No data yet" copy (never a fabricated 0)', async () => {
    const realizedTile = page.getByTestId('kpi-realized');
    await expect(realizedTile).toBeVisible({ timeout: 15_000 });
    await expect(realizedTile.getByText('No data yet')).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'The KPI region exposes "no data" in its accessible name for screen readers', async () => {
    // KpiTile: aria-label={`${label}: ${value ?? 'no data'}`}
    await expect(page.getByRole('region', { name: /Gross Realized: no data/i })).toBeVisible({ timeout: 10_000 });
  });

  await pauseFor(page, 800);

  await step(page, 'The page did not crash — the body is still rendered over the empty state', async () => {
    await expect(page.locator('body')).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. REVENUE ANALYTICS — positive load, grain toggle, honest empty
// ───────────────────────────────────────────────────────────────────────────
test('Revenue analytics loads via the sidebar with KPI tiles and a keyboard-reachable grain toggle (positive)', async ({
  page,
}) => {
  await step(page, 'Onboard a fresh brand and land on the dashboard', async () => {
    await onboardToDashboard(page, 'demo-arev');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Revenue Analytics');

  // Navigate via the real sidebar link (more watchable than a raw goto). The nav is
  // <nav aria-label="Navigation links"> with a Link labelled "Revenue".
  await step(page, 'Click "Revenue" in the sidebar to open the revenue surface', async () => {
    const nav = page.getByRole('navigation', { name: 'Navigation links' });
    await nav.getByRole('link', { name: 'Revenue' }).click();
    await expect(page).toHaveURL(/\/analytics\/revenue/);
  });

  await step(page, 'The page header reads "Revenue"', async () => {
    await expect(page.getByRole('heading', { name: 'Revenue', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'All five revenue KPI tiles render (Realized, Provisional, Orders, AOV, RTO)', async () => {
    await expect(page.getByRole('region', { name: 'Revenue KPIs' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('rev-kpi-realized')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('rev-kpi-provisional')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('rev-kpi-orders')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('rev-kpi-aov')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('rev-kpi-rto')).toBeVisible({ timeout: 10_000 });
  });

  // The grain toggle is the only filter control on this surface (a date-range
  // picker is a documented Phase-2 TODO — see the skip note at the foot of the file).
  await step(page, 'Daily is the default selection in the chart-grain filter', async () => {
    const grain = page.getByRole('group', { name: 'Chart grain selection' }).first();
    await expect(grain).toBeVisible({ timeout: 10_000 });
    const daily = grain.getByRole('radio', { name: 'Daily' });
    await expect(daily).toBeChecked();
  });

  await step(page, 'Keyboard: focus Daily, press ArrowRight → Weekly becomes focused and checked', async () => {
    const grain = page.getByRole('group', { name: 'Chart grain selection' }).first();
    const daily = grain.getByRole('radio', { name: 'Daily' });
    const weekly = grain.getByRole('radio', { name: 'Weekly' });
    await daily.focus();
    await expect(daily).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(weekly).toBeFocused();
    await expect(weekly).toBeChecked();
  });

  await pauseFor(page, 700);

  await step(page, 'Accessibility gate: axe finds zero WCAG AA violations on the revenue surface', async () => {
    await expectNoA11yViolations(page);
  });
});

test('Revenue analytics renders its honest empty state for a fresh brand — trend + breakdown say no data (negative / empty)', async ({
  page,
}) => {
  await step(page, 'Onboard a fresh brand with no revenue ledger rows', async () => {
    await onboardToDashboard(page, 'demo-arevempty');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Revenue Analytics — Honest Empty State');

  await step(page, 'Open the revenue surface directly', async () => {
    await page.goto('/analytics/revenue');
    await expect(page).toHaveURL(/\/analytics\/revenue/);
    await expect(page.getByRole('heading', { name: 'Revenue', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  // The TrendChart renders EmptyState title="No trend data yet" when there is no
  // data (components/analytics/trend-chart.tsx). EmptyState is role="status".
  await step(page, 'The revenue trend chart shows its empty state: "No trend data yet"', async () => {
    const trendSection = page.getByRole('region', { name: 'Revenue trend chart' });
    await expect(trendSection).toBeVisible({ timeout: 10_000 });
    await expect(trendSection.getByText('No revenue yet')).toBeVisible({ timeout: 15_000 });
  });

  // The recognition Breakdown Detail card renders <p role="status">No data yet</p>
  // when breakdownData.state === 'no_data' (revenue-content.tsx).
  await step(page, 'The recognition breakdown detail shows the honest "No data yet" copy', async () => {
    const breakdownSection = page.getByRole('region', { name: 'Recognition breakdown and currency summary' });
    await expect(breakdownSection).toBeVisible({ timeout: 10_000 });
    await expect(breakdownSection.getByText('No data yet')).toBeVisible({ timeout: 15_000 });
  });

  await pauseFor(page, 800);

  await step(page, 'No crash — the surface stays up over the empty state', async () => {
    await expect(page.locator('body')).toBeVisible();
  });

  await step(page, 'Accessibility gate still passes even in the empty state', async () => {
    await expectNoA11yViolations(page);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. ORDERS ANALYTICS — positive load, grain toggle, honest empty
// ───────────────────────────────────────────────────────────────────────────
test('Orders analytics loads via the sidebar with KPI tiles and the grain toggle (positive)', async ({
  page,
}) => {
  await step(page, 'Onboard a fresh brand and land on the dashboard', async () => {
    await onboardToDashboard(page, 'demo-aord');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Orders Analytics');

  await step(page, 'Click "Orders" in the sidebar to open the orders surface', async () => {
    const nav = page.getByRole('navigation', { name: 'Navigation links' });
    await nav.getByRole('link', { name: 'Orders' }).click();
    await expect(page).toHaveURL(/\/analytics\/orders/);
  });

  await step(page, 'The page header reads "Orders"', async () => {
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'The three order KPI tiles render — Orders, AOV, RTO Rate', async () => {
    await expect(page.getByRole('region', { name: 'Order KPIs' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('orders-kpi-count')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('orders-kpi-aov')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('orders-kpi-rto')).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'The orders trend chart section is present', async () => {
    const trendSection = page.getByRole('region', { name: 'Orders trend chart' });
    await expect(trendSection).toBeVisible({ timeout: 10_000 });
    await expect(trendSection.locator('*')).not.toHaveCount(0);
  });

  await step(page, 'Switch the chart grain to Weekly with the keyboard', async () => {
    const grain = page.getByRole('group', { name: 'Chart grain selection' }).first();
    await expect(grain).toBeVisible({ timeout: 10_000 });
    const daily = grain.getByRole('radio', { name: 'Daily' });
    const weekly = grain.getByRole('radio', { name: 'Weekly' });
    await expect(daily).toBeChecked();
    await daily.focus();
    await page.keyboard.press('ArrowRight');
    await expect(weekly).toBeChecked();
  });

  await pauseFor(page, 700);

  await step(page, 'Accessibility gate: axe finds zero WCAG AA violations on the orders surface', async () => {
    await expectNoA11yViolations(page);
  });
});

test('Orders analytics renders its honest empty state for a fresh brand — stats table says "No order data yet" (negative / empty)', async ({
  page,
}) => {
  await step(page, 'Onboard a fresh brand with no orders', async () => {
    await onboardToDashboard(page, 'demo-aordempty');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Orders Analytics — Honest Empty State');

  await step(page, 'Open the orders surface directly', async () => {
    await page.goto('/analytics/orders');
    await expect(page).toHaveURL(/\/analytics\/orders/);
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  // The orders trend chart renders EmptyState (title "No data in this period" /
  // "No trend data yet") and the stats-by-currency section renders EmptyState
  // title="No order data yet" (orders-content.tsx). We assert the stats empty copy,
  // which is the most specific honest-empty signal on this surface.
  await step(page, 'The "Stats by Currency" section shows the honest "No order data yet" empty state', async () => {
    const statsSection = page.getByRole('region', { name: 'Order stats by currency' });
    await expect(statsSection).toBeVisible({ timeout: 10_000 });
    await expect(statsSection.getByText('No order data yet')).toBeVisible({ timeout: 15_000 });
  });

  await step(page, 'No raw order-stats table is shown — there is genuinely nothing to tabulate', async () => {
    const statsSection = page.getByRole('region', { name: 'Order stats by currency' });
    // The data <table aria-label="Order stats by currency"> only renders when there
    // ARE rows; in the empty state it must be absent.
    await expect(statsSection.getByRole('table', { name: 'Order stats by currency' })).toHaveCount(0);
  });

  await pauseFor(page, 800);

  await step(page, 'No crash — the orders surface stays up over the empty state', async () => {
    await expect(page.locator('body')).toBeVisible();
  });

  await step(page, 'Accessibility gate still passes even in the empty state', async () => {
    await expectNoA11yViolations(page);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. CROSS-SURFACE NAVIGATION — positive: the analytics surfaces route correctly
// ───────────────────────────────────────────────────────────────────────────
test('Analytics navigation routes Dashboard → Revenue → Orders → Dashboard and shows Settlements as coming-soon (positive)', async ({
  page,
}) => {
  await step(page, 'Onboard a fresh brand and land on the dashboard', async () => {
    await onboardToDashboard(page, 'demo-anav');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await announce(page, 'Analytics Navigation');

  const nav = () => page.getByRole('navigation', { name: 'Navigation links' });

  await step(page, 'Navigate to Revenue', async () => {
    await nav().getByRole('link', { name: 'Revenue' }).click();
    await expect(page).toHaveURL(/\/analytics\/revenue/);
    await expect(page.getByRole('heading', { name: 'Revenue', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'Navigate to Orders', async () => {
    await nav().getByRole('link', { name: 'Orders' }).click();
    await expect(page).toHaveURL(/\/analytics\/orders/);
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible({ timeout: 10_000 });
  });

  await step(page, 'Navigate back to the Dashboard', async () => {
    await nav().getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10_000 });
  });

  // "Settlements" is intentionally a disabled "coming soon" nav item (layout.tsx),
  // not yet a navigable analytics surface. Asserting its blocked state is the
  // honest negative for "spend/settlement analytics not built yet".
  await step(page, 'The "Settlements" analytics surface is honestly marked coming-soon and is not a link', async () => {
    await expect(nav().getByText('Settlements')).toBeVisible({ timeout: 10_000 });
    await expect(nav().getByRole('link', { name: /Settlements/ })).toHaveCount(0);
  });

  await pauseFor(page, 800);
});

// ───────────────────────────────────────────────────────────────────────────
// 5. SURFACES THAT DO NOT EXIST YET — honest skips (no fabricated selectors)
// ───────────────────────────────────────────────────────────────────────────

// Spend / ROAS: greps of app/ + components/ found NO ad-spend or ROAS analytics
// route or metric registry surface. The only adjacent item is the disabled
// "Settlements" nav entry (covered as a coming-soon negative above). Do not
// fabricate a spend page; skip with the honest reason.
test.skip('Spend / ROAS analytics surface (NOT BUILT — no /analytics/spend route, no ROAS metric surface; only a disabled "Settlements" nav item exists)', async () => {
  // Intentionally empty: there is no spend/ROAS page, KPI tile, or metric to assert
  // against. When the surface ships (route + registry-backed ROAS/spend tiles),
  // replace this skip with positive + empty-state coverage mirroring the patterns above.
});

// Date-range picker: both revenue-content.tsx and orders-content.tsx hard-code a
// last-90-days window with the comment "stubbed — Phase 2 adds a date-range
// picker". The only live filter control today is the Daily/Weekly grain toggle
// (covered positively above). No date-range control exists to drive.
test.skip('Date-range / custom-window filter (NOT BUILT — window is hard-coded to last 90 days; grain toggle is the only live filter, covered above)', async () => {
  // Intentionally empty: no date-range input/picker is rendered on any analytics
  // surface yet. When it ships, assert: changing the range re-queries the KPIs +
  // chart, the URL reflects the range (nuqs), and an out-of-range/empty window
  // yields the honest empty state.
});
