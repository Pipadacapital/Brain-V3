import { test, expect, type Page, type Response } from '@playwright/test';
import {
  step,
  pauseFor,
  announce,
  registerAndVerify,
  login,
  onboardToDashboard,
  markEmailVerified,
  expectNoA11yViolations,
} from './helpers/demo';

/**
 * Multi-brand switching & isolation — WATCHABLE demo spec.
 *
 * This is the narrated, headed-run sibling of e2e/multi-brand.spec.ts (the fast CI
 * smoke). Every meaningful UI action is wrapped in step(...) with plain-English
 * narration so a stakeholder can follow the headed run; announce(...) marks each
 * section; pauseFor(...) gives results a beat to be seen.
 *
 * Real selectors only — grepped from components/dashboard/brand-switcher.tsx,
 * create-brand-dialog.tsx, brand-summary-card.tsx, analytics/kpi-tile.tsx:
 *   - brand-switcher-toggle      (button, aria-label "Active brand: <name>. ...")
 *   - brand-switcher-list        (role=listbox "Available brands")
 *   - btn-create-brand-cta       (opens the create dialog)
 *   - create-brand-dialog        + input-dialog-brand-name + btn-create-brand-dialog-submit
 *   - btn-select-brand-<id>      (aria-label "Switch to brand <name>")
 *   - brand-summary-card         (renders data.brand_name — the brand-scoped truth)
 *   - kpi-realized               (tile renders "No data yet" for a fresh, unconnected brand)
 *
 * Coverage:
 *   POSITIVE — create a 2nd brand → it becomes active; switch back to the 1st brand;
 *              the active-brand selector reflects the active brand; brand-summary +
 *              KPI surface are scoped to the active brand.
 *   NEGATIVE (isolation, UI-level) — after switching to brand B, brand A's name/data is
 *              NOT shown; the brand picker lists ONLY brands the user is a member of
 *              (a second, unrelated user sees only their own brand, never the first
 *              user's brands).
 */

const SET_BRAND_OK = (res: Response) =>
  res.url().includes('/v1/bff/session/set-brand') && res.request().method() === 'POST';

const UUID_IN_BODY = /"brand_id"\s*:\s*"[0-9a-f-]{36}"/i;

