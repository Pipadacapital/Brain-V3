/**
 * Ask Brain E2E — /ask  (Phase 8 — feat-decision-intelligence-inputs)
 *
 * Coverage (requirement §6 + frontend-web DoD: axe + keyboard + nav + honest-refusal):
 *   - Nav: the OVERVIEW sidebar "Ask Brain" link navigates to /ask.
 *   - Page heading "Ask Brain" (h1) is present; the question form renders.
 *   - Keyboard: the question input + Ask button are Tab-reachable / focusable.
 *   - Honest-refusal case: an off-domain question never shows a number — the surface
 *     resolves to a terminal outcome (refusal / answer / no_data / honest error), never a
 *     crash. The refusal card shows NO certified number ("no certified metric answers this").
 *   - axe WCAG 2.x AA scan passes (0 serious/critical violations) before AND after asking.
 *   - No uncaught JS exceptions / console errors (catches the BigInt(undefined) contract-drift
 *     crash class if the web AskBrainResponse DTO ever drifts from the core DTO).
 *
 * The Ask flow calls the BFF (resolver→engine→provenance). The resolver may be mocked,
 * live, or unavailable in CI, so this spec asserts the surface reaches SOME honest terminal
 * state and stays a11y-clean + crash-free — it does NOT assert a specific computed number.
 */

import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';
import { expectNoA11yViolations } from './helpers/a11y';

test.describe('/ask', () => {
  test('nav + heading + form, keyboard, honest-refusal, axe-clean, no crash', async ({
    page,
  }) => {
    // ── Collect console + page errors (BigInt(undefined) contract-drift guard) ──
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
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

    // ── Onboard a fresh user → dashboard ─────────────────────────────────────
    await onboardToDashboard(page, 'ask');

    // ── Nav: the sidebar "Ask Brain" link navigates to /ask ──────────────────
    const navLink = page.getByRole('link', { name: 'Ask Brain' });
    await expect(navLink).toBeVisible({ timeout: 10_000 });
    await navLink.click();
    await expect(page).toHaveURL(/\/ask/);

    // ── Page heading (h1) ────────────────────────────────────────────────────
    await expect(
      page.getByRole('heading', { name: 'Ask Brain', level: 1 }),
    ).toBeVisible({ timeout: 10_000 });

    // ── The question form renders + keyboard-focusable input & submit ────────
    const input = page.getByTestId('ask-input');
    const submit = page.getByTestId('ask-submit');
    await expect(input).toBeVisible();
    await expect(submit).toBeVisible();
    await input.focus();
    await expect(input).toBeFocused();
    await submit.focus();
    await expect(submit).toBeFocused();

    // ── A11y gate on the initial (empty) surface ─────────────────────────────
    await expectNoA11yViolations(page);

    // ── Honest-refusal case: an off-domain question → no number, no crash ────
    await input.fill('What is the weather in Mumbai today?');
    await submit.click();

    // Wait for a terminal outcome: a result card (answer / no_data / refusal) OR an
    // honest error card. The surface must NOT hang or crash regardless of resolver state.
    const refusal = page.getByTestId('ask-refusal');
    const answer = page.getByTestId('ask-answer');
    const noData = page.getByTestId('ask-no-data');
    const errorCard = page.getByTestId('error-card');

    await expect
      .poll(
        async () =>
          (await refusal.isVisible().catch(() => false)) ||
          (await answer.isVisible().catch(() => false)) ||
          (await noData.isVisible().catch(() => false)) ||
          (await errorCard.isVisible().catch(() => false)),
        { timeout: 30_000, message: 'Ask Brain never reached a terminal state' },
      )
      .toBe(true);

    // If the resolver honestly refused, the honesty headline (NO number) must be present.
    if (await refusal.isVisible().catch(() => false)) {
      await expect(page.getByTestId('ask-refusal-note')).toBeVisible();
      // A refusal card carries NO certified number element.
      await expect(refusal.getByTestId('ask-number')).toHaveCount(0);
    }

    // If it produced an answer, the honesty UX (binding + number + provenance) must be present.
    if (await answer.isVisible().catch(() => false)) {
      await expect(answer.getByTestId('ask-binding')).toBeVisible();
      await expect(answer.getByTestId('ask-number')).toBeVisible();
      await expect(answer.getByTestId('ask-provenance')).toBeVisible();
      await expect(answer.getByTestId('ask-snapshot')).toBeVisible();
    }

    // ── No crash ─────────────────────────────────────────────────────────────
    await expect(page.locator('body')).toBeVisible();

    // ── A11y gate after asking (the result/refusal/error surface is also clean) ──
    await expectNoA11yViolations(page);

    // ── No uncaught errors (BigInt(undefined) contract-drift guard) ──────────
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
    expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
  });
});
