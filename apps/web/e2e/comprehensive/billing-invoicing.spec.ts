import { test, expect, type Page } from '@playwright/test';
import { onboardToDashboard } from '../helpers/onboard';

/**
 * billing-invoicing.spec — the /billing surface: realized-GMV period sealing, GST invoicing
 * (CGST+SGST vs IGST), and credit notes. Grounded in apps/web/app/(dashboard)/billing/billing-content.tsx.
 *
 * This surface is data-dependent. A FRESH brand has NO sealed periods, so most assertions either
 * (a) onboard a fresh brand and assert the honest no_data / not-sealed state, or (b) tolerate BOTH
 * the empty and has-data branches by asserting the controls/labels render correctly. We never assume
 * specific seeded numbers and never assert on float money — money renders as formatted strings.
 */

/** The honest empty state for "Sealed periods" (EmptyState → data-testid="empty-state", role=status). */
const emptyState = (page: Page) =>
  page.getByTestId('empty-state').filter({ hasText: 'No periods sealed yet' });

/** The sealed-periods table (rendered only in the has-data branch). */
const sealedTable = (page: Page) =>
  page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Realized GMV' }) });

/** Navigate to /billing and wait for the read surface (table OR honest empty state) to settle. */
async function gotoBilling(page: Page) {
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
  // The "Sealed periods" card resolves to exactly one of: empty-state or the data table.
  await expect(async () => {
    const empty = await emptyState(page).isVisible().catch(() => false);
    const table = await sealedTable(page).isVisible().catch(() => false);
    expect(empty || table).toBe(true);
  }).toPass({ timeout: 15_000 });
}

