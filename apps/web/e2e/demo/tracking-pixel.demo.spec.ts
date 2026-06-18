/**
 * Tracking Center / first-party Brain Pixel — WATCHABLE demo spec.
 *
 * This is the slow, narrated sibling of `e2e/tracking-center.spec.ts` (the fast CI
 * smoke). Every meaningful UI action is wrapped in `step(...)` so a stakeholder can
 * watch the headed run and follow along from on-page caption banners; `announce(...)`
 * marks each section; `pauseFor(...)` lets a result land before moving on.
 *
 * The surface under test (`/settings/pixel` → <TrackingCenter/>) composes four sections,
 * verified against the REAL components (no invented selectors):
 *   1. Live verification  — components/pixel/live-verification.tsx
 *        testids: live-verification-card, verification-waiting | verification-received
 *   2. Setup / install    — components/pixel/pixel-wizard.tsx
 *        not-provisioned: pixel-generate-card + btn-generate-pixel
 *        provisioned:     pixel-status-card, pixel-snippet-card + pixel-snippet + btn-copy-snippet,
 *                         pixel-verify-card + btn-verify-pixel
 *   3. Tracking health    — components/pixel/tracking-health-panel.tsx
 *        testids: tracking-health-panel, tracking-health-status, kpi-total-events,
 *                 kpi-last-event, kpi-consent, kpi-quarantine, tracking-health-volume
 *   4. Event explorer     — components/pixel/event-explorer.tsx
 *        testids: event-explorer, empty-state ("No events yet")
 *
 * Honest-empty doctrine: a freshly-onboarded brand has NO Bronze events, so the
 * surface must tell the truth — "Waiting for your first event…", "No events yet",
 * KPIs without fabricated numbers, and the install/not-installed state — never a
 * faked "received" / "healthy". The NEGATIVE tests assert exactly that honesty.
 *
 * Scope note: we do NOT seed real Bronze events (no DB seam exists in db.ts for that),
 * so the "received / healthy / populated explorer" happy path is asserted as the
 * HONEST waiting/empty state for a fresh brand — which is the real, deterministic
 * outcome. See the per-test annotations.
 */

import { test, expect } from '@playwright/test';
import {
  step,
  pauseFor,
  announce,
  onboardToDashboard,
  expectNoA11yViolations,
} from './helpers/demo';

const PIXEL_URL = /\/settings\/pixel/;

