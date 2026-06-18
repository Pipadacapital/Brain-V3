/**
 * Onboarding website → tracking-ready / add-website + Tracking Center E2E
 * (feat-onboarding-website, Track B).
 *
 * Coverage:
 *   1. Fill the website at onboarding → brand-create auto-provisions the per-brand pixel →
 *      the "tracking is ready" interstitial shows THIS brand's install snippet + host.
 *   2. Skip the website ("Create without a website") → the honest "add your website to start
 *      tracking" state (no faked snippet) → Continue advances the wizard.
 *   3. The Tracking Center (/settings/pixel) surfaces the install snippet + status + the
 *      inline add-website→provision path for a brand that skipped at onboarding.
 *
 * Honesty invariant: a snippet is only shown when an installation actually exists; the
 * skipped path never fabricates one. Status indicators are icon+text, not colour-only.
 *
 * The install_token is server-derived + brand-scoped via the BFF (the FE never sends a
 * brand_id); these specs assert the surfaced snippet/host, not the token plumbing (proven
 * under brain_app in the core live tests).
 */

import { test, expect, type Page } from '@playwright/test';
import { registerAndVerify } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

/**
 * feat-onboarding-ux: register auto-logs-in and lands on the merged create step
 * (/onboarding/start), which carries BOTH the workspace name and the brand fields (incl. the
 * website + live host preview). This helper fills the workspace name and leaves the brand
 * name / website to the individual tests (the website→pixel UX is the thing under test).
 */
async function toBrandStep(page: Page, prefix: string): Promise<void> {
  await registerAndVerify(page, prefix);
  await expect(page).toHaveURL(/\/onboarding\/start/);
  await page.getByTestId('input-workspace-name').fill('OW Workspace');
}

test.describe('onboarding website → tracking', () => {
  test('fills website → tracking-ready state with install snippet', async ({ page }) => {
    await toBrandStep(page, 'ow_site');

    // Website is recommended + prominent; a live preview shows the canonical host.
    await page.getByTestId('input-brand-name').fill('OW Site Brand');
    await page.getByTestId('input-brand-domain').fill('https://OW-Store.com/products?ref=x');
    await expect(page.getByTestId('brand-domain-preview')).toContainText('ow-store.com');

    await page.getByTestId('btn-create-brand').click();

    // → tracking interstitial in the snippet state (website provided).
    await expect(page).toHaveURL(/\/onboarding\/tracking\?w=1/);
    await expect(page.getByTestId('tracking-ready-snippet')).toBeVisible({ timeout: 15_000 });

    // The snippet + the canonical host are surfaced for THIS brand.
    await expect(page.getByTestId('tracking-ready-host')).toContainText('ow-store.com');
    await expect(page.getByTestId('tracking-ready-snippet-code')).toContainText('/pixel.js');
    await expect(page.getByTestId('tracking-ready-badge')).toBeVisible();
    await expect(page.getByTestId('btn-copy-tracking-snippet')).toBeVisible();

    await expectNoA11yViolations(page);

    // Continue advances the wizard.
    await page.getByTestId('btn-tracking-continue').click();
    await expect(page).toHaveURL(/\/onboarding\/(integrations|done)|\/dashboard/);
  });

  test('skips website → honest add-website state', async ({ page }) => {
    await toBrandStep(page, 'ow_skip');

    await page.getByTestId('input-brand-name').fill('OW Skip Brand');
    // No website typed; use the first-class Skip action.
    await page.getByTestId('btn-skip-website').click();

    // → tracking interstitial in the add-website state (no faked snippet).
    await expect(page).toHaveURL(/\/onboarding\/tracking\?w=0/);
    await expect(page.getByTestId('tracking-ready-skipped')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tracking-ready-skipped')).toContainText(
      'Add your website to start tracking',
    );
    // It must NOT pretend a snippet exists.
    await expect(page.getByTestId('tracking-ready-snippet-code')).toHaveCount(0);
    await expect(page.getByTestId('link-add-website')).toBeVisible();

    await expectNoA11yViolations(page);

    await page.getByTestId('btn-tracking-continue').click();
    await expect(page).toHaveURL(/\/onboarding\/(integrations|done)|\/dashboard/);
  });

  test('Tracking Center surfaces snippet + status + add-website path', async ({ page }) => {
    await toBrandStep(page, 'ow_tc');

    // Skip at onboarding so the brand reaches the Tracking Center with no installation,
    // exercising the inline "add website → provision" path.
    await page.getByTestId('input-brand-name').fill('OW TC Brand');
    await page.getByTestId('btn-skip-website').click();
    await expect(page).toHaveURL(/\/onboarding\/tracking\?w=0/);

    await page.goto('/settings/pixel');
    await expect(
      page.getByRole('heading', { name: 'Tracking Center', level: 1 }),
    ).toBeVisible({ timeout: 10_000 });

    // No installation yet → the generate (provision) card is offered.
    await expect(page.getByTestId('pixel-generate-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('btn-generate-pixel')).toBeVisible();

    // Provision inline → snippet + target_host surface.
    await page.getByTestId('btn-generate-pixel').click();
    await expect(page.getByTestId('pixel-snippet-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pixel-snippet')).toContainText('/pixel.js');

    await expectNoA11yViolations(page);
  });
});
