# Watchable Demo Harness

Runs the Playwright E2E suite **slow, headed, and narrated** — designed for stakeholder walkthroughs where the audience needs to read the UI, not just see a test pass.

## Prerequisites

The dev stack must be running before you start:

```sh
# From the repo root
pnpm dev
```

This starts the Next.js frontend (port 3000), the BFF, core service (port 3001), Postgres, and Redis.

## Run the demo

```sh
pnpm --filter @brain/web test:e2e:demo
```

To slow it down further (e.g. 1 second between each action):

```sh
PW_SLOWMO=1000 pnpm --filter @brain/web test:e2e:demo
```

To run only one specific demo spec:

```sh
pnpm --filter @brain/web exec playwright test --config=playwright.demo.config.ts --headed e2e/demo/onboarding.spec.ts
```

## Timing environment variables

| Variable      | Default | Effect                                                       |
|---------------|---------|--------------------------------------------------------------|
| `PW_SLOWMO`   | `700`   | Milliseconds of slow-motion applied to every Playwright action |
| `PW_STEP_MS`  | `900`   | How long the caption banner shows before the action runs     |
| `PW_RESULT_MS`| `700`   | How long to pause after the action so the result is visible  |

## HTML report and videos

After a run, Playwright writes:

- **HTML report:** `apps/web/playwright-report/index.html`
  Open with: `pnpm --filter @brain/web exec playwright show-report`
- **Videos:** `apps/web/test-results/<test-name>/video.webm`
  Each test records a full video (config: `video: 'on'`).
- **Traces:** `apps/web/test-results/<test-name>/trace.zip`
  View with: `pnpm --filter @brain/web exec playwright show-trace <path-to-trace.zip>`

## Writing demo specs

Place specs in `apps/web/e2e/demo/`. Import all helpers from the single barrel:

All narration + onboarding + db + a11y helpers come from the single barrel
`./helpers/demo` (relative to a spec in `e2e/demo/`):

```ts
import { test, expect } from '@playwright/test';
import {
  // narration
  step, pauseFor, announce,
  // onboarding flow (re-exported from e2e/helpers/onboard.ts)
  registerAndVerify, login, onboardToDashboard,
  // db (re-exported from e2e/helpers/db.ts)
  markEmailVerified,
  // a11y gate (re-exported from e2e/helpers/a11y.ts)
  expectNoA11yViolations,
} from './helpers/demo';

test('Registration walkthrough', async ({ page }) => {
  await announce(page, 'User Registration');

  await step(page, 'Navigate to the registration page', async () => {
    await page.goto('/register');
  });

  await step(page, 'Fill in name, email, and password', async () => {
    await page.getByTestId('input-full-name').fill('Demo User');
    await page.getByTestId('input-email').fill('demo@example.com');
    await page.getByTestId('input-password').fill('SuperSecret123!');
  });

  await step(page, 'Submit the registration form', async () => {
    await page.getByTestId('btn-register').click();
    await expect(page).toHaveURL(/\/verify-email/);
  });

  await pauseFor(page, 1500); // let audience appreciate the verify-email screen
});
```

## Directory layout

```
apps/web/
  playwright.demo.config.ts       # separate config — does not touch playwright.config.ts
  e2e/
    demo/
      README.md                   # this file
      helpers/
        demo.ts                   # step / pauseFor / announce + re-exports of onboard + db
      # place your *.spec.ts files here, e.g.:
      # onboarding.spec.ts
      # dashboard-overview.spec.ts
    helpers/
      onboard.ts                  # registerAndVerify(page,prefix) / login(page,email,pw) / onboardToDashboard(page,prefix)
      db.ts                       # markEmailVerified(email)
      a11y.ts                     # expectNoA11yViolations(page, opts?)
    global-setup.ts               # clears Redis rate-limit keys (shared by both configs)
```

## Differences from the CI smoke config

| Dimension        | CI smoke (`playwright.config.ts`) | Demo (`playwright.demo.config.ts`) |
|------------------|-----------------------------------|------------------------------------|
| testDir          | `./e2e`                           | `./e2e/demo`                       |
| headless         | yes                               | **no**                             |
| slowMo           | 0 (or `PW_SLOWMO` if set)        | **700 ms default**                 |
| timeout          | 60 000 ms                         | **180 000 ms**                     |
| expect.timeout   | 10 000 ms                         | **15 000 ms**                      |
| video            | off                               | **on**                             |
| trace            | on-first-retry                    | **on (always)**                    |
| workers          | 1                                 | 1                                  |
| retries          | 1 (CI) / 0 (local)               | 0                                  |

The existing CI smoke suite in `apps/web/e2e/` is untouched.
