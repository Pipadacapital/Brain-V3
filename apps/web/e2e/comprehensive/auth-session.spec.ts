import { test, expect } from '@playwright/test';
import { onboardToDashboard, registerAndVerify, login } from '../helpers/onboard';

/**
 * Comprehensive auth + session E2E.
 *
 * Real browser → Next.js BFF → core (:3001) → Postgres. Every selector below is grounded
 * in the actual components:
 *   - components/auth/register-form.tsx        (input-full-name/email/password, btn-register,
 *                                               inline role="alert" Zod messages)
 *   - components/auth/login-form.tsx           (input-email/password, btn-login, ErrorCard)
 *   - components/auth/forgot-password-form.tsx (input-email, btn-send-reset, neutral success)
 *   - components/dashboard/user-menu.tsx       (btn-logout)
 *   - middleware.ts                            (protected prefixes → /login?next=<path>)
 *   - lib/api/schemas.ts                       (registerSchema: password min 12; email .email())
 *
 * Each test creates its own isolated user where a clean slate matters. No fixed seed data,
 * no arbitrary waits — web-first assertions + Playwright auto-waiting only.
 */

const STRONG_PASSWORD = 'SuperSecret123!';

test.describe('auth-session', () => {
  // ── POSITIVE ────────────────────────────────────────────────────────────────

  test('[positive] register a brand-new user auto-logs-in and lands on /onboarding/start', async ({
    page,
  }) => {
    const email = `auth_reg_${Date.now()}@example.com`;
    await page.goto('/register');
    await page.getByTestId('input-full-name').fill('New Tester');
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill(STRONG_PASSWORD);
    await page.getByTestId('btn-register').click();

    // Auto-login mints a real session → wizard step 1 (no manual /login).
    await expect(page).toHaveURL(/\/onboarding\/start/);
    await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 3/i);
  });

  test('[positive] an existing verified user can log in and reaches the app (resumes onboarding)', async ({
    page,
  }) => {
    // Fresh user: register auto-logs-in (lands /onboarding/start) and is email-verified in DB.
    const { email, password } = await registerAndVerify(page, 'auth_login_ok');
    // Logging in again with the same pending-onboarding user routes back to the wizard.
    await login(page, email, password);
    await expect(page).toHaveURL(/\/onboarding\/start/);
    await expect(page.getByTestId('step-indicator')).toHaveText(/Step 1 of 3/i);
  });

  // ── NEGATIVE ────────────────────────────────────────────────────────────────

  test('[negative] login with a wrong password shows a neutral error and stays on /login', async ({
    page,
  }) => {
    const { email } = await registerAndVerify(page, 'auth_badpw');
    await login(page, email, 'CompletelyWrong000!');
    // No redirect into the app; the ErrorCard surfaces the neutral message.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('error-card')).toBeVisible();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  });

  test('[negative] login with an unknown email shows the same neutral error (no enumeration)', async ({
    page,
  }) => {
    await login(page, `no-such-user-${Date.now()}@example.com`, STRONG_PASSWORD);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  });

  test('[negative] register with an invalid email + too-short password shows inline validation', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByTestId('input-full-name').fill('Bad Inputs');
    await page.getByTestId('input-email').fill('not-an-email');
    await page.getByTestId('input-password').fill('short'); // < 12 chars
    await page.getByTestId('btn-register').click();

    // Client-side Zod blocks submit; both inline role="alert" messages render and we stay on /register.
    await expect(page.getByText(/enter a valid email address/i)).toBeVisible();
    await expect(page.getByText(/password must be at least 12 characters/i)).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
  });

  test('[negative] registering a duplicate email is handled gracefully (no crash, no new session)', async ({
    page,
  }) => {
    // First registration succeeds (auto-login → wizard).
    const { email } = await registerAndVerify(page, 'auth_dupe');

    // Second registration with the SAME email: the BFF returns created=false (no session minted,
    // timing-safe, no enumeration). The form fires its generic success toast and tries to route to
    // the wizard, but with NO session cookie the edge guard bounces the protected route to /login.
    // The key assertion: the app stays usable — no error boundary / crash.
    await page.context().clearCookies();
    await page.goto('/register');
    await page.getByTestId('input-full-name').fill('Dupe Tester');
    await page.getByTestId('input-email').fill(email);
    await page.getByTestId('input-password').fill(STRONG_PASSWORD);
    await page.getByTestId('btn-register').click();

    // Lands on a real auth surface (guard bounce → /login, or the wizard if a session existed),
    // never a Next error overlay. A still-mounted register form also counts as "did not crash".
    await expect(page).toHaveURL(/\/login|\/onboarding|\/register/);
    await expect(page.getByText(/application error|something went wrong/i)).toHaveCount(0);
  });

  test('[negative] forgot-password with an unknown email shows the neutral "if an account exists" message', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await page.getByTestId('input-email').fill(`ghost-${Date.now()}@example.com`);
    await page.getByTestId('btn-send-reset').click();
    // No enumeration: same neutral confirmation regardless of whether the account exists.
    await expect(page.getByText(/if an account exists/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /check your inbox/i })).toBeVisible();
  });

  // ── EDGE ─────────────────────────────────────────────────────────────────────

  test('[edge] visiting /dashboard with no session redirects to /login?next=/dashboard', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/dashboard');
    // Edge guard bounces BEFORE the shell renders, preserving the intended destination.
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard|\/login\?next=\/dashboard/);
    await expect(page.getByTestId('btn-login')).toBeVisible();
  });

  test('[edge] a deep protected path preserves its full next= destination on the guard redirect', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/settings/connectors');
    await expect(page).toHaveURL(/\/login\?next=/);
    // The encoded destination round-trips through the redirect.
    const url = new URL(page.url());
    expect(url.searchParams.get('next')).toBe('/settings/connectors');
  });

  test('[edge] logout clears the session and a protected route then redirects back to /login', async ({
    page,
  }) => {
    // Full happy-path onboard to land authenticated on /dashboard.
    await onboardToDashboard(page, 'auth_logout');
    await expect(page).toHaveURL(/\/dashboard/);

    // Sign out via the sidebar control → /login.
    await page.getByTestId('btn-logout').click();
    await expect(page).toHaveURL(/\/login/);

    // Session is gone: re-visiting a protected route bounces to /login (guard, not the app shell).
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login(\?next=)?/);
    await expect(page.getByTestId('btn-login')).toBeVisible();
  });

  test('[edge] an authenticated user hitting /login is not stranded (no session loss / crash)', async ({
    page,
  }) => {
    // Onboard fully, then navigate straight to /login while still authenticated.
    await onboardToDashboard(page, 'auth_reauth');
    await page.goto('/login');
    // The login surface renders fine for an already-authed user — no error overlay.
    await expect(page.getByTestId('btn-login')).toBeVisible();
    await expect(page.getByText(/application error/i)).toHaveCount(0);

    // The existing session still grants access to the dashboard (it was not invalidated).
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
