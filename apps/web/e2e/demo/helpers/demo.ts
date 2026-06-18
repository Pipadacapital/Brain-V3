/**
 * Demo narration helpers — make Playwright runs watchable for stakeholders.
 *
 * The stakeholder complaint: "the suite is so fast I don't get a chance to see
 * the UI." These helpers inject on-page caption banners and deliberate pauses so
 * a live audience can read what is happening as it happens — no need to follow
 * the test runner's terminal output.
 *
 * Timings are tunable via env (combine with PW_SLOWMO in playwright.demo.config.ts):
 *   PW_STEP_MS   — how long the caption holds BEFORE the action runs (default 900ms)
 *   PW_RESULT_MS — how long to pause AFTER the action so the result is visible (default 700ms)
 *
 * Usage — import EVERYTHING from this one barrel:
 *   import { test, expect } from '@playwright/test';
 *   import { step, pauseFor, announce, onboardToDashboard } from './helpers/demo';
 *
 *   test('Onboarding walkthrough', async ({ page }) => {
 *     await announce(page, 'Onboarding');
 *     await step(page, 'Open the registration page', async () => {
 *       await page.goto('/register');
 *     });
 *     await step(page, 'Submit and land on verify-email', async () => {
 *       await page.getByTestId('btn-register').click();
 *       await expect(page).toHaveURL(/\/verify-email/);
 *     });
 *   });
 */

import type { Page } from '@playwright/test';

// Re-export upstream helpers so spec authors only need ONE import path.
export { registerAndVerify, login, onboardToDashboard } from '../../helpers/onboard';
export { markEmailVerified } from '../../helpers/db';
export { expectNoA11yViolations, type A11yOptions } from '../../helpers/a11y';

const STEP_MS = Number(process.env.PW_STEP_MS ?? 900);
const RESULT_MS = Number(process.env.PW_RESULT_MS ?? 700);

const CAPTION_ID = '__demo_caption__';

/** Escape a user-supplied label so it can't break out of the caption HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The last caption rendered, remembered so we can RE-INJECT it after a navigation
 * wipes the DOM. `step`/`announce` set this; the post-action pause restores it.
 */
let lastCaption: { html: string; big: boolean } | null = null;

/**
 * Inject (or replace) the caption overlay div in the current page context.
 *
 * Wrapped in try/catch: during a navigation the execution context can be
 * destroyed mid-evaluate. We never want a cosmetic banner to fail a demo, so we
 * swallow the error and let the next `step`/re-inject put it back.
 */
async function renderCaption(page: Page, html: string, big: boolean): Promise<void> {
  lastCaption = { html, big };
  try {
    await page.evaluate(
      ({ id, content, isBig }: { id: string; content: string; isBig: boolean }) => {
        let el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          document.body.appendChild(el);
        }

        Object.assign(el.style, {
          position: 'fixed',
          top: isBig ? '0' : '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: '2147483647', // max 32-bit int — above any app overlay/toast
          background: 'rgba(15, 15, 20, 0.88)',
          color: '#f5f5f7',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontSize: isBig ? '30px' : '19px',
          fontWeight: isBig ? '700' : '500',
          lineHeight: '1.4',
          padding: isBig ? '22px 36px' : '13px 30px',
          borderRadius: isBig ? '0' : '10px',
          width: isBig ? '100%' : 'auto',
          maxWidth: isBig ? '100%' : '82vw',
          textAlign: 'center',
          boxShadow: '0 6px 28px rgba(0,0,0,0.55)',
          backdropFilter: 'blur(5px)',
          letterSpacing: isBig ? '0.04em' : '0.01em',
          boxSizing: 'border-box',
          pointerEvents: 'none', // never intercept clicks the action needs
        });

        el.innerHTML = content;
      },
      { id: CAPTION_ID, content: html, isBig: big },
    );
  } catch {
    // Execution context torn down by an in-flight navigation — ignore; the
    // post-action re-inject (or the next step) will restore the banner.
  }
}

/**
 * Re-inject the most recent caption if a navigation wiped it from the new DOM.
 * No-op when there is no remembered caption.
 */
async function reinjectIfMissing(page: Page): Promise<void> {
  if (!lastCaption) return;
  try {
    const present = await page.evaluate(
      (id: string) => !!document.getElementById(id),
      CAPTION_ID,
    );
    if (!present) {
      await renderCaption(page, lastCaption.html, lastCaption.big);
    }
  } catch {
    // Page mid-navigation again — leave it; the next step re-establishes context.
  }
}

/**
 * A plain visible pause — no caption change, just waits so the UI can settle and
 * the audience can read the current screen.
 *
 * @param page Playwright Page
 * @param ms   Milliseconds to wait (default 1000)
 */
export async function pauseFor(page: Page, ms = 1000): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Show a step caption banner (top-center), hold so the viewer reads it, run the
 * optional action, RE-INJECT the banner if the action navigated away, then hold
 * again so the result is visible before the next step.
 *
 * @param page   Playwright Page
 * @param label  Human-readable step description shown in the overlay
 * @param action Optional async action to run while the caption is displayed
 */
export async function step(
  page: Page,
  label: string,
  action?: () => Promise<void>,
): Promise<void> {
  await renderCaption(page, escapeHtml(label), false);

  // Hold long enough for a viewer to read the label before anything happens.
  await pauseFor(page, STEP_MS);

  if (action) {
    await action();
  }

  // The action may have navigated — put the caption back so the result is
  // narrated, then hold so the audience sees the outcome.
  await reinjectIfMissing(page);
  await pauseFor(page, RESULT_MS);
}

/**
 * Show a bigger, full-width section announcement banner. Use it at the start of
 * each logical group of steps (e.g. "Onboarding", "Dashboard Overview") so the
 * audience always knows which part of the product they are watching.
 *
 * The banner persists (it is the running section header) until the next `step`
 * or `announce` overwrites it.
 *
 * @param page  Playwright Page
 * @param title Section title to display prominently
 */
export async function announce(page: Page, title: string): Promise<void> {
  const html =
    `<span style="opacity:0.6;font-size:0.55em;text-transform:uppercase;` +
    `letter-spacing:0.14em;display:block;margin-bottom:6px">Now showing</span>` +
    escapeHtml(title);

  await renderCaption(page, html, true);
  // Hold a beat longer than a normal step so the section title lands.
  await pauseFor(page, Math.round(STEP_MS * 1.6));
}
