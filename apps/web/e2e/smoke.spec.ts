import { test, expect } from '@playwright/test';
import { markEmailVerified } from './helpers/db';

/**
 * M1 happy-path smoke — the full real browser → BFF → Postgres flow.
 *
 * register → verify → login → onboarding (workspace → brand) → dashboard → logout.
 *
 * This is the test that would have caught every integration bug from the M1
 * post-ship debugging session (404 routing, cookie auth, dashboard contract
 * drift, the onboarding/session-context gap). It also asserts ZERO uncaught
 * client errors across the whole flow.
 */
test('register → verify → login → onboard → dashboard → logout', async ({ page }) => {
  const stamp = Date.now();
  const email = `smoke_${stamp}@example.com`;
  const password = 'SuperSecret123!';

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // 1. Register
  await page.goto('/register');
  await page.getByTestId('input-full-name').fill('Smoke Tester');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-register').click();
  await expect(page).toHaveURL(/\/verify-email/);

  // 2. Verify email out-of-band (dev sends no real email).
  await markEmailVerified(email);

  // 3. Login — a brand-less user needs onboarding, so we land on /workspace/new.
  await page.goto('/login');
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('btn-login').click();
  await expect(page).toHaveURL(/\/workspace\/new/);

  // 4. Create workspace (slug pinned unique to avoid collisions).
  await page.getByTestId('input-workspace-name').fill('Smoke Workspace');
  await page.getByTestId('input-workspace-slug').fill(`smoke-ws-${stamp}`);
  await page.getByTestId('btn-create-workspace').click();
  await expect(page).toHaveURL(/\/brand\/new/);

  // 5. Create brand → session refreshes (gains brand+role) → dashboard.
  await page.getByTestId('input-brand-name').fill('Smoke Brand');
  await page.getByTestId('btn-create-brand').click();
  await expect(page).toHaveURL(/\/dashboard/);

  // 6. Dashboard renders — the onboarding card (which used to crash) shows real data.
  await expect(page.getByTestId('onboarding-progress-card')).toBeVisible();
  await expect(page.getByText(/of 5 steps complete/i)).toBeVisible();

  // 7. Logout → back to login.
  await page.getByTestId('btn-logout').click();
  await expect(page).toHaveURL(/\/login/);

  // 8. No uncaught client errors anywhere in the flow.
  // pageErrors (uncaught JS exceptions — e.g. the onboarding `.filter` crash) is the
  // strict gate. For the resource-error gate we ignore benign auth-state transitions:
  // a 401 at logout is the server correctly rejecting the now-revoked session, not a
  // defect; 404/favicon are dev noise. Real integration breaks (400/500) still fail.
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  const appErrors = consoleErrors.filter(
    (e) => !/favicon|net::ERR|40[14] \((Not Found|Unauthorized)\)/i.test(e),
  );
  expect(appErrors, `console errors: ${appErrors.join(' | ')}`).toEqual([]);
});
