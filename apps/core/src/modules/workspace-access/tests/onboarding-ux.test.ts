/**
 * onboarding-ux.test.ts — unit tests for feat-onboarding-ux (no live DB).
 *
 * Covers (each security invariant has a NEGATIVE CONTROL that fails if removed):
 *   D1: registerAndStartSession mints a session ONLY for created=true; an email
 *       collision returns created=false with NO tokens (no auto-login leak).
 *   D2: requireVerifiedEmail → 403 EMAIL_NOT_VERIFIED (not 401) when unverified;
 *       passes (no reply) when verified; fail-closed (403) when the user is missing.
 *   D4: deriveSlug — lowercase/hyphenate/suffix; all-symbol name → 'workspace-…'.
 */

import { describe, it, expect, vi } from 'vitest';
import { AuthService } from '../internal/application/auth.service.js';
import { requireVerifiedEmail } from '../internal/security/email-verified.guard.js';
import { deriveSlug } from '../internal/application/slugify.js';

// ── Mock factories ─────────────────────────────────────────────────────────────

function makeAudit() {
  return { append: vi.fn().mockResolvedValue({ id: 0n, entry_hash: 'abc' }) };
}
function makeNotification() {
  return {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
    sendInviteEmail: vi.fn().mockResolvedValue(undefined),
    canContact: vi.fn().mockResolvedValue({ decision: 'allow' as const, reason: 'transactional_exempt' as const }),
  };
}

