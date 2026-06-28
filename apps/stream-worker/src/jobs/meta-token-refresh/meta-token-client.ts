/**
 * meta-token-client.ts — Meta long-lived-token RE-EXCHANGE (proactive refresh).
 *
 * Meta has NO refresh token (unlike Google). A long-lived user/page access token expires in ~60
 * days; the only way to extend it is to exchange a STILL-VALID long-lived token for a fresh one via
 * the `fb_exchange_token` grant (which resets the ~60-day clock). An EXPIRED token cannot be
 * exchanged — so this must run PROACTIVELY, well before expiry. The reactive 401 path correctly
 * stays RECONNECT_REQUIRED (a dead token can only be fixed by re-consent).
 *
 * Mirrors the Google authenticate() idiom (google-ads-searchstream-client.ts): a single POST/GET to
 * the OAuth endpoint, app creds from ENV (META_APP_ID / META_APP_SECRET — the same the OAuth
 * callback uses), the new token kept in memory / handed back to the caller, never logged (I-S09).
 */
import { CircuitBreaker } from '@brain/observability';
import { GRAPH_OAUTH_URL } from '../meta-constants.js';

const OAUTH_URL = GRAPH_OAUTH_URL;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Module-level circuit breaker for Meta OAuth token exchange calls. Prevents a hanging
 * or repeatedly-failing exchange from stalling the token-refresh cron job tick.
 */
const _metaTokenBreaker = new CircuitBreaker({ name: 'meta-token', failureThreshold: 3, openMs: 60_000 });

/** Thrown when the app-level creds (META_APP_ID / META_APP_SECRET) are not configured. */
export const META_APP_CREDS_MISSING = 'META_APP_CREDS_MISSING';
/** Thrown when the exchange fails (expired/invalid token, or Graph error). */
export const META_TOKEN_EXCHANGE_FAILED = 'META_TOKEN_EXCHANGE_FAILED';

export interface MetaTokenExchangeResult {
  /** The fresh long-lived access token (in memory only; NEVER logged — I-S09). */
  accessToken: string;
  /** Seconds until the new token expires, when Graph returns it (else null). */
  expiresInSeconds: number | null;
}

/**
 * Re-exchange a still-valid long-lived token for a fresh one (fb_exchange_token).
 * App creds come from ENV (the same META_APP_ID / META_APP_SECRET the connect flow uses).
 *
 * @throws Error(META_APP_CREDS_MISSING) when app creds are absent.
 * @throws Error(META_TOKEN_EXCHANGE_FAILED: ...) on any non-2xx / missing-token response (the
 *         caller treats this as RECONNECT_REQUIRED — a token Meta will not extend is effectively dead).
 */
export async function exchangeLongLivedToken(
  currentToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaTokenExchangeResult> {
  const appId = process.env['META_APP_ID'];
  const appSecret = process.env['META_APP_SECRET'];
  if (!appId || !appSecret) {
    throw new Error(`${META_APP_CREDS_MISSING}: META_APP_ID / META_APP_SECRET not configured`);
  }

  // SEC-AD-H1: client_secret + fb_exchange_token (the current access token) must ride the
  // request BODY, never the URL query string — a secret in the URL lands in every
  // reverse-proxy / ALB / CDN / WAF access log. POST + form-urlencoded body matches the
  // pattern already used by HandleMetaOAuthCallbackCommand.exchangeCodeForToken (I-S09).
  const requestBody = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: currentToken,
  });

  return _metaTokenBreaker.fire(async () => {
    const res = await fetchImpl(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestBody.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      // 400/401/190 = the token is expired/invalid and cannot be extended → RECONNECT_REQUIRED.
      throw new Error(`${META_TOKEN_EXCHANGE_FAILED}: HTTP ${res.status}`);
    }
    const responseBody = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!responseBody.access_token) {
      throw new Error(`${META_TOKEN_EXCHANGE_FAILED}: no access_token in exchange response`);
    }
    return {
      accessToken: responseBody.access_token,
      expiresInSeconds: typeof responseBody.expires_in === 'number' ? responseBody.expires_in : null,
    };
  });
}

/** Default age (days) at which a token is re-exchanged — comfortably inside Meta's ~60-day window. */
export const DEFAULT_REFRESH_AGE_DAYS = 30;

/**
 * PURE due-decision: should this token be re-exchanged now?
 * Due when the issued-at is ABSENT (unknown age → refresh to establish a known clock) or when the
 * token is older than `thresholdDays`. Malformed/ future timestamps → due (fail toward freshness).
 */
export function isTokenRefreshDue(
  issuedAtIso: string | null | undefined,
  nowMs: number,
  thresholdDays: number = DEFAULT_REFRESH_AGE_DAYS,
): boolean {
  if (!issuedAtIso) return true; // unknown age → refresh to stamp a known issued_at
  const issuedMs = Date.parse(issuedAtIso);
  if (!Number.isFinite(issuedMs)) return true; // malformed → refresh
  const ageMs = nowMs - issuedMs;
  if (ageMs < 0) return true; // future timestamp (clock skew / bad data) → refresh
  return ageMs >= thresholdDays * 24 * 60 * 60 * 1000;
}

/**
 * PURE expiry-decision: is this token expiring within `marginDays` of `nowMs`?
 *
 * Closes the "short-lived token looks fresh" silent-death class (the review's HIGH token finding):
 * a short-lived token stamped `issued_at=now` at callback passes `isTokenRefreshDue` for 30 days,
 * yet may die in ~2h. When a real `expires_at` is known, this fires the moment the token enters the
 * refresh margin — independent of issued_at — so the refresh cron re-exchanges it BEFORE it dies.
 *
 * Returns false when the expiry is UNKNOWN/malformed (no false-positive storm on legacy bundles that
 * never recorded an expiry — the issued-at age path in isTokenRefreshDue still governs those).
 * An ALREADY-past expiry returns true (best-effort one last exchange attempt; a truly dead token then
 * surfaces as RECONNECT_REQUIRED via the exchange failure — never a silent skip).
 */
export function isTokenExpiringSoon(
  expiresAtIso: string | null | undefined,
  nowMs: number,
  marginDays: number = DEFAULT_REFRESH_AGE_DAYS,
): boolean {
  if (!expiresAtIso) return false; // unknown expiry → defer to the issued-at age path
  const expMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expMs)) return false; // malformed → defer to issued-at age path
  return expMs - nowMs <= marginDays * 24 * 60 * 60 * 1000;
}

/** Derive an ISO expiry from a Graph `expires_in` (seconds), or null when Graph omits it. */
export function expiresAtFromSeconds(
  expiresInSeconds: number | null,
  nowMs: number,
): string | null {
  if (expiresInSeconds === null || !Number.isFinite(expiresInSeconds)) return null;
  return new Date(nowMs + expiresInSeconds * 1000).toISOString();
}
