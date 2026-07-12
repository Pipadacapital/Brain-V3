/**
 * google-service-account.ts — Google service-account JWT-bearer OAuth (RFC 7523).
 *
 * The SINGLE implementation of the Google SA token mint, shared by:
 *   - apps/core HandleGa4ConnectCommand (connect-time credential validation), and
 *   - apps/stream-worker Ga4DataClient (repull/backfill authentication).
 *
 * Flow (https://developers.google.com/identity/protocols/oauth2/service-account):
 *   1. Build a JWT: header {alg:RS256, typ:JWT}; claims {iss: client_email, scope, aud: token
 *      endpoint, iat, exp=iat+3600}.
 *   2. Sign it RS256 with the service-account private key (node:crypto — no new dependency).
 *   3. POST the token endpoint with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.
 *
 * INVARIANTS:
 *   - I-S09: the private key, the signed JWT, and the access token are NEVER logged and never
 *     appear in error messages (errors carry only HTTP status / structural reasons).
 *   - Non-retryable auth rejections (4xx from the token endpoint, malformed key) throw with
 *     `code = GOOGLE_SA_AUTH_ERROR` so callers can map them to their own reconnect signal.
 */

import { createSign } from 'node:crypto';

/** Error code stamped on non-retryable service-account auth failures. */
export const GOOGLE_SA_AUTH_ERROR = 'GOOGLE_SA_AUTH_ERROR';

/** Google's OAuth2 token endpoint (also the JWT `aud` claim). */
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The subset of a Google service-account JSON key Brain needs. */
export interface GoogleServiceAccountKey {
  /** Service-account email (`client_email` in the key JSON). */
  clientEmail: string;
  /** RSA private key PEM (`private_key` in the key JSON). NEVER logged (I-S09). */
  privateKeyPem: string;
}

/** Error with the GOOGLE_SA_AUTH_ERROR code (non-retryable — bad key / rejected assertion). */
function saAuthError(message: string): Error {
  const err = new Error(`${GOOGLE_SA_AUTH_ERROR}: ${message}`);
  (err as Error & { code: string }).code = GOOGLE_SA_AUTH_ERROR;
  return err;
}

/**
 * Parse a merchant-pasted service-account JSON key string into the fields Brain needs.
 * Throws GOOGLE_SA_AUTH_ERROR on malformed JSON / missing fields / wrong key type.
 * The raw string and the private key are NEVER included in the error (I-S09).
 */
export function parseServiceAccountKeyJson(raw: string): GoogleServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw saAuthError('service-account key is not valid JSON');
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (obj['type'] !== undefined && obj['type'] !== 'service_account') {
    throw saAuthError(`key "type" must be "service_account" (got "${String(obj['type'])}")`);
  }
  const clientEmail = typeof obj['client_email'] === 'string' ? obj['client_email'].trim() : '';
  const privateKeyPem = typeof obj['private_key'] === 'string' ? obj['private_key'] : '';
  if (!clientEmail) throw saAuthError('service-account key is missing "client_email"');
  if (!privateKeyPem.includes('PRIVATE KEY')) {
    throw saAuthError('service-account key is missing a PEM "private_key"');
  }
  return { clientEmail, privateKeyPem };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build + RS256-sign the JWT-bearer assertion. Exported for deterministic unit tests
 * (callers should use mintServiceAccountAccessToken). Never logs anything (I-S09).
 */
export function signServiceAccountAssertion(args: {
  key: GoogleServiceAccountKey;
  scope: string;
  /** Token endpoint (JWT `aud`). Defaults to Google's. */
  audience?: string;
  /** Injectable clock for tests (ms since epoch). */
  nowMs?: number;
}): string {
  const iat = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: args.key.clientEmail,
      scope: args.scope,
      aud: args.audience ?? GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + 3600, // Google's maximum assertion lifetime
    }),
  );
  const signingInput = `${header}.${claims}`;
  let signature: Buffer;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signature = signer.sign(args.key.privateKeyPem);
  } catch {
    // Bad/garbage PEM — non-retryable. The key material is NEVER in the message (I-S09).
    throw saAuthError('could not sign the JWT assertion — the private key PEM is invalid');
  }
  return `${signingInput}.${base64url(signature)}`;
}

export interface MintServiceAccountTokenResult {
  /** Short-lived bearer token. In-memory only — NEVER logged / persisted (I-S09). */
  accessToken: string;
  /** Token lifetime as reported by Google (null when omitted). */
  expiresInSeconds: number | null;
}

/**
 * Mint a short-lived access token for a Google service account via the JWT-bearer grant.
 *
 * @throws GOOGLE_SA_AUTH_ERROR (err.code) on non-retryable rejections: invalid key PEM,
 *         4xx from the token endpoint, or a 200 without an access_token.
 *         Other failures (5xx / network) throw plain Errors — retryable by the caller.
 */
export async function mintServiceAccountAccessToken(args: {
  key: GoogleServiceAccountKey;
  /** OAuth scope, e.g. 'https://www.googleapis.com/auth/analytics.readonly'. */
  scope: string;
  tokenUrl?: string;
  timeoutMs?: number;
  /** Injectable for deterministic tests. */
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<MintServiceAccountTokenResult> {
  const tokenUrl = args.tokenUrl ?? GOOGLE_OAUTH_TOKEN_URL;
  const assertion = signServiceAccountAssertion({
    key: args.key,
    scope: args.scope,
    audience: tokenUrl,
    nowMs: args.nowMs,
  });

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(args.timeoutMs ?? 15_000),
  });

  if (res.status >= 400 && res.status < 500) {
    // invalid_grant / invalid_client etc. — bad key or clock skew. Body NEVER surfaced (I-S09).
    throw saAuthError(`token endpoint rejected the JWT assertion (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`[google-sa] token endpoint HTTP ${res.status}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw saAuthError('no access_token in the token endpoint response');
  }
  return {
    accessToken: data.access_token, // in memory only; never logged (I-S09)
    expiresInSeconds:
      typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
        ? data.expires_in
        : null,
  };
}
