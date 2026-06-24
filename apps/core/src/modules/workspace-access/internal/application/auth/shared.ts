/**
 * workspace-access application — shared auth primitives.
 *
 * Cross-cutting types, constants, token helpers and the pure brand-resolution
 * decision shared by the cohesive auth application services (RegistrationService,
 * SessionService, UserLifecycleService, ContextService) and re-exported by the
 * thin AuthService facade so existing callers keep their imports.
 *
 * SECURITY INVARIANTS (preserved verbatim from the former monolithic auth.service):
 *  - NN-5: argon2id (m=19456, t=2, p=1) asserted at startup.
 *  - NN-5: tokens are crypto.randomBytes(32) → sha256 hex, single-use, expiry-enforced.
 *  - I-S02: maskEmail emits no raw PII into logs/events.
 */

import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';

import type { RoleCode } from '../../domain/membership/entities.js';
import type { OnboardingStatus } from '../../domain/organization/entities.js';

/** Active brand/role context carried in the session JWT (all-null until onboarded). */
export interface ActiveContext {
  brandId: string | null;
  workspaceId: string | null;
  role: RoleCode | null;
  onboardingStatus: OnboardingStatus | null;
}

export const EMPTY_CONTEXT: ActiveContext = {
  brandId: null,
  workspaceId: null,
  role: null,
  onboardingStatus: null,
};

/** The membership fields brand-resolution needs (a structural subset of Membership). */
export interface ResolvableMembership {
  brandId: string | null;
  organizationId: string;
  roleCode: RoleCode;
}

/**
 * selectActiveContext — the PURE brand-resolution decision (no DB; unit-testable).
 *
 * Picks the FIRST non-null membership in priority order. The caller passes the preferred-workspace
 * membership ahead of the any-workspace fallback, so a fully-onboarded user resolves to a brand-level
 * membership (minting a real brand_id into the session JWT) rather than the brand-less org membership
 * (brand_id=null, which would break every brand-scoped surface — the safety property this guards).
 * No membership → EMPTY_CONTEXT (all-null). onboardingStatus comes from the resolved org.
 */
export function selectActiveContext(
  candidatesInPriorityOrder: ReadonlyArray<ResolvableMembership | null>,
  onboardingStatus: OnboardingStatus | null,
): ActiveContext {
  const m = candidatesInPriorityOrder.find((c): c is ResolvableMembership => c != null);
  if (!m) return EMPTY_CONTEXT;
  return {
    brandId: m.brandId,
    workspaceId: m.organizationId,
    role: m.roleCode,
    onboardingStatus,
  };
}

// ── Argon2id parameters (NN-5 / OWASP 2025 minimum) ──────────────────────────

export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456,  // m=19456 KiB
  timeCost: 2,        // t=2 iterations
  parallelism: 1,     // p=1
} as const;

/**
 * Assert argon2id parameters at startup (NN-5).
 * Call this from main.ts before any auth request is served.
 */
export function assertArgon2Params(): void {
  if (ARGON2_PARAMS.memoryCost < 19456) {
    throw new Error(`[auth] INVARIANT VIOLATION: argon2id memoryCost ${ARGON2_PARAMS.memoryCost} < 19456 (NN-5)`);
  }
  if (ARGON2_PARAMS.timeCost < 2) {
    throw new Error(`[auth] INVARIANT VIOLATION: argon2id timeCost ${ARGON2_PARAMS.timeCost} < 2 (NN-5)`);
  }
}

// ── Token helpers ─────────────────────────────────────────────────────────────

/** Generate a crypto-random token and return both the raw token and its sha256 hash. */
export function generateToken(): { rawToken: string; tokenHash: string } {
  const rawBytes = randomBytes(32);
  const rawToken = rawBytes.toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

/** Mask an email address for logging/events (no raw PII — I-S02). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  return `${local[0]}***@${domain}`;
}

// ── Token expiry ──────────────────────────────────────────────────────────────

export const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000;      // 1 hour (NN-5)
export const EMAIL_VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000;   // 24 hours
export const ACCESS_TOKEN_EXPIRY_SECS = 60 * 60;              // 1 hour
export const REFRESH_TOKEN_EXPIRY_SECS = 7 * 24 * 60 * 60;   // 7 days

// ── Config + error ─────────────────────────────────────────────────────────────

export interface AuthServiceConfig {
  jwtSigningSecret: string;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