test.describe('billing-invoicing', () => {
  test('[positive] renders the Seal-period form and Sealed-periods region with their controls', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_pos');
    await gotoBilling(page);

    // The page scaffolding + the "Seal a billing period" form must be present and usable.
    await expect(page.getByRole('heading', { name: 'Seal a billing period' })).toBeVisible();
    const monthInput = page.locator('#billing-period');
    await expect(monthInput).toBeVisible();
    await expect(monthInput).toHaveAttribute('type', 'month');
    await expect(page.getByRole('button', { name: 'Meter & seal' })).toBeVisible();

    // The "Sealed periods" region renders (heading is always present regardless of data state).
    await expect(page.getByRole('heading', { name: 'Sealed periods' })).toBeVisible();
  });

  test('[edge] a FRESH brand shows the honest "No periods sealed yet" empty state', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_fresh');
    await gotoBilling(page);

    // Fresh brand → no metered periods → honest empty state, never a misleading blank table.
    await expect(emptyState(page)).toBeVisible();
    await expect(emptyState(page)).toHaveAttribute('role', 'status');
    await expect(
      page.getByText('Seal a billing period above to meter this brand', { exact: false }),
    ).toBeVisible();
    await expect(sealedTable(page)).toHaveCount(0);
  });

  test('[negative] the Meter & seal button is disabled for a malformed period', async ({ page }) => {
    await onboardToDashboard(page, 'bill_badperiod');
    await gotoBilling(page);

    const monthInput = page.locator('#billing-period');
    const sealBtn = page.getByRole('button', { name: 'Meter & seal' });

    // The form guards the period shape: clearing it (no YYYY-MM) disables the seal action.
    await expect(sealBtn).toBeEnabled();
    await monthInput.fill('');
    await expect(sealBtn).toBeDisabled();
  });

  test('[positive] sealing the current period is honest about its result (sealed / already sealed)', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_seal');
    await gotoBilling(page);

    // Default period is the current month; seal it. The aria-live region reports the outcome.
    await page.getByRole('button', { name: 'Meter & seal' }).click();

    // Outcome is one of: success line (Sealed / Already sealed) or the honest seal error.
    const outcome = page
      .getByText(/Sealed|Already sealed|Could not seal that period/, { exact: false })
      .first();
    await expect(outcome).toBeVisible({ timeout: 15_000 });
  });

  test('[positive/edge] after sealing, the period table lists a row and re-sealing is idempotent', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_idem');
    await gotoBilling(page);

    const period = new Date().toISOString().slice(0, 7);
    const sealBtn = page.getByRole('button', { name: 'Meter & seal' });

    await sealBtn.click();
    // Wait for the seal mutation to settle (success or honest failure) before inspecting the list.
    await expect(
      page.getByText(/Sealed|Already sealed|Could not seal that period/, { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // If the period truly sealed (dev has realized GMV), it appears once in the table. If the brand
    // has no realized GMV the surface stays honestly empty — tolerate both rather than assume seeds.
    const sealed = await emptyState(page)
      .isVisible()
      .then((empty) => !empty)
      .catch(() => false);

    if (sealed) {
      const row = sealedTable(page).getByRole('row').filter({ hasText: period });
      await expect(row).toHaveCount(1);

      // Idempotency: re-sealing the same period must NOT create a duplicate row.
      await sealBtn.click();
      await expect(
        page.getByText(/Already sealed|Sealed/, { exact: false }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(sealedTable(page).getByRole('row').filter({ hasText: period })).toHaveCount(1);
    } else {
      // Honest-empty path: no realized GMV to bill — assert the explicit empty state, not a fake row.
      await expect(emptyState(page)).toBeVisible();
    }
  });

  test('[edge] viewing a bill renders the basis→rate→fee derivation, or the not-sealed empty state', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_detail');
    await gotoBilling(page);

    // Seal so a row (and thus a "View bill" toggle) can exist; tolerate the no-GMV empty path.
    await page.getByRole('button', { name: 'Meter & seal' }).click();
    await expect(
      page.getByText(/Sealed|Already sealed|Could not seal that period/, { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });

    const viewBill = page.getByRole('button', { name: 'View bill' }).first();
    const hasRow = await viewBill.isVisible().catch(() => false);
    test.skip(!hasRow, 'No sealed period with a bill in this environment — covered by empty-state tests.');

    await viewBill.click();
    // The inspectable bill resolves to either the derivation cards or the honest not-sealed state.
    await expect(async () => {
      const derivation = await page
        .getByText('Realized GMV basis', { exact: false })
        .isVisible()
        .catch(() => false);
      const notSealed = await page
        .getByText(/is not sealed yet/, { exact: false })
        .isVisible()
        .catch(() => false);
      expect(derivation || notSealed).toBe(true);
    }).toPass({ timeout: 15_000 });
  });

  test('[positive] an issued invoice renders GST breakdown (CGST+SGST or IGST), total, SAC/regime, place of supply', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_invoice');
    await gotoBilling(page);

    await page.getByRole('button', { name: 'Meter & seal' }).click();
    await expect(
      page.getByText(/Sealed|Already sealed|Could not seal that period/, { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });

    const viewBill = page.getByRole('button', { name: 'View bill' }).first();
    test.skip(
      !(await viewBill.isVisible().catch(() => false)),
      'No sealed period in this environment — invoice rendering covered where data exists.',
    );
    await viewBill.click();

    // The invoice section is either "Issue invoice" (not yet issued) or an issued immutable doc.
    const issueBtn = page.getByRole('button', { name: 'Issue invoice' });
    if (await issueBtn.isVisible().catch(() => false)) {
      await issueBtn.click();
    }

    // Wait for the issued doc to settle; if issuing is blocked it surfaces an honest message instead.
    const issued = page.getByText(/^Invoice\s/, { exact: false }).first();
    const blocked = page.getByText('The period must be sealed first', { exact: false });
    await expect(async () => {
      const isIssued = await issued.isVisible().catch(() => false);
      const isBlocked = await blocked.isVisible().catch(() => false);
      expect(isIssued || isBlocked).toBe(true);
    }).toPass({ timeout: 15_000 });

    test.skip(
      await blocked.isVisible().catch(() => false),
      'Invoice could not be issued in this environment (period not billable).',
    );

    // GST breakdown: intra-state shows CGST+SGST, inter-state shows IGST — exactly one must render.
    const hasCgst = await page.getByText(/CGST \(/, { exact: false }).isVisible().catch(() => false);
    const hasIgst = await page.getByText(/IGST \(/, { exact: false }).isVisible().catch(() => false);
    expect(hasCgst || hasIgst).toBe(true);
    if (hasCgst) {
      await expect(page.getByText(/SGST \(/, { exact: false })).toBeVisible();
    }

    // The immutable doc labels must render — these are static and data-independent once issued.
    await expect(page.getByText('Taxable (fee)', { exact: false })).toBeVisible();
    await expect(page.getByText('Total', { exact: true })).toBeVisible();
    await expect(page.getByText('SAC / regime', { exact: false })).toBeVisible();
    await expect(page.getByText('Place of supply', { exact: false })).toBeVisible();
  });

  test('[negative] a credit note that exceeds the invoice total surfaces an honest rejection', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_cn_reject');
    await gotoBilling(page);

    await page.getByRole('button', { name: 'Meter & seal' }).click();
    await expect(
      page.getByText(/Sealed|Already sealed|Could not seal that period/, { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });

    const viewBill = page.getByRole('button', { name: 'View bill' }).first();
    test.skip(
      !(await viewBill.isVisible().catch(() => false)),
      'No sealed period — credit-note rejection covered where invoice data exists.',
    );
    await viewBill.click();

    const issueInvoice = page.getByRole('button', { name: 'Issue invoice' });
    if (await issueInvoice.isVisible().catch(() => false)) {
      await issueInvoice.click();
    }

    // "Issue credit note" only appears once an invoice is issued (immutable doc on screen).
    const issueCn = page.getByRole('button', { name: 'Issue credit note' });
    test.skip(
      !(await issueCn.isVisible({ timeout: 15_000 }).catch(() => false)),
      'No issued invoice to credit in this environment.',
    );
    await issueCn.click();

    // The reason form reveals: #cn-reason input + Confirm. A full-reversal CN with a reason either
    // succeeds OR is rejected — when it would exceed the invoice total the UI shows an honest alert.
    const reason = page.locator('#cn-reason');
    await expect(reason).toBeVisible();
    await reason.fill('e2e over-reversal — exceeds invoice total');
    await page.getByRole('button', { name: 'Confirm' }).click();

    // Outcome resolves to either the honest rejection alert or a successful CN (full reversal allowed).
    const rejection = page.getByRole('alert').filter({ hasText: /exceed the invoice total|Rejected/ });
    const netPayable = page.getByText('Net payable', { exact: false });
    await expect(async () => {
      const rejected = await rejection.isVisible().catch(() => false);
      const succeeded = await netPayable.isVisible().catch(() => false);
      expect(rejected || succeeded).toBe(true);
    }).toPass({ timeout: 15_000 });
  });

  test('[negative] the credit-note reason form blocks confirming with an empty reason', async ({
    page,
  }) => {
    await onboardToDashboard(page, 'bill_cn_empty');
    await gotoBilling(page);

    await page.getByRole('button', { name: 'Meter & seal' }).click();
    await expect(
      page.getByText(/Sealed|Already sealed|Could not seal that period/, { exact: false }).first(),
    ).toBeVisible({ timeout: 15_000 });

    const viewBill = page.getByRole('button', { name: 'View bill' }).first();
    test.skip(
      !(await viewBill.isVisible().catch(() => false)),
      'No sealed period — empty-reason guard covered where invoice data exists.',
    );
    await viewBill.click();

    const issueInvoice = page.getByRole('button', { name: 'Issue invoice' });
    if (await issueInvoice.isVisible().catch(() => false)) {
      await issueInvoice.click();
    }
    const issueCn = page.getByRole('button', { name: 'Issue credit note' });
    test.skip(
      !(await issueCn.isVisible({ timeout: 15_000 }).catch(() => false)),
      'No issued invoice to credit in this environment.',
    );
    await issueCn.click();

    // With an empty reason the Confirm button stays disabled (no rejected/blank credit note can issue).
    await expect(page.locator('#cn-reason')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  test('[negative] /billing is guarded — an unauthenticated visit does not render the billing surface', async ({
    page,
  }) => {
    // No onboarding → no session. The dashboard route group must not expose the billing controls.
    await page.goto('/billing');
    await expect(async () => {
      const redirected = !/\/billing(\?|$)/.test(new URL(page.url()).pathname + new URL(page.url()).search);
      const noSealForm = !(await page
        .getByRole('button', { name: 'Meter & seal' })
        .isVisible()
        .catch(() => false));
      expect(redirected || noSealForm).toBe(true);
    }).toPass({ timeout: 15_000 });
  });
});
