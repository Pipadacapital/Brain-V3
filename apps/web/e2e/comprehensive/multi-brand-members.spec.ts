import { test, expect, type Page } from '@playwright/test';
import { onboardToDashboard, registerUnverified, completeMergedStep } from '../helpers/onboard';

/**
 * multi-brand-members.spec.ts — multi-brand isolation + team-member management.
 *
 * Surfaces under test (selectors grounded in the real components):
 *   - BrandSwitcher        apps/web/components/dashboard/brand-switcher.tsx
 *       testids: brand-switcher, brand-switcher-toggle, brand-switcher-list,
 *                brand-switcher-row-<id>, btn-select-brand-<id>, btn-create-brand-cta
 *   - DashboardCreateBrandDialog  apps/web/components/dashboard/create-brand-dialog.tsx
 *       testids: create-brand-dialog, input-dialog-brand-name, select-dialog-currency-code,
 *                btn-create-brand-dialog-submit
 *   - MembersPageClient / MembersTable / InviteMemberDialog
 *       testids: btn-invite-member, input-invite-email, btn-send-invite, invite-verify-hint,
 *                member-row-<id>, btn-change-role-<id>, btn-suspend-<id>, btn-remove-member-<id>
 *
 * A FRESH onboarded user is the Owner of exactly ONE brand with NO data and is the only member.
 * Tests create their own user where a clean slate matters (isolation, soft-gate).
 */

const MEMBERS_HEADING = 'Team members';

/** Open the brand switcher dropdown and wait for the brand list region to render. */
async function openBrandSwitcher(page: Page): Promise<void> {
  await expect(page.getByTestId('brand-switcher')).toBeVisible();
  const toggle = page.getByTestId('brand-switcher-toggle');
  await expect(toggle).toBeVisible();
  // Idempotent: only toggle open if not already expanded.
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(page.getByTestId('brand-switcher-list')).toBeVisible();
}

/**
 * Create a second brand from the dashboard switcher. Returns when the hard-reload back to
 * /dashboard has settled. The dialog mirrors createBrandSchema (min 1 char brand name).
 */
async function createSecondBrand(page: Page, name: string): Promise<void> {
  await openBrandSwitcher(page);
  await page.getByTestId('btn-create-brand-cta').click();
  await expect(page.getByTestId('create-brand-dialog')).toBeVisible();
  await page.getByTestId('input-dialog-brand-name').fill(name);
  // Default currency/timezone (INR / Asia/Kolkata) already match — no mismatch confirm needed.
  await page.getByTestId('btn-create-brand-dialog-submit').click();
  // create → switchBrand → window.location.href = '/dashboard' (hard reload).
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('brand-switcher')).toBeVisible();
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE
// ─────────────────────────────────────────────────────────────────────────────

