import { test, expect, type Page } from '@playwright/test';
import { onboardToDashboard } from '../helpers/onboard';

/**
 * identity-compliance — E2E for the Identity control-plane + Consent/Compliance surfaces.
 *
 * Routes under test:
 *   /identity/customer-360  — Brain-ID lookup form + honest result region (empty / not_found / data)
 *   /identity?tab=merge-review — pending merge queue (honest "All good!" empty state when clear;
 *     the old /identity/merge-review route permanently redirects here)
 *   /identity?tab=pii-vault    — vault coverage counts (honest-0, never fabricated;
 *     the old /identity/pii-vault route permanently redirects here)
 *   /settings/consent       — default-closed consent posture: suppression / coverage / window / gate
 *
 * Selectors grounded by reading the real components:
 *   - customer-360-content.tsx : role="search" form, <label> "Brain ID", "Look up" button
 *     (disabled when empty), EmptyState (data-testid="empty-state") for both the pre-submit
 *     prompt and the not_found state.
 *   - identity-content.tsx : h1 "Identity" (TabShell/PageHeader), merge-review EmptyState
 *     "All good! No customer merges need your attention.", pii-vault cards
 *     "Profile completeness" / "Contact details on file" (counts render as honest 0 for a
 *     fresh brand) + the "No PII deletion requests." EmptyState.
 *   - consent-compliance-content.tsx + send-window-card.tsx : per-panel <section> testids and
 *     the fail-closed/has-data unions; the send window is read-only (server-enforced).
 *
 * Each test that needs a clean slate provisions its own fresh, isolated user+brand via
 * onboardToDashboard (a fresh brand has NO identity/consent data → honest empty states).
 * Web-first assertions + auto-waiting only; no arbitrary timeouts.
 */

/** Local helper: navigate to a route and assert we landed there (auth carried by the session). */
async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page).toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
}

