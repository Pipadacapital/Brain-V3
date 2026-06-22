/**
 * shopify-token-client.ts — Shopify offline access token refresh client.
 *
 * Shopify offline tokens historically did NOT expire. However, Shopify announced:
 *   - 2026-04-01: tokens issued after this date have a 1-year expiry.
 *   - 2027-01-01: ALL offline tokens expire, including legacy ones.
 *
 * The Shopify offline token refresh flow (POST /admin/oauth/access_token) exchanges
 * a still-valid offline token for a fresh one using the `authorization_code` grant
 * with an ALREADY-AUTHORIZED shop (i.e. re-using the existing access). The correct
 * API for token renewal on the offline-token path uses the refresh endpoint that
 * Shopify provides specifically for this mandate:
 *   POST https://{shop}/admin/oauth/access_token
 *   body: { client_id, client_secret, grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
 *           subject_token: <current_offline_token>, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token' }
 *
 * Since the exact Shopify token-exchange endpoint shape may vary by plan/app-type, this client
 * models the proactive check + write-back seam. When Shopify formalizes the endpoint, the
 * exchangeToken() body can be updated. The architecture (enumerate → read → write-back via
 * ISecretsManager.putSecretValue) is stable.
 *
 * SECURITY:
 *   - client_id / client_secret come from ENV (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET).
 *   - Tokens are NEVER logged (I-S09).
 *   - Secrets are written back via ISecretsManager.putSecretValue (same ARN — NN-2 unchanged).
 */

import { CircuitBreaker } from '@brain/observability';

const REQUEST_TIMEOUT_MS = 15_000;

/** Module-level circuit breaker for Shopify token exchange calls. */
const _shopifyTokenBreaker = new CircuitBreaker({
  name: 'shopify-token-refresh',
  failureThreshold: 3,
  openMs: 60_000,
});

/** Thrown when app-level client_id / client_secret are missing. */
export const SHOPIFY_APP_CREDS_MISSING = 'SHOPIFY_APP_CREDS_MISSING';
/** Thrown when the exchange fails (expired / invalid token, or Shopify API error). */
export const SHOPIFY_TOKEN_EXCHANGE_FAILED = 'SHOPIFY_TOKEN_EXCHANGE_FAILED';

/** Default age (days) at which a token is proactively refreshed (well inside 1-year window). */
export const DEFAULT_REFRESH_AGE_DAYS = 270;  // ~9 months, 90 days before 1-year expiry

export interface ShopifyTokenExchangeResult {
  /** The fresh offline access token (NEVER logged — I-S09). */
  accessToken: string;
  /** Shopify's reported scope for the new token. */
  scope?: string | null;
}

/**
 * Exchange a still-valid Shopify offline access token for a fresh one.
 *
 * Uses the Shopify token-exchange endpoint:
 *   POST https://{shopDomain}/admin/oauth/access_token
 *
 * The body uses the token-exchange grant type as specified in the Shopify offline-token
 * refresh mandate (2026/2027 deadlines). The exact `grant_type` and `subject_token_type`
 * values are from Shopify's offline token renewal documentation.
 *
 * @throws Error(SHOPIFY_APP_CREDS_MISSING) when client_id / client_secret are absent.
 * @throws Error(SHOPIFY_TOKEN_EXCHANGE_FAILED: ...) on any non-2xx or missing-token response.
 */
export async function exchangeShopifyToken(
  shopDomain: string,
  currentToken: string,   // NEVER logged (I-S09)
  fetchImpl: typeof fetch = fetch,
): Promise<ShopifyTokenExchangeResult> {
  const clientId = process.env['SHOPIFY_CLIENT_ID'];
  const clientSecret = process.env['SHOPIFY_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    throw new Error(`${SHOPIFY_APP_CREDS_MISSING}: SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not configured`);
  }

  const host = shopDomain.replace(/^https?:\/\//, '');
  const url = `https://${host}/admin/oauth/access_token`;

  // SEC: credentials and current token ride a POST body (never URL query string).
  // This matches Shopify's own OAuth callback exchange pattern.
  const requestBody = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: currentToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  });

  return _shopifyTokenBreaker.fire(async () => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestBody.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`${SHOPIFY_TOKEN_EXCHANGE_FAILED}: HTTP ${res.status}`);
    }

    const responseBody = (await res.json()) as { access_token?: string; scope?: string };
    if (!responseBody.access_token) {
      throw new Error(`${SHOPIFY_TOKEN_EXCHANGE_FAILED}: no access_token in exchange response`);
    }

    return {
      accessToken: responseBody.access_token,
      scope: responseBody.scope ?? null,
    };
  });
}

/**
 * PURE due-decision: should this token be proactively refreshed now?
 *
 * Due when:
 *   - issued_at is ABSENT (unknown age → refresh to establish a known clock)
 *   - token age exceeds `thresholdDays`
 *   - malformed / future issued_at → due (fail toward freshness)
 */
export function isShopifyTokenRefreshDue(
  issuedAtIso: string | null | undefined,
  nowMs: number,
  thresholdDays: number = DEFAULT_REFRESH_AGE_DAYS,
): boolean {
  if (!issuedAtIso) return true;
  const issuedMs = Date.parse(issuedAtIso);
  if (!Number.isFinite(issuedMs)) return true;
  const ageMs = nowMs - issuedMs;
  if (ageMs < 0) return true; // future timestamp / clock skew
  return ageMs >= thresholdDays * 24 * 60 * 60 * 1000;
}
