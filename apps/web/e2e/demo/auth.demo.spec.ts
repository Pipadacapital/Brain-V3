import { test, expect } from '@playwright/test';
import {
  step,
  pauseFor,
  announce,
  registerAndVerify,
  login,
  onboardToDashboard,
  expectNoA11yViolations,
} from './helpers/demo';

/**
 * WATCHABLE AUTHENTICATION DEMO — narrated, headed, slow.
 *
 * Every meaningful UI action is wrapped in `step(page, "<plain English>", …)` so a
 * stakeholder watching the headed run can follow the story without reading the
 * terminal. `announce(page, …)` opens each test with a section banner.
 *
 * Covers POSITIVE and NEGATIVE paths for the Authentication area:
 *   register (valid)     · register: invalid email, weak password, duplicate email
 *   email verification   · verify via the real dev-token one-click path
 *   login (valid)        · login: wrong password, rate-limit 429
 *   logout               · route guards (logged-out → /login)
 *
 * Selectors below were GREPPED from the real components — never invented:
 *   - register-form.tsx / login-form.tsx → input-full-name, input-email,
 *     input-password, btn-register, btn-login (field errors render as role="alert").
 *   - error-card.tsx → data-testid="error-card" (surfaces the BFF message + request_id).
 *   - verify-email-form.tsx → btn-dev-verify-now (dev one-click token verify).
 *   - user-menu.tsx → btn-logout, current-user-email.
 *
 * Real backend behaviours encoded (verified against apps/core):
 *   - Invalid email / <12-char password are caught CLIENT-SIDE by the Zod resolver
 *     (schemas.ts) → the form never submits; field error appears; URL stays put.
 *   - Duplicate email is timing-safe / no-enumeration: the backend returns 201 and the
 *     form routes to /verify-email exactly as a fresh signup would (no error leak).
 *   - Wrong password → 401 INVALID_CREDENTIALS → stays on /login + neutral ErrorCard.
 *   - 6th consecutive failed login (email+IP) → 429 "Too many failed login attempts."
 *     (auth limiter = 5 failures / 900s; rl:* keys are cleared by global-setup.)
 *
 * Honest skip (see the bottom of this file): there is NO "login blocked because the
 * email is unverified" surface — the backend login path does not gate on
 * email_verified_at, so an unverified user with valid creds is issued a session
 * (BFF returns email_verified:false). Verification is enforced at register-redirect
 * and at invite-accept, not at the login form. The skipped test documents this.
 */

// ───────────────────────────────────────────────────────────────────────────────
// REGISTRATION — positive
// ───────────────────────────────────────────────────────────────────────────────