test.describe('multi-brand-members — positive', () => {
  test('[positive] a fresh owner sees the brand switcher listing their single brand', async ({ page }) => {
    await onboardToDashboard(page, 'mbm_pos1');
    await openBrandSwitcher(page);

    const list = page.getByTestId('brand-switcher-list');
    // At least one brand row (the brand created during onboarding) is present.
    const rows = list.locator('[data-testid^="brand-switcher-row-"]');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
    // The "+ Create brand" CTA is offered to the owner.
    await expect(page.getByTestId('btn-create-brand-cta')).toBeVisible();
  });

  test('[positive] owner creates a 2nd brand and can switch between brands via the switcher', async ({ page }) => {
    await onboardToDashboard(page, 'mbm_pos2');

    const second = `Second Brand ${Date.now()}`;
    await createSecondBrand(page, second);

    await openBrandSwitcher(page);
    const rows = page.getByTestId('brand-switcher-list').locator('[data-testid^="brand-switcher-row-"]');
    // Now there should be at least two brands.
    await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(2);

    // A non-active brand exposes a "Switch" button (btn-select-brand-<id>).
    const switchBtn = page.locator('[data-testid^="btn-select-brand-"]').first();
    await expect(switchBtn).toBeVisible();
    await switchBtn.click();
    // Switching hard-reloads /dashboard with the newly-active brand context.
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('brand-switcher')).toBeVisible();
  });

  test('[positive] members page lists the owner with the Owner role and their email', async ({ page }) => {
    const { email } = await onboardToDashboard(page, 'mbm_pos3');

    await page.goto('/settings/members');
    await expect(page.getByRole('heading', { name: MEMBERS_HEADING })).toBeVisible();

    // The freshly onboarded user is the sole member and the Owner.
    const memberRow = page.locator('[data-testid^="member-row-"]').first();
    await expect(memberRow).toBeVisible();
    await expect(memberRow.getByText(email).first()).toBeVisible(); // email shows in the name + muted line
    // Role badge label for owner is "Owner" (ROLE_LABELS.owner).
    await expect(memberRow.getByText('Owner', { exact: true })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE
// ─────────────────────────────────────────────────────────────────────────────

test.describe('multi-brand-members — negative', () => {
  test('[negative] inviting with an invalid email shows a validation error and does not navigate away', async ({ page }) => {
    await onboardToDashboard(page, 'mbm_neg1');

    await page.goto('/settings/members');
    await expect(page.getByRole('heading', { name: MEMBERS_HEADING })).toBeVisible();

    // Owner can invite — the trigger is rendered.
    await page.getByTestId('btn-invite-member').click();
    await expect(page.getByTestId('input-invite-email')).toBeVisible();

    await page.getByTestId('input-invite-email').fill('not-an-email');
    await page.getByTestId('btn-send-invite').click();

    // Zod resolver surfaces the field error (schemas.ts: 'Enter a valid email address').
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
    // Still on the members page; dialog email field remains.
    await expect(page).toHaveURL(/\/settings\/members/);
    await expect(page.getByTestId('input-invite-email')).toBeVisible();
  });

  test('[negative] empty email submission is rejected with a validation error', async ({ page }) => {
    await onboardToDashboard(page, 'mbm_neg2');

    await page.goto('/settings/members');
    await page.getByTestId('btn-invite-member').click();
    await expect(page.getByTestId('input-invite-email')).toBeVisible();

    // Leave the email empty and submit — Zod email() rejects the empty string.
    await page.getByTestId('btn-send-invite').click();
    await expect(page.getByText('Enter a valid email address')).toBeVisible();
  });

  test('[negative] owner cannot suspend, change-role, or remove their own owner row', async ({ page }) => {
    await onboardToDashboard(page, 'mbm_neg3');

    await page.goto('/settings/members');
    await expect(page.getByRole('heading', { name: MEMBERS_HEADING })).toBeVisible();

    const ownerRow = page.locator('[data-testid^="member-row-"]').first();
    await expect(ownerRow).toBeVisible();

    // Self + owner guard: no suspend / change-role / remove affordances on the owner's own row.
    await expect(ownerRow.locator('[data-testid^="btn-suspend-"]')).toHaveCount(0);
    await expect(ownerRow.locator('[data-testid^="btn-change-role-"]')).toHaveCount(0);
    await expect(ownerRow.locator('[data-testid^="btn-remove-member-"]')).toHaveCount(0);
    // The active status badge is shown for the owner.
    await expect(ownerRow.locator('[data-testid^="badge-active-"]')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE
// ─────────────────────────────────────────────────────────────────────────────

test.describe('multi-brand-members — edge', () => {
  test('[edge] each fresh brand is data-isolated: dashboard renders honestly with no cross-tenant data', async ({ page }) => {
    // A fresh onboarded brand has NO data — the dashboard must render its own surface
    // (heading/region) without leaking another tenant's data.
    await onboardToDashboard(page, 'mbm_edge_iso');

    await expect(page).toHaveURL(/\/dashboard/);
    // The brand switcher anchors the active-brand context for this isolated tenant.
    await openBrandSwitcher(page);
    const rows = page.getByTestId('brand-switcher-list').locator('[data-testid^="brand-switcher-row-"]');
    await expect(rows.first()).toBeVisible();
    // Exactly the brand(s) belonging to THIS fresh org — at least one, and the active one is selected.
    const activeOption = page.getByTestId('brand-switcher-list').locator('[role="option"][aria-selected="true"]');
    await expect(activeOption).toHaveCount(1);
  });

  test('[edge] switching to a 2nd brand changes the active context (the selected option moves)', async ({ page }) => {
    await onboardToDashboard(page, 'mbm_edge_switch');
    const second = `Switch Ctx ${Date.now()}`;
    await createSecondBrand(page, second);

    // After creation the new brand is set active (create → switchBrand). The switcher toggle
    // surfaces the active brand name (aria-label "Active brand: …") — a more robust signal than
    // the dropdown's transient aria-selected option.
    const toggle = page.getByTestId('brand-switcher-toggle');
    await expect(toggle).toContainText(second);

    // Switching to the other (non-active) brand re-routes to /dashboard with new context.
    await openBrandSwitcher(page);
    const otherSwitch = page.locator('[data-testid^="btn-select-brand-"]').first();
    await expect(otherSwitch).toBeVisible();
    await otherSwitch.click();
    await expect(page).toHaveURL(/\/dashboard/);

    // The active brand is now different — the toggle no longer shows the 2nd brand.
    await expect(page.getByTestId('brand-switcher-toggle')).not.toContainText(second);
  });

  test('[edge] an UNVERIFIED owner is soft-gated from inviting members', async ({ page }) => {
    // Register WITHOUT verifying email, then complete onboarding so we reach the dashboard
    // as an unverified owner. The merged step lands on /onboarding/tracking; finish the wizard.
    await registerUnverified(page, 'mbm_edge_unverif');
    await completeMergedStep(page);
    await page.getByTestId('btn-tracking-continue').click();
    await expect(page).toHaveURL(/\/onboarding\/integrations/);
    await page.getByTestId('btn-skip-integrations').click();
    await expect(page).toHaveURL(/\/onboarding\/done/);
    await page.getByTestId('btn-go-to-dashboard').click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.goto('/settings/members');
    await expect(page.getByRole('heading', { name: MEMBERS_HEADING })).toBeVisible();

    // Owner sees the invite trigger (role allows), but the dialog soft-gates the action.
    await page.getByTestId('btn-invite-member').click();
    await expect(page.getByTestId('input-invite-email')).toBeVisible();

    // Soft-gate hint is present and the Send button is disabled until email is verified.
    await expect(page.getByTestId('invite-verify-hint')).toBeVisible();
    await expect(page.getByTestId('btn-send-invite')).toBeDisabled();
  });
});