/** Active-brand toggle aria-label matcher (the selector's source of truth for "active"). */
function activeBrandLabel(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Active brand: ${escaped}`);
}

/**
 * Open the switcher, launch the create dialog, fill the name, submit, and assert the
 * create→switch SEAM POSTs a real brand_id and gets 200 (the regression the CI smoke
 * guards). Narrated for the demo audience.
 */
async function createBrandFromSwitcher(page: Page, name: string): Promise<void> {
  await step(page, `Open the brand switcher in the sidebar`, async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    await expect(page.getByTestId('brand-switcher-list')).toBeVisible();
  });

  await step(page, `Click "+ Create brand"`, async () => {
    await page.getByTestId('btn-create-brand-cta').click();
    await expect(page.getByTestId('create-brand-dialog')).toBeVisible();
  });

  await step(page, `Name the new brand "${name}" (currency/timezone default to INR / Asia-Kolkata)`, async () => {
    await page.getByTestId('input-dialog-brand-name').fill(name);
  });

  await step(page, `Submit — the create→switch chain must POST a real brand_id and get 200`, async () => {
    const setBrand = page.waitForResponse(SET_BRAND_OK);
    await page.getByTestId('btn-create-brand-dialog-submit').click();
    const res = await setBrand;
    expect(res.status(), 'set-brand after create must be 200, not 400 MISSING_BRAND_ID').toBe(200);
    expect(
      res.request().postData() ?? '',
      'set-brand body must carry a real brand_id, not {}',
    ).toMatch(UUID_IN_BODY);
    // Hard reload lands us back on the dashboard with the new brand active.
    await expect(page).toHaveURL(/\/dashboard/);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// POSITIVE — create a second brand and switch between the two brands
// ───────────────────────────────────────────────────────────────────────────────

test('POSITIVE: create a second brand → it becomes the active brand, switch back to the first', async ({
  page,
}) => {
  await announce(page, 'Multi-brand — create & switch');

  // onboardToDashboard creates the first brand, "E2E Brand", and lands on /dashboard.
  await step(page, 'Onboard a fresh user — this creates the first brand, "E2E Brand"', async () => {
    await onboardToDashboard(page, 'mb_swap');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await step(page, 'Confirm the active-brand selector shows "E2E Brand"', async () => {
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      activeBrandLabel('E2E Brand'),
    );
  });

  await step(page, 'Confirm the Brand Summary card is scoped to "E2E Brand"', async () => {
    const summary = page.getByTestId('brand-summary-card');
    await expect(summary).toBeVisible();
    await expect(summary.getByRole('heading', { name: 'E2E Brand' })).toBeVisible();
  });
  await pauseFor(page, 800);

  const second = `Second Brand ${Date.now()}`;
  await announce(page, 'Create the second brand');
  await createBrandFromSwitcher(page, second);

  await step(page, `The dialog is gone and "${second}" is now the active brand`, async () => {
    await expect(page.getByTestId('create-brand-dialog')).toBeHidden();
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      activeBrandLabel(second),
    );
  });

  await step(page, `The Brand Summary card now reads "${second}" — data is scoped to the active brand`, async () => {
    const summary = page.getByTestId('brand-summary-card');
    await expect(summary.getByRole('heading', { name: second })).toBeVisible();
  });
  await pauseFor(page, 1000);

  // Switch BACK to the original brand via its row's "Switch" button.
  await announce(page, 'Switch back to the first brand');
  await step(page, 'Open the switcher and pick "E2E Brand" again', async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    await expect(page.getByTestId('brand-switcher-list')).toBeVisible();
    const switchBack = page.waitForResponse(SET_BRAND_OK);
    await page.getByLabel('Switch to brand E2E Brand').click();
    const res = await switchBack;
    expect(res.status(), 'plain set-brand must be 200').toBe(200);
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await step(page, 'Active brand is "E2E Brand" again — round-trip works', async () => {
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      activeBrandLabel('E2E Brand'),
    );
    await expect(page.getByTestId('brand-summary-card').getByRole('heading', { name: 'E2E Brand' })).toBeVisible();
  });
  await pauseFor(page, 900);

  await step(page, 'Accessibility gate — the switcher + dashboard have zero axe violations', async () => {
    await expectNoA11yViolations(page);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// NEGATIVE (isolation) — after switching, the previous brand's data is not shown
// ───────────────────────────────────────────────────────────────────────────────

test('NEGATIVE: switching to brand B hides brand A — A is not the active brand and its summary is gone', async ({
  page,
}) => {
  await announce(page, 'Isolation — switching hides the other brand');

  await step(page, 'Onboard a fresh user — first brand is "E2E Brand"', async () => {
    await onboardToDashboard(page, 'mb_iso');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  const brandB = `Isolated B ${Date.now()}`;
  await createBrandFromSwitcher(page, brandB);

  await step(page, `Active brand is now "${brandB}" — and the summary card no longer reads "E2E Brand"`, async () => {
    // POSITIVE side: B is active and shown.
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      activeBrandLabel(brandB),
    );
    const summary = page.getByTestId('brand-summary-card');
    await expect(summary.getByRole('heading', { name: brandB })).toBeVisible();

    // NEGATIVE assertion: brand A's name is NOT the headline brand any more.
    await expect(summary.getByRole('heading', { name: 'E2E Brand' })).toHaveCount(0);
    await expect(page.getByTestId('brand-switcher-toggle')).not.toHaveAttribute(
      'aria-label',
      activeBrandLabel('E2E Brand'),
    );
  });
  await pauseFor(page, 1000);

  await step(page, 'A fresh, unconnected brand shows an HONEST empty state — no fabricated numbers', async () => {
    // kpi-realized renders the literal "No data yet" for a brand with no integrations.
    // This proves the KPI surface is scoped to the (empty) active brand, not leaking
    // any other brand's figures.
    const realized = page.getByTestId('kpi-realized');
    await expect(realized).toBeVisible();
    await expect(realized.getByText('No data yet')).toBeVisible();
  });
  await pauseFor(page, 900);

  await step(page, 'Brand A is still reachable — it is listed in the picker, just not active', async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    const list = page.getByTestId('brand-switcher-list');
    await expect(list).toBeVisible();
    // Both of THIS user's brands appear; A carries a "Switch to brand" affordance (not active).
    await expect(list.getByText('E2E Brand')).toBeVisible();
    await expect(list.getByText(brandB)).toBeVisible();
    await expect(page.getByLabel('Switch to brand E2E Brand')).toBeVisible();
    // Close the dropdown again.
    await page.getByTestId('brand-switcher-toggle').click();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// NEGATIVE (membership isolation) — the picker only lists brands the user is a member of
// ───────────────────────────────────────────────────────────────────────────────

test('NEGATIVE: the brand picker only lists brands the signed-in user is a member of', async ({
  page,
}) => {
  await announce(page, 'Isolation — the picker is membership-scoped');

  // User ONE: owns "E2E Brand" + a uniquely-named second brand.
  const userOneSecret = `Owner-Only Brand ${Date.now()}`;
  let userOne: { email: string; password: string };

  await step(page, 'User ONE onboards and creates a privately-named second brand', async () => {
    userOne = await onboardToDashboard(page, 'mb_owner');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await createBrandFromSwitcher(page, userOneSecret);

  await step(page, `User ONE's picker lists BOTH of their brands: "E2E Brand" and "${userOneSecret}"`, async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    const list = page.getByTestId('brand-switcher-list');
    await expect(list.getByText('E2E Brand')).toBeVisible();
    await expect(list.getByText(userOneSecret)).toBeVisible();
    await page.getByTestId('brand-switcher-toggle').click();
  });
  await pauseFor(page, 800);

  // User TWO: a completely separate user with their own org/brand. They must NEVER see
  // user ONE's brands in their picker — that is brand-membership isolation at the UI layer.
  await announce(page, 'A different user signs in');
  await step(page, 'User TWO onboards into a brand-new, unrelated workspace', async () => {
    // Fresh browser context not required: onboarding overwrites the session cookie via
    // register → verify → login, so user TWO fully replaces user ONE's session here.
    await onboardToDashboard(page, 'mb_outsider');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await step(page, 'User TWO opens their brand picker', async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    await expect(page.getByTestId('brand-switcher-list')).toBeVisible();
  });

  await step(page, `User TWO does NOT see "${userOneSecret}" or user ONE's brand — only their own`, async () => {
    const list = page.getByTestId('brand-switcher-list');
    // The hard isolation assertion: user ONE's privately-named brand is absent.
    await expect(list.getByText(userOneSecret)).toHaveCount(0);
    // User TWO only has their own "E2E Brand" (every onboarding creates one with this name),
    // and crucially there is no "Switch to brand <user-one's secret>" affordance anywhere.
    await expect(page.getByLabel(`Switch to brand ${userOneSecret}`)).toHaveCount(0);
    await page.getByTestId('brand-switcher-toggle').click();
  });
  await pauseFor(page, 1000);

  await step(page, 'Accessibility gate — the membership-scoped picker has zero axe violations', async () => {
    await expectNoA11yViolations(page);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// NEGATIVE (no-op guard) — re-selecting the already-active brand makes no set-brand call
// ───────────────────────────────────────────────────────────────────────────────

test('NEGATIVE: re-selecting the already-active brand is a no-op (no redundant set-brand POST)', async ({
  page,
}) => {
  await announce(page, 'No-op guard — re-picking the active brand');

  await step(page, 'Onboard a fresh user (single brand "E2E Brand", which is active)', async () => {
    await onboardToDashboard(page, 'mb_noop');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  await step(page, 'Open the picker — the active brand has NO "Switch" button (it is already active)', async () => {
    await page.getByTestId('brand-switcher-toggle').click();
    const list = page.getByTestId('brand-switcher-list');
    await expect(list).toBeVisible();
    // The active brand's row omits the "Switch to brand E2E Brand" button by design
    // (brand-switcher.tsx only renders the Switch button when !isActive). So the user
    // cannot fire a redundant set-brand for the active brand from the UI at all.
    await expect(page.getByLabel('Switch to brand E2E Brand')).toHaveCount(0);
  });

  await step(page, 'Tracking that no set-brand call fires while the dropdown is open on the active brand', async () => {
    let setBrandFired = false;
    const listener = (res: Response) => {
      if (SET_BRAND_OK(res)) setBrandFired = true;
    };
    page.on('response', listener);
    // Toggle the dropdown closed and open again — purely UI, must not POST set-brand.
    await page.getByTestId('brand-switcher-toggle').click();
    await page.getByTestId('brand-switcher-toggle').click();
    await pauseFor(page, 600);
    page.off('response', listener);
    expect(setBrandFired, 'no set-brand POST should fire for the already-active brand').toBe(false);
    await expect(page.getByTestId('brand-switcher-toggle')).toHaveAttribute(
      'aria-label',
      activeBrandLabel('E2E Brand'),
    );
  });
});
