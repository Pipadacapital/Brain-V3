/**
 * JWT utilities — mint and verify tokens.
 *
 * Claims shape is ADR-006 compatible so Authentik can front it in Phase 2 (D0.1).
 * Claims: { sub, brand_id, workspace_id, role, jti, iat, exp }
 *
 * Algorithm: HS256 (HMAC-SHA256 with a Secrets Manager-stored key).
 * The key is injected from config — never hard-coded.
 */

import type { JwtClaims } from '../domain/auth/entities.js';

// ── Minimal JWT implementation (no external JWT lib in core path) ─────────────
// Uses Node.js built-in crypto for HMAC-SHA256.

import { createHmac } from 'node:crypto';

function base64urlEncode(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8');
}

const JWT_HEADER = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function mintJwt(claims: JwtClaims, secret: string): string {
  const payload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${JWT_HEADER}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [header, payload, signature] = parts as [string, string, string];

  // MED-JWT-01: validate the alg and typ header claims before touching the payload.
  // Reject any token whose header does not exactly declare HS256+JWT — closes
  // algorithm-confusion (alg:none, RS256→HS256) and unknown-field injection.
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(base64urlDecode(header));
  } catch {
    throw new Error('Invalid JWT header: not valid JSON');
  }
  if (
    typeof parsedHeader !== 'object' ||
    parsedHeader === null ||
    (parsedHeader as Record<string, unknown>)['alg'] !== 'HS256' ||
    (parsedHeader as Record<string, unknown>)['typ'] !== 'JWT'
  ) {
    throw new Error('Invalid JWT header: expected alg=HS256, typ=JWT');
  }

  // Use the canonical header constant for the signing input so that a
  // crafted header (even with alg=HS256) cannot slip in extra fields that
  // affect the signing material.
  const signingInput = `${JWT_HEADER}.${payload}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');

  // Timing-safe comparison to prevent timing attacks on signature verification.
  if (signature.length !== expectedSignature.length) {
    throw new Error('Invalid JWT signature');
  }

  // Compare byte-by-byte in constant time.
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  let mismatch = 0;
  for (let i = 0; i < sigBuf.length; i++) {
    mismatch |= (sigBuf[i] ?? 0) ^ (expectedBuf[i] ?? 0);
  }
  if (mismatch !== 0) {
    throw new Error('Invalid JWT signature');
  }

  const claims = JSON.parse(base64urlDecode(payload)) as JwtClaims;

  // Check expiry.
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp < now) {
    throw new Error('JWT expired');
  }

  return claims;
}