test('register: a valid signup creates the account and lands on verify-email', async ({ page }) => {
  await announce(page, 'Register — valid signup');

  const email = `demo_reg_${Date.now()}@example.com`;

  await step(page, 'Open the Create Account page', async () => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible();
  });

  await step(page, 'Check the registration form is accessible (axe — 0 serious/critical)', async () => {
    await expectNoA11yViolations(page);
  });

  await step(page, 'Type the full name', async () => {
    await page.getByTestId('input-full-name').fill('Demo Stakeholder');
  });

  await step(page, `Type a fresh email — ${email}`, async () => {
    await page.getByTestId('input-email').fill(email);
  });

  await step(page, 'Type a strong 12+ character password', async () => {
    await page.getByTestId('input-password').fill('SuperSecret123!');
  });

  await step(page, 'Submit — the account is created', async () => {
    await page.getByTestId('btn-register').click();
  });

  await step(page, 'We land on “Check your email” (verify-email) for THIS address', async () => {
    await expect(page).toHaveURL(/\/verify-email/);
    await expect(page.getByText(/check your email/i)).toBeVisible();
    // The page echoes the exact address the link was sent to.
    await expect(page.getByText(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))).toBeVisible();
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// REGISTRATION — negative: invalid email format
// ───────────────────────────────────────────────────────────────────────────────

test('register: an invalid email format is rejected before submit', async ({ page }) => {
  await announce(page, 'Register — invalid email is blocked');

  await step(page, 'Open the Create Account page', async () => {
    await page.goto('/register');
  });

  await step(page, 'Fill the name and a strong password', async () => {
    await page.getByTestId('input-full-name').fill('Demo Stakeholder');
    await page.getByTestId('input-password').fill('SuperSecret123!');
  });

  await step(page, 'Type a malformed email — “not-an-email”', async () => {
    await page.getByTestId('input-email').fill('not-an-email');
  });

  await step(page, 'Click Create account — the form refuses to submit', async () => {
    await page.getByTestId('btn-register').click();
  });

  await step(page, 'A field error appears and we STAY on /register (no account made)', async () => {
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByText(/enter a valid email address/i)).toBeVisible();
    // aria-invalid is set on the email input for screen readers.
    await expect(page.getByTestId('input-email')).toHaveAttribute('aria-invalid', 'true');
  });

  await pauseFor(page, 1000);
});

// ───────────────────────────────────────────────────────────────────────────────
// REGISTRATION — negative: weak / short password
// ───────────────────────────────────────────────────────────────────────────────

test('register: a weak (<12-char) password is rejected before submit', async ({ page }) => {
  await announce(page, 'Register — weak password is blocked');

  await step(page, 'Open the Create Account page', async () => {
    await page.goto('/register');
  });

  await step(page, 'Fill a valid name and email', async () => {
    await page.getByTestId('input-full-name').fill('Demo Stakeholder');
    await page.getByTestId('input-email').fill(`demo_weakpw_${Date.now()}@example.com`);
  });

  await step(page, 'Type a too-short password — “short1!”', async () => {
    await page.getByTestId('input-password').fill('short1!');
  });

  await step(page, 'Click Create account — the password rule blocks it', async () => {
    await page.getByTestId('btn-register').click();
  });

  await step(page, 'The “at least 12 characters” error shows; we STAY on /register', async () => {
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
    await expect(page.getByTestId('input-password')).toHaveAttribute('aria-invalid', 'true');
  });

  await pauseFor(page, 1000);
});

// ───────────────────────────────────────────────────────────────────────────────
// REGISTRATION — negative: duplicate email (no enumeration leak)
// ───────────────────────────────────────────────────────────────────────────────

test('register: a duplicate email does NOT leak that the account exists', async ({ page }) => {
  await announce(page, 'Register — duplicate email (privacy-safe)');

  // First, register a real account so the email genuinely exists.
  const { email } = await registerAndVerify(page, 'demo_dupe');

  await step(page, 'Now try to register the SAME email a second time', async () => {
    await page.goto('/register');
    await page.getByTestId('input-full-name').fill('Impostor');
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill('SuperSecret123!');
  });

  await step(page, 'Submit — the backend stays timing-safe and gives no “already exists” hint', async () => {
    await page.getByTestId('btn-register').click();
  });

  await step(page, 'We route to verify-email exactly like a fresh signup — no enumeration', async () => {
    // Privacy guarantee: an attacker cannot tell a taken email from a free one.
    await expect(page).toHaveURL(/\/verify-email/);
    await expect(page.getByText(/check your email/i)).toBeVisible();
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — positive (real dev-token one-click path)
// ───────────────────────────────────────────────────────────────────────────────

test('verify-email: the dev one-click token flow verifies and routes to /login', async ({ page }) => {
  await announce(page, 'Email verification — real token flow');

  const email = `demo_verify_${Date.now()}@example.com`;

  await step(page, 'Register a brand-new account', async () => {
    await page.goto('/register');
    await page.getByTestId('input-full-name').fill('Verify Demo');
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill('SuperSecret123!');
    await page.getByTestId('btn-register').click();
    await expect(page).toHaveURL(/\/verify-email/);
  });

  await step(page, 'In dev there is no inbox — the page offers a one-click “Verify now (dev)”', async () => {
    // The backend captured the verification token at register time; the page fetches it.
    await expect(page.getByTestId('btn-dev-verify-now')).toBeVisible();
  });

  await step(page, 'Click “Verify now (dev)” — the token is redeemed', async () => {
    await page.getByTestId('btn-dev-verify-now').click();
  });

  await step(page, 'Verification succeeds and we are sent to sign in', async () => {
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /sign in to brain/i })).toBeVisible();
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// LOGIN — positive (verified user signs in and is routed by onboarding status)
// ───────────────────────────────────────────────────────────────────────────────

test('login: a verified user signs in and resumes onboarding at step 1', async ({ page }) => {
  await announce(page, 'Login — valid credentials');

  // Register + mark verified via the shared helper (SQL shortcut — no inbox in dev).
  const { email, password } = await registerAndVerify(page, 'demo_login_ok');

  await step(page, 'Open the Sign In page', async () => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in to brain/i })).toBeVisible();
  });

  await step(page, 'Check the login form is accessible (axe — 0 serious/critical)', async () => {
    await expectNoA11yViolations(page);
  });

  await step(page, `Enter the verified email — ${email}`, async () => {
    await page.getByTestId('input-email').fill(email);
  });

  await step(page, 'Enter the correct password', async () => {
    await page.getByTestId('input-password').fill(password);
  });

  await step(page, 'Sign in — the httpOnly session cookie is set by the BFF', async () => {
    await page.getByTestId('btn-login').click();
  });

  await step(page, 'A new account has no workspace yet → routed to onboarding step 1', async () => {
    await expect(page).toHaveURL(/\/workspace\/new/);
    await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 4/i);
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// LOGIN — negative: wrong password
// ───────────────────────────────────────────────────────────────────────────────

test('login: a wrong password shows a neutral error and stays on /login', async ({ page }) => {
  await announce(page, 'Login — wrong password is rejected');

  const { email } = await registerAndVerify(page, 'demo_badpw');

  await step(page, 'Open the Sign In page', async () => {
    await page.goto('/login');
  });

  await step(page, `Enter the real email — ${email}`, async () => {
    await page.getByTestId('input-email').fill(email);
  });

  await step(page, 'Enter a DELIBERATELY wrong password', async () => {
    await page.getByTestId('input-password').fill('TotallyWrong999!');
  });

  await step(page, 'Sign in — the backend returns 401 INVALID_CREDENTIALS', async () => {
    await page.getByTestId('btn-login').click();
  });

  await step(page, 'A neutral error shows (no “user vs password” hint); we STAY on /login', async () => {
    await expect(page).toHaveURL(/\/login/);
    const errorCard = page.getByTestId('error-card');
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText(/invalid email or password/i);
    // The error region is announced to assistive tech.
    await expect(errorCard).toHaveAttribute('role', 'alert');
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// LOGIN — negative: rate-limit 429 after repeated failures
// ───────────────────────────────────────────────────────────────────────────────

test('login: repeated wrong passwords trip the rate limiter (429)', async ({ page }) => {
  await announce(page, 'Login — brute-force is rate-limited');

  const { email } = await registerAndVerify(page, 'demo_ratelimit');

  await step(page, 'Open the Sign In page', async () => {
    await page.goto('/login');
  });

  await step(page, 'Enter the real email once', async () => {
    await page.getByTestId('input-email').fill(email);
  });

  // The auth limiter is 5 failures / 900s per (email+IP); the 6th attempt → 429.
  // Hammer the wrong password until the rate-limit message appears (or we exhaust tries).
  let limited = false;
  await step(page, 'Submit a wrong password repeatedly to simulate a brute-force attack', async () => {
    for (let attempt = 1; attempt <= 8 && !limited; attempt++) {
      await page.getByTestId('input-password').fill(`WrongPassword${attempt}!`);
      await page.getByTestId('btn-login').click();
      // Wait for either the rate-limit message or the generic invalid-credentials error.
      const card = page.getByTestId('error-card');
      await expect(card).toBeVisible();
      const text = (await card.textContent())?.toLowerCase() ?? '';
      if (text.includes('too many')) {
        limited = true;
      }
    }
  });

  await step(page, 'The rate-limit (429) message is now shown — the account is protected', async () => {
    const errorCard = page.getByTestId('error-card');
    await expect(errorCard).toBeVisible();
    // The backend 429 message is "Too many failed login attempts. Please try again later."
    await expect(errorCard).toContainText(/too many/i);
    // Still on /login — never let a brute-forcer in.
    await expect(page).toHaveURL(/\/login/);
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// ROUTE GUARDS — negative: logged-out access is redirected to /login
// ───────────────────────────────────────────────────────────────────────────────

test('route guard: visiting /dashboard while logged out redirects to /login', async ({ page }) => {
  await announce(page, 'Route guard — logged-out is blocked');

  await step(page, 'Make sure we are logged out (clear all cookies)', async () => {
    await page.context().clearCookies();
  });

  await step(page, 'Try to open the protected dashboard directly', async () => {
    await page.goto('/dashboard');
  });

  await step(page, 'The auth guard bounces us to the Sign In page', async () => {
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /sign in to brain/i })).toBeVisible();
  });

  await step(page, 'A deep settings route is protected too', async () => {
    await page.goto('/settings/connectors');
    await expect(page).toHaveURL(/\/login/);
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// LOGOUT — positive (then the guard keeps the now-stale session out)
// ───────────────────────────────────────────────────────────────────────────────

test('logout: signing out ends the session and re-blocks the dashboard', async ({ page }) => {
  await announce(page, 'Logout — end the session');

  // Full onboarding so we genuinely land inside the authenticated dashboard shell.
  const { email } = await onboardToDashboard(page, 'demo_logout');

  await step(page, 'We are signed in and sitting on the dashboard', async () => {
    await expect(page).toHaveURL(/\/dashboard/);
    // The sidebar footer shows the signed-in user's email.
    await expect(page.getByTestId('current-user-email')).toContainText(email);
  });

  await step(page, 'Click “Log out” — the server revokes the session, the cookie is cleared', async () => {
    await page.getByTestId('btn-logout').click();
  });

  await step(page, 'We are returned to the Sign In page', async () => {
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /sign in to brain/i })).toBeVisible();
  });

  await step(page, 'The session is truly gone — re-opening /dashboard bounces back to /login', async () => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  await pauseFor(page, 1200);
});

// ───────────────────────────────────────────────────────────────────────────────
// HONEST SKIP — "login before email verified" has no UI block today
// ───────────────────────────────────────────────────────────────────────────────

test.skip('login: an UNVERIFIED user is blocked at the login form', async ({ page }) => {
  // SKIP REASON (verified against apps/core/.../auth.service.ts login()):
  //   The backend login path does NOT gate on app_user.email_verified_at — it checks
  //   only credentials + (status !== 'suspended'). So an unverified user with valid
  //   credentials is ISSUED a session, and the BFF /v1/bff/session route returns 200
  //   with email_verified:false rather than an error. There is therefore NO
  //   "verify your email before signing in" surface on the login form to assert.
  //
  //   Email-verification IS enforced elsewhere — at register-redirect (→ /verify-email)
  //   and at invite-accept (USER_UNVERIFIED 403, "Verify your email first") — but not
  //   at login. Asserting a non-existent block here would be a fabricated selector.
  //
  //   Secondary gap: the shared helpers (registerAndVerify) always mark the email
  //   verified, and there is no register-WITHOUT-verify helper, so even the precondition
  //   (an unverified-but-registered user driven through the browser) is not expressible
  //   without re-implementing onboarding — which this suite must not do.
  //
  //   To make this a real test, the login path would need an EMAIL_NOT_VERIFIED 403 +
  //   a matching message on the login form; once that ships (plus a register-only
  //   helper), unskip and assert it.
  await login(page, 'unverified@example.com', 'SuperSecret123!');
  await expect(page.getByTestId('error-card')).toContainText(/verify your email/i);
});