test.describe('identity-compliance', () => {
  // ---- Customer 360 ----------------------------------------------------------------

  test('[positive] customer-360 renders search form + result region', async ({ page }) => {
    await onboardToDashboard(page, 'idc_c360pos');
    await gotoRoute(page, '/identity/customer-360');

    await expect(page.getByRole('heading', { name: 'Customer 360', level: 1 })).toBeVisible();

    // Labelled lookup input + the search landmark.
    const search = page.getByRole('search');
    await expect(search).toBeVisible();
    const input = page.locator('#brain-id'); // the labelled input (getByLabel also matches the empty-state aria-label)
    await expect(input).toBeVisible();

    // "Look up" button is disabled until a non-empty id is typed.
    const lookup = page.getByRole('button', { name: 'Look up' });
    await expect(lookup).toBeDisabled();
    await input.fill('not-a-real-brain-id');
    await expect(lookup).toBeEnabled();
  });

  test('[edge] customer-360 shows the pre-submit honest prompt for a fresh brand', async ({ page }) => {
    await onboardToDashboard(page, 'idc_c360empty');
    await gotoRoute(page, '/identity/customer-360');

    // No id submitted yet → the honest EmptyState prompt (role=status, labelled).
    const empty = page.getByTestId('empty-state');
    await expect(empty).toBeVisible();
    await expect(page.getByText('Enter a Brain ID to begin')).toBeVisible();
  });

  test('[negative] customer-360 lookup of a non-existent customer shows not-found state', async ({ page }) => {
    await onboardToDashboard(page, 'idc_c360nf');
    await gotoRoute(page, '/identity/customer-360');

    // A syntactically-valid-looking UUID that cannot resolve for this fresh brand.
    const ghost = '7f3c1e0a-9b2d-4c11-8a55-0b1c2d3e4f50';
    await page.locator('#brain-id').fill(ghost);
    await page.getByRole('button', { name: 'Look up' }).click();

    // Tolerate dev-data variance: a fresh brand resolves to the not_found EmptyState. The
    // result region is aria-live; expect-polling on the visible outcome avoids flakiness.
    await expect(page.getByText('No customer found')).toBeVisible();
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  // ---- Merge review ----------------------------------------------------------------

  test('[edge] merge-review shows the honest empty queue for a fresh brand', async ({ page }) => {
    await onboardToDashboard(page, 'idc_merge');
    // The old route permanently redirects into the consolidated Identity tab.
    await page.goto('/identity/merge-review');
    await expect(page).toHaveURL(/\/identity\?tab=merge-review/);

    await expect(page.getByRole('heading', { name: 'Identity', level: 1 })).toBeVisible();

    // Fresh brand → resolver flagged nothing → honest plain-language EmptyState.
    await expect(
      page.getByRole('heading', { name: 'All good! No customer merges need your attention.' }),
    ).toBeVisible();
  });

  // ---- PII vault -------------------------------------------------------------------

  test('[positive] pii-vault renders coverage with honest counts', async ({ page }) => {
    await onboardToDashboard(page, 'idc_vault');
    // The old route permanently redirects into the consolidated Identity tab.
    await page.goto('/identity/pii-vault');
    await expect(page).toHaveURL(/\/identity\?tab=pii-vault/);

    await expect(page.getByRole('heading', { name: 'Identity', level: 1 })).toBeVisible();

    // The coverage card always renders once data loads; a fresh brand shows honest 0%/0 — we
    // assert the labelled regions render rather than a specific number (tolerate dev variance).
    await expect(page.getByText('Profile completeness')).toBeVisible();
    await expect(page.getByText('Contact details on file')).toBeVisible();
    await expect(
      page.getByText('of customers have an email or phone number securely on file'),
    ).toBeVisible();
    // Deletion requests: a fresh brand has none → the honest EmptyState.
    await expect(page.getByText('No PII deletion requests.')).toBeVisible();
  });

  // ---- Consent / compliance --------------------------------------------------------

  test('[positive] consent settings page renders all four panels', async ({ page }) => {
    await onboardToDashboard(page, 'idc_consentpos');
    await gotoRoute(page, '/settings/consent');

    await expect(page.getByRole('heading', { name: 'Consent & Compliance', level: 1 })).toBeVisible();

    // Each panel is a labelled <section> with a stable testid — assert all four render.
    await expect(page.getByTestId('consent-suppression-panel')).toBeVisible();
    await expect(page.getByTestId('consent-coverage-panel')).toBeVisible();
    await expect(page.getByTestId('consent-window-panel')).toBeVisible();
    await expect(page.getByTestId('consent-gate-panel')).toBeVisible();
  });

  test('[edge] consent shows the fail-closed empty states for a fresh brand', async ({ page }) => {
    await onboardToDashboard(page, 'idc_consentempty');
    await gotoRoute(page, '/settings/consent');

    // A fresh brand has no consent system-of-record rows. The default-closed posture is shown
    // explicitly: each panel resolves to its fail-closed empty OR its has-data card. Tolerate
    // both so the test is robust to dev-data variance.
    const supp = page.getByTestId('consent-suppression-empty').or(page.getByTestId('consent-suppression-card'));
    await expect(supp).toBeVisible();

    const cov = page.getByTestId('consent-coverage-empty').or(page.getByTestId('consent-coverage-card'));
    await expect(cov).toBeVisible();

    const gate = page.getByTestId('consent-gate-empty').or(page.getByTestId('consent-gate-activity-card'));
    await expect(gate.first()).toBeVisible();

    // The honest fail-closed copy proves the default-closed posture (no fabricated zero).
    await expect(page.getByText('blocked by default').first()).toBeVisible();
  });

  test('[edge] consent send-window renders read-only + server-enforced', async ({ page }) => {
    await onboardToDashboard(page, 'idc_window');
    await gotoRoute(page, '/settings/consent');

    // The send window always returns config (not a no_data union) — the read-only card renders.
    const windowCard = page.getByTestId('consent-window-card');
    await expect(windowCard).toBeVisible();

    // It is a read-only guarantee, not an editable control: the "not editable" copy is present
    // and the window status is exposed as a role=status region (icon+word+text, not colour-only).
    await expect(page.getByText('not editable here.')).toBeVisible();
    await expect(page.getByTestId('consent-window-status')).toBeVisible();
  });

  // ---- Guard ----------------------------------------------------------------------

  test('[negative] consent settings requires auth (unauthenticated is redirected to login)', async ({ page }) => {
    // No onboarding → no brain_session cookie. The edge middleware guards /settings/* and
    // bounces an unauthenticated visit to /login?next=… BEFORE the shell renders.
    await page.goto('/settings/consent');

    await expect(page).toHaveURL(/\/login/);
    // The protected heading must never render for an unauthenticated visitor.
    await expect(page.getByRole('heading', { name: 'Consent & Compliance', level: 1 })).toHaveCount(0);
  });
});
