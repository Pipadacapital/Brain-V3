// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import type {
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  VerifyEmailRequest,
  OkResponse,
  CurrentUserResponse,
  SessionRefreshResponse,
  SetOrgRequest,
  SetOrgResponse,
  OnboardingAdvanceRequest,
  OnboardingAdvanceResponse,
} from '../types';
import { bffFetch, generateRequestId, BFF_BASE } from './core';

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  // feat-onboarding-ux: register goes through the BFF (not the cookie-less public
  // /v1/auth/register). For a genuinely-new user the BFF mints a real authenticated
  // session and sets the httpOnly `brain_session` cookie — the user lands in the wizard
  // already authenticated (no manual /login). On success we bootstrap a session-bound
  // CSRF token up front (mirrors authApi.login) so the first wizard mutation doesn't 403.
  // The session cookie is the only auth surface — no token is ever returned to JS (XSS-safe).
  register: async (body: RegisterRequest): Promise<RegisterResponse> => {
    const res = await bffFetch<RegisterResponse>('/v1/bff/register', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    // Only a freshly-created user gets a session cookie; bind a CSRF token to it.
    if (res.created && typeof document !== 'undefined') {
      await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    }
    return res;
  },

  verifyEmail: (body: VerifyEmailRequest) =>
    bffFetch<OkResponse>('/v1/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  // Login goes through the BFF session route, which sets the httpOnly `brain_session`
  // cookie (the raw /v1/auth/login route returns the token in the body and sets no
  // cookie — unusable from the browser). All subsequent requests authenticate via
  // that cookie (bridged to a Bearer header server-side).
  login: async (body: LoginRequest): Promise<LoginResponse> => {
    const res = await bffFetch<LoginResponse>('/v1/bff/session', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    // Refresh the CSRF token now that a session exists — the token is bound to the
    // session, so a pre-login token would be rejected on the first authenticated
    // mutation. Re-issuing here gives a session-bound token up front (no 403/retry).
    if (typeof document !== 'undefined') {
      await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    }
    return res;
  },

  logout: () =>
    bffFetch<OkResponse>('/v1/auth/logout', {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  forgotPassword: (body: ForgotPasswordRequest) =>
    bffFetch<OkResponse>('/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  resetPassword: (body: ResetPasswordRequest) =>
    bffFetch<OkResponse>('/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  me: () => bffFetch<CurrentUserResponse>('/v1/auth/me'),

  // feat-onboarding-ux: the BFF /me also returns onboarding_status (authoritative wizard
  // position) and email_verified — used by the OnboardingGate (forward-only routing) and
  // the verify-email banner. Distinct from authApi.me() which hits the raw /v1/auth/me.
  bffMe: () => bffFetch<CurrentUserResponse>('/v1/bff/me'),
};

// ── Session ───────────────────────────────────────────────────────────────────

export const sessionApi = {
  refresh: () =>
    bffFetch<SessionRefreshResponse>('/v1/bff/session/refresh', {
      method: 'POST',
      idempotencyKey: generateRequestId(),
    }),

  /** Switch active org context. Re-mints the session cookie and returns onboarding_status. */
  setOrg: (body: SetOrgRequest) =>
    bffFetch<SetOrgResponse>('/v1/bff/session/set-org', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),

  /** Advance the wizard onboarding_status (forward-only). */
  advanceOnboarding: (body: OnboardingAdvanceRequest) =>
    bffFetch<OnboardingAdvanceResponse>('/v1/bff/session/onboarding/advance', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    }),
};
