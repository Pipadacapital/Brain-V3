/**
 * Auth domain entities.
 *
 * AppUser: the user-global login identity.
 * Session: access/refresh JWT + revocation denylist row.
 * PasswordResetToken: single-use reset token (hashed).
 * EmailVerificationToken: single-use email verification token (hashed).
 */

// ── AppUser entity ────────────────────────────────────────────────────────────

export type UserStatus = 'active' | 'suspended';

export interface AppUser {
  id: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ── Session entity ────────────────────────────────────────────────────────────

export interface UserSession {
  id: string;
  appUserId: string;
  /** JWT id — the denylist key (NN-3). */
  jti: string;
  /** sha256 of the rotating refresh secret (never plaintext — I-S09). */
  refreshTokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

// ── PasswordResetToken entity ─────────────────────────────────────────────────

export interface PasswordResetToken {
  id: string;
  appUserId: string;
  /** sha256(crypto.randomBytes(32)) — never stored plaintext (NN-5 / I-S09). */
  tokenHash: string;
  /** issued_at + 1h (NN-5). */
  expiresAt: Date;
  /** Set on first use to prevent replay (NN-5 single-use). */
  usedAt: Date | null;
  createdAt: Date;
}

// ── EmailVerificationToken entity ─────────────────────────────────────────────

export interface EmailVerificationToken {
  id: string;
  appUserId: string;
  /** sha256(crypto.randomBytes(32)) — never stored plaintext (NN-5 / I-S09). */
  tokenHash: string;
  /** issued_at + 24h (NN-5). */
  expiresAt: Date;
  /** Set on first use to prevent replay (NN-5 single-use). */
  usedAt: Date | null;
  createdAt: Date;
}

// ── JWT claims (ADR-006 shaped) ───────────────────────────────────────────────
// These claims must be compatible with Authentik fronting later (D0.1).

export interface JwtClaims {
  sub: string;         // app_user.id
  brand_id: string | null;      // active brand (null until brand is selected)
  workspace_id: string | null;  // active workspace (null until workspace is created)
  role: string | null;          // role_code in active scope
  jti: string;         // user_session.jti — used for revocation denylist
  iat: number;
  exp: number;
}
