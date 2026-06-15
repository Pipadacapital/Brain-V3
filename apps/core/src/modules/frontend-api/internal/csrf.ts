/**
 * Session-bound CSRF token (SEC-0009-M02 hardening).
 *
 * The token is a keyed HMAC of the session's `jti`, so it is:
 *  - unforgeable without the server secret,
 *  - bound to a specific session (a token issued for session A is rejected for B),
 *  - automatically invalidated when the session rotates/revokes (jti changes).
 *
 * It remains a double-submit cookie (the client echoes the JS-readable `brain_csrf`
 * cookie in the `x-csrf-token` header); this only strengthens the value's binding.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Decode the `jti` claim from a JWT WITHOUT verifying the signature. The signature
 * is verified separately by validateSession; here we only need the jti to derive the
 * CSRF token, and the token's security comes from the HMAC over the server secret —
 * an attacker who guesses a jti still cannot compute a valid token.
 */
export function jtiFromJwt(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      jti?: unknown;
    };
    return typeof payload.jti === 'string' ? payload.jti : null;
  } catch {
    return null;
  }
}

/** Derive the CSRF token for a session jti. Deterministic per session. */
export function csrfTokenForSession(jti: string, cookieSecret: string): string {
  return createHmac('sha256', cookieSecret).update(`csrf:${jti}`).digest('hex');
}

/** Constant-time compare of two hex tokens of equal length. */
export function csrfTokenMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