/** A DbPool whose single client routes every query through `executor`. */
function makePool(executor: (sql: string, params: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>) {
  const client = {
    query: async (_ctx: unknown, sql: string, params: unknown[] = []) => executor(sql, params),
    release: vi.fn(),
  };
  return { connect: async () => client, end: vi.fn() } as never;
}

const CONFIG = { jwtSigningSecret: 'test-secret-test-secret-test-secret-1234' };

// ── D4: slug derivation ──────────────────────────────────────────────────────

describe('D4: deriveSlug', () => {
  it('lowercases, hyphenates, and appends a 6-char suffix', () => {
    const slug = deriveSlug('My Cool Store', 'abc123');
    expect(slug).toBe('my-cool-store-abc123');
  });

  it('trims leading/trailing symbols and collapses runs to single hyphens', () => {
    expect(deriveSlug('  ***Acme!! Co  ', 'zzzzzz')).toBe('acme-co-zzzzzz');
  });

  it('NEGATIVE CONTROL: an all-symbol name still yields a valid [a-z0-9-]+ slug', () => {
    const slug = deriveSlug('@#$%^&*', 'def456');
    expect(slug).toBe('workspace-def456');
    expect(/^[a-z0-9-]+$/.test(slug)).toBe(true);
  });

  it('two calls without an explicit suffix produce different slugs (collision-safety)', () => {
    expect(deriveSlug('Same Name')).not.toBe(deriveSlug('Same Name'));
  });
});

// ── D2: requireVerifiedEmail guard ───────────────────────────────────────────

describe('D2: requireVerifiedEmail guard', () => {
  function makeReply() {
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    return reply;
  }

  it('VERIFIED user → guard passes (no reply sent)', async () => {
    const authService = { isEmailVerified: vi.fn().mockResolvedValue(true) } as unknown as AuthService;
    const guard = requireVerifiedEmail(authService);
    const reply = makeReply();
    await guard({ headers: {}, auth: { userId: 'u1' } } as never, reply as never);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('UNVERIFIED user → 403 EMAIL_NOT_VERIFIED (NOT 401 — session stays valid)', async () => {
    const authService = { isEmailVerified: vi.fn().mockResolvedValue(false) } as unknown as AuthService;
    const guard = requireVerifiedEmail(authService);
    const reply = makeReply();
    await guard({ headers: {}, auth: { userId: 'u1' } } as never, reply as never);
    expect(reply.code).toHaveBeenCalledWith(403);
    const body = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('NEGATIVE CONTROL: missing request.auth → 401 (fail-closed, guard never allows)', async () => {
    const authService = { isEmailVerified: vi.fn().mockResolvedValue(true) } as unknown as AuthService;
    const guard = requireVerifiedEmail(authService);
    const reply = makeReply();
    await guard({ headers: {} } as never, reply as never);
    expect(reply.code).toHaveBeenCalledWith(401);
    // isEmailVerified is never consulted when auth is absent.
    expect((authService.isEmailVerified as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── D2: isEmailVerified is a DB self-read, fail-closed ───────────────────────

describe('D2: AuthService.isEmailVerified (DB self-read, fail-closed)', () => {
  it('returns true when app_user.email_verified_at IS NOT NULL', async () => {
    const pool = makePool(async () => ({
      rows: [{ id: 'u1', email: 'a@b.co', email_normalized: 'a@b.co', password_hash: 'h', email_verified_at: new Date(), status: 'active', created_at: new Date(), updated_at: new Date() }],
      rowCount: 1,
    }));
    const svc = new AuthService(pool, makeAudit() as never, makeNotification() as never, CONFIG);
    expect(await svc.isEmailVerified('u1', 'corr')).toBe(true);
  });

  it('returns false when email_verified_at IS NULL', async () => {
    const pool = makePool(async () => ({
      rows: [{ id: 'u1', email: 'a@b.co', email_normalized: 'a@b.co', password_hash: 'h', email_verified_at: null, status: 'active', created_at: new Date(), updated_at: new Date() }],
      rowCount: 1,
    }));
    const svc = new AuthService(pool, makeAudit() as never, makeNotification() as never, CONFIG);
    expect(await svc.isEmailVerified('u1', 'corr')).toBe(false);
  });

  it('NEGATIVE CONTROL: user not found → false (fail-closed, never allows)', async () => {
    const pool = makePool(async () => ({ rows: [], rowCount: 0 }));
    const svc = new AuthService(pool, makeAudit() as never, makeNotification() as never, CONFIG);
    expect(await svc.isEmailVerified('ghost', 'corr')).toBe(false);
  });
});

// ── D1: registerAndStartSession — auto-login only for a NEW user ─────────────

describe('D1: registerAndStartSession', () => {
  it('NEW user (created=true) → mints accessToken + refreshToken (auto-login)', async () => {
    let userInserted = false;
    const pool = makePool(async (sql) => {
      if (/FROM app_user\s+WHERE email/i.test(sql)) return { rows: [], rowCount: 0 }; // no existing user
      if (/INSERT INTO app_user/i.test(sql)) {
        userInserted = true;
        return { rows: [{ id: '00000000-0000-4000-8000-000000000001', email: 'new@b.co', email_normalized: 'new@b.co', password_hash: 'h', email_verified_at: null, status: 'active', created_at: new Date(), updated_at: new Date() }], rowCount: 1 };
      }
      if (/INSERT INTO email_verification/i.test(sql)) return { rows: [{ id: 'ev1' }], rowCount: 1 };
      if (/FROM invite/i.test(sql)) return { rows: [], rowCount: 0 }; // no pending invite
      if (/INSERT INTO user_session/i.test(sql)) return { rows: [{ id: 's1', app_user_id: 'u1', jti: 'j1', refresh_token_hash: 'rh', issued_at: new Date(), expires_at: new Date(Date.now() + 1e6), revoked_at: null, ip: null, user_agent: null, created_at: new Date(), family_id: null, rotated_from: null, used_at: null }], rowCount: 1 };
      if (/UPDATE user_session SET family_id/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM membership/i.test(sql)) return { rows: [], rowCount: 0 }; // EMPTY_CONTEXT
      return { rows: [], rowCount: 0 };
    });
    const svc = new AuthService(pool, makeAudit() as never, makeNotification() as never, CONFIG);
    const result = await svc.registerAndStartSession('new@b.co', 'password123!', '1.2.3.4', 'ua', 'corr');

    expect(userInserted).toBe(true);
    expect(result.created).toBe(true);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    // New user has no membership yet → EMPTY_CONTEXT (lands on the wizard).
    expect(result.context.workspaceId).toBeNull();
    expect(result.context.brandId).toBeNull();
  });

  it('NEGATIVE CONTROL: EXISTING email (created=false) → NO tokens (no auto-login for a collision)', async () => {
    let sessionInserted = false;
    const pool = makePool(async (sql) => {
      if (/FROM app_user\s+WHERE email/i.test(sql)) {
        // existing user, already verified → no re-issue
        return { rows: [{ id: '00000000-0000-4000-8000-0000000000ee', email: 'taken@b.co', email_normalized: 'taken@b.co', password_hash: 'h', email_verified_at: new Date(), status: 'active', created_at: new Date(), updated_at: new Date() }], rowCount: 1 };
      }
      if (/INSERT INTO user_session/i.test(sql)) { sessionInserted = true; return { rows: [{ id: 's1' }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    });
    const svc = new AuthService(pool, makeAudit() as never, makeNotification() as never, CONFIG);
    const result = await svc.registerAndStartSession('taken@b.co', 'password123!', '1.2.3.4', 'ua', 'corr');

    expect(result.created).toBe(false);
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    // The load-bearing assertion: an email collision NEVER mints a session.
    expect(sessionInserted).toBe(false);
  });
});