test.describe('Tracking Center / Brain Pixel — watchable demo', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // POSITIVE 1 — the page renders all four sections for an onboarded user.
  // ─────────────────────────────────────────────────────────────────────────
  test('POSITIVE: Tracking Center page renders all four proof sections', async ({
    page,
  }) => {
    await announce(page, 'Tracking Center — the proof surface');

    await step(page, 'Register, verify, and onboard a fresh brand to the dashboard', async () => {
      await onboardToDashboard(page, 'tcdemo-render');
      await expect(page).toHaveURL(/\/dashboard/);
    });

    await step(page, 'Open the Brain Pixel page from the sidebar', async () => {
      await page.getByRole('link', { name: 'Brain Pixel' }).click();
      await expect(page).toHaveURL(PIXEL_URL);
    });

    await step(page, 'The page header reads "Tracking Center"', async () => {
      await expect(
        page.getByRole('heading', { name: 'Tracking Center', level: 1 }),
      ).toBeVisible({ timeout: 10_000 });
    });

    await step(page, 'The Tracking Center container is mounted', async () => {
      await expect(page.getByTestId('tracking-center')).toBeVisible({ timeout: 10_000 });
    });

    await step(page, 'Section 1 — Live verification card is present', async () => {
      await expect(page.getByTestId('live-verification-card')).toBeVisible({ timeout: 10_000 });
    });

    await step(page, 'Section 2 — Setup & installation heading is present', async () => {
      await expect(
        page.getByRole('heading', { name: 'Setup & installation' }),
      ).toBeVisible();
    });

    await step(page, 'Section 3 — Tracking health panel is present', async () => {
      await expect(page.getByTestId('tracking-health-panel')).toBeVisible({ timeout: 10_000 });
    });

    await step(page, 'Section 4 — Event Explorer is present', async () => {
      await expect(page.getByTestId('event-explorer')).toBeVisible({ timeout: 10_000 });
    });

    await pauseFor(page, 1200);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POSITIVE 2 — install snippet / install_token surface.
  // The wizard is in one of two real states for a fresh brand:
  //   (a) not provisioned  → pixel-generate-card + btn-generate-pixel  (the common case)
  //   (b) provisioned      → pixel-snippet-card with a real install snippet to copy
  // We assert whichever real state exists, and exercise it honestly.
  // ─────────────────────────────────────────────────────────────────────────
  test('POSITIVE: install snippet / install_token surface is shown and actionable', async ({
    page,
  }) => {
    await announce(page, 'Install snippet & install_token');

    await step(page, 'Onboard a fresh brand and open the Brain Pixel page', async () => {
      await onboardToDashboard(page, 'tcdemo-snippet');
      await page.goto('/settings/pixel');
      await expect(page).toHaveURL(PIXEL_URL);
    });

    const generateCard = page.getByTestId('pixel-generate-card');
    const snippetCard = page.getByTestId('pixel-snippet-card');

    // Resolve which real state the wizard is in (no fabrication — read the DOM).
    const isNotProvisioned = await generateCard
      .isVisible()
      .catch(() => false);

    if (isNotProvisioned) {
      await step(
        page,
        'Fresh brand has no pixel yet — the honest "Set up the Brain Pixel" card is shown',
        async () => {
          await expect(generateCard).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Set up the Brain Pixel' }),
          ).toBeVisible();
        },
      );

      await step(page, 'The "Generate pixel snippet" button is present and enabled', async () => {
        const genBtn = page.getByTestId('btn-generate-pixel');
        await expect(genBtn).toBeVisible();
        await expect(genBtn).toBeEnabled();
      });

      await step(
        page,
        'Generate the pixel — this provisions a real install_token via the BFF',
        async () => {
          await page.getByTestId('btn-generate-pixel').click();
        },
      );

      await step(
        page,
        'After provisioning, the install snippet (carrying the install_token) appears',
        async () => {
          await expect(snippetCard).toBeVisible({ timeout: 15_000 });
          const snippet = page.getByTestId('pixel-snippet');
          await expect(snippet).toBeVisible();
          // The snippet must carry a real install token — assert it is non-trivial.
          const snippetText = (await snippet.textContent()) ?? '';
          expect(snippetText.trim().length).toBeGreaterThan(20);
        },
      );
    } else {
      await step(
        page,
        'This brand already has a pixel — the install snippet card is shown directly',
        async () => {
          await expect(snippetCard).toBeVisible({ timeout: 15_000 });
          const snippet = page.getByTestId('pixel-snippet');
          await expect(snippet).toBeVisible();
          const snippetText = (await snippet.textContent()) ?? '';
          expect(snippetText.trim().length).toBeGreaterThan(20);
        },
      );

      await step(page, 'A "Pixel Status" card reflects the real backend state', async () => {
        await expect(page.getByTestId('pixel-status-card')).toBeVisible();
      });
    }

    // Either path now has a snippet card with a Copy control and a Verify card.
    await step(page, 'A "Copy" control is offered for the install snippet', async () => {
      await expect(page.getByTestId('btn-copy-snippet')).toBeVisible();
    });

    await step(page, 'The "Verify installation" card calls the real verify endpoint', async () => {
      await expect(page.getByTestId('pixel-verify-card')).toBeVisible();
      const verifyBtn = page.getByTestId('btn-verify-pixel');
      await expect(verifyBtn).toBeVisible();
      await expect(verifyBtn).toBeEnabled();
    });

    await pauseFor(page, 1200);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POSITIVE 3 — tracking-health surfaces render with honest KPIs + a11y gate.
  // ─────────────────────────────────────────────────────────────────────────
  test('POSITIVE: tracking-health surfaces render with honest KPIs, axe-clean', async ({
    page,
  }) => {
    await announce(page, 'Tracking health surface');

    await step(page, 'Onboard a fresh brand and open the Brain Pixel page', async () => {
      await onboardToDashboard(page, 'tcdemo-health');
      await page.goto('/settings/pixel');
      await expect(page).toHaveURL(PIXEL_URL);
    });

    await step(page, 'The tracking-health panel is mounted', async () => {
      await expect(page.getByTestId('tracking-health-panel')).toBeVisible({ timeout: 10_000 });
    });

    await step(
      page,
      'The status badge is a role="status" element — icon + text, never colour-only',
      async () => {
        const statusCard = page.getByTestId('tracking-health-status');
        await expect(statusCard).toBeVisible();
        // The honest verdict for a fresh, event-less brand is "No events yet".
        await expect(
          statusCard.getByText('No events yet', { exact: true }),
        ).toBeVisible();
        // And it is exposed as a status region for assistive tech (non-colour signal).
        await expect(statusCard.getByRole('status')).toBeVisible();
      },
    );

    await step(page, 'All four KPI tiles are present (events, last-event, consent, quarantine)', async () => {
      await expect(page.getByTestId('kpi-total-events')).toBeVisible();
      await expect(page.getByTestId('kpi-last-event')).toBeVisible();
      await expect(page.getByTestId('kpi-consent')).toBeVisible();
      await expect(page.getByTestId('kpi-quarantine')).toBeVisible();
    });

    await step(
      page,
      'Last-event KPI honestly reads "No events yet" for a fresh brand — no faked timestamp',
      async () => {
        await expect(
          page.getByTestId('kpi-last-event').getByText('No events yet'),
        ).toBeVisible();
      },
    );

    await step(
      page,
      'Quarantine KPI is an explicit "—" with a note — never a fabricated 0',
      async () => {
        const quarantine = page.getByTestId('kpi-quarantine');
        await expect(quarantine).toContainText('—');
        await expect(quarantine).toContainText('quarantine');
      },
    );

    await step(page, 'The "Events flowing" volume chart card is present', async () => {
      await expect(page.getByTestId('tracking-health-volume')).toBeVisible();
    });

    await step(
      page,
      'Accessibility gate — axe WCAG 2.x AA scan finds 0 serious/critical violations',
      async () => {
        await expectNoA11yViolations(page);
      },
    );

    await pauseFor(page, 1200);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NEGATIVE 1 — honest empty: no events → "waiting" verification + empty explorer.
  // This is the headline honesty contract: the proof surface must NOT claim
  // "received" / show event rows when no real Bronze event exists.
  // ─────────────────────────────────────────────────────────────────────────
  test('NEGATIVE: with no events, verification stays "waiting" and the explorer is honestly empty', async ({
    page,
  }) => {
    await announce(page, 'Honest empty — no events yet');

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
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await step(page, 'Onboard a brand-new brand (it has zero collected events)', async () => {
      await onboardToDashboard(page, 'tcdemo-empty');
      await page.goto('/settings/pixel');
      await expect(page).toHaveURL(PIXEL_URL);
    });

    await step(page, 'The Live verification card is present', async () => {
      await expect(page.getByTestId('live-verification-card')).toBeVisible({ timeout: 10_000 });
    });

    await step(
      page,
      'It honestly shows "Waiting for your first event…" — NOT a faked "received"',
      async () => {
        const waiting = page.getByTestId('verification-waiting');
        await expect(waiting).toBeVisible({ timeout: 10_000 });
        await expect(waiting).toContainText('Waiting for your first event');
        // The "received" state must be absent — nothing is faked.
        await expect(page.getByTestId('verification-received')).toHaveCount(0);
      },
    );

    await step(
      page,
      'A disclaimer states plainly that nothing is faked here',
      async () => {
        await expect(
          page.getByText('No event has reached Brain for this brand yet'),
        ).toBeVisible();
      },
    );

    await step(page, 'Scroll down to the Event Explorer', async () => {
      await page.getByTestId('event-explorer').scrollIntoViewIfNeeded();
    });

    await step(
      page,
      'The Event Explorer shows the honest "No events yet" empty state',
      async () => {
        const explorer = page.getByTestId('event-explorer');
        await expect(explorer).toBeVisible({ timeout: 10_000 });
        await expect(explorer.getByTestId('empty-state')).toBeVisible();
        await expect(explorer.getByText('No events yet', { exact: true })).toBeVisible();
        // There must be NO event rows — the recent-events list is absent.
        await expect(
          explorer.getByRole('list', { name: 'Recent collected events' }),
        ).toHaveCount(0);
      },
    );

    await step(page, 'No uncaught JS exceptions occurred on the honest-empty surface', async () => {
      expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toHaveLength(0);
      expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toHaveLength(0);
    });

    await pauseFor(page, 1400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NEGATIVE 2 — a brand with no installed/verified pixel shows the honest
  // "not installed / set up" state, NOT a green "Connected".
  // ─────────────────────────────────────────────────────────────────────────
  test('NEGATIVE: a brand with no installed pixel shows the honest "not installed / set up" state', async ({
    page,
  }) => {
    await announce(page, 'Honest not-installed state');

    await step(page, 'Onboard a fresh brand (integrations skipped — no pixel installed)', async () => {
      await onboardToDashboard(page, 'tcdemo-noinstall');
      await page.goto('/settings/pixel');
      await expect(page).toHaveURL(PIXEL_URL);
    });

    await step(page, 'The setup wizard is present below the verification card', async () => {
      await expect(page.getByTestId('tracking-center')).toBeVisible({ timeout: 10_000 });
    });

    // For a brand that has not installed a pixel, the wizard either offers to
    // generate one (not provisioned) OR — if provisioned but unverified — shows a
    // non-"Connected" status. Either way it must NOT claim a verified connection.
    const generateCard = page.getByTestId('pixel-generate-card');
    const statusCard = page.getByTestId('pixel-status-card');

    const isNotProvisioned = await generateCard.isVisible().catch(() => false);

    if (isNotProvisioned) {
      await step(
        page,
        'No pixel exists yet — the honest "Set up the Brain Pixel" prompt is shown (not "Connected")',
        async () => {
          await expect(generateCard).toBeVisible();
          await expect(
            page.getByRole('heading', { name: 'Set up the Brain Pixel' }),
          ).toBeVisible();
          // There is no verified status badge claiming "Connected".
          await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
        },
      );
    } else {
      await step(
        page,
        'A pixel exists but is unverified — the status must NOT read "Connected"',
        async () => {
          await expect(statusCard).toBeVisible({ timeout: 10_000 });
          await expect(
            statusCard.getByText('Connected', { exact: true }),
          ).toHaveCount(0);
          // It should reflect a real not-yet-verified state (waiting / syncing / failed).
          const statusText = (await statusCard.textContent()) ?? '';
          expect(
            /Waiting for data|Syncing|Verification failed/.test(statusText),
            `Unverified pixel must show a non-connected state, got: ${statusText}`,
          ).toBe(true);
        },
      );
    }

    await step(
      page,
      'The tracking-health verdict is also honest: "No events yet", not "Healthy"',
      async () => {
        const trackingStatus = page.getByTestId('tracking-health-status');
        await expect(trackingStatus).toBeVisible({ timeout: 10_000 });
        await expect(
          trackingStatus.getByText('No events yet', { exact: true }),
        ).toBeVisible();
        await expect(
          trackingStatus.getByText('Healthy', { exact: true }),
        ).toHaveCount(0);
      },
    );

    await pauseFor(page, 1400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SKIPPED — populated "received / healthy / event rows" happy path.
  // No DB/HTTP seam exists in the test helpers to inject a real Bronze event for a
  // brand (db.ts exports ONLY markEmailVerified; there is no event-seeding helper,
  // and getLastInviteLink does not exist). The honesty doctrine forbids faking a
  // received event, so the populated flip cannot be demonstrated end-to-end here.
  // The NEGATIVE "waiting/empty" tests above ARE the real deterministic outcome for
  // an un-seeded environment; this skip documents the missing seam, not a defect.
  // ─────────────────────────────────────────────────────────────────────────
  test.skip('POSITIVE: verification flips to "received" + explorer lists real events (needs event-seeding seam)', async () => {
    // Intentionally empty: requires a helper to land a real Bronze event for the
    // brand (e.g. db.seedBronzeEvent(brandId, ...) or a pixel-ingest HTTP call).
    // Once that exists, assert: getByTestId('verification-received') visible,
    // tracking-health-status reads "Healthy", kpi-total-events shows a real count,
    // and event-explorer renders a getByRole('list', { name: 'Recent collected events' }).
  });
});
