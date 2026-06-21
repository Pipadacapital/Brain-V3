/**
 * shiprocket-token-provider.ts — Shiprocket 10-day Bearer-JWT mint + cache.
 *
 * The one genuinely-new auth mechanic vs GoKwik/Razorpay (which use static key-pairs):
 * Shiprocket exchanges a dedicated API-user email+password at POST /v1/external/auth/login
 * for a Bearer JWT valid 240h (10 days) with NO refresh token — it must be re-minted by
 * re-calling login. This provider mints on demand and caches the token until shortly before
 * expiry, re-minting (relogin) when the cache is cold or a caller reports a 401.
 *
 * Slice 1 is DEV-fixture-based, so this provider is NOT on the dev ingestion path — it is the
 * documented prod mechanism the real HTTP client will use when partner credentials land. It is
 * pure (a single fetch + an in-memory expiry cache), so it is safe to ship ahead of that swap.
 *
 * NEVER logs email / password / the token (I-S09).
 */

import { log } from '../../log.js';

export const SHIPROCKET_AUTH_ERROR = 'SHIPROCKET_AUTH_ERROR';

export interface ShiprocketApiCredentials {
  email: string;     // NEVER logged (I-S09)
  password: string;  // NEVER logged (I-S09)
}

const DEFAULT_BASE_URL = 'https://apiv2.shiprocket.in';
const LOGIN_PATH = '/v1/external/auth/login';
/** Re-mint a little before the documented 240h so an in-flight pull never trips expiry. */
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000; // 9 days (< 10-day validity)

interface CachedToken {
  token: string;
  mintedAtMs: number;
}

/**
 * Mints + caches a Shiprocket Bearer JWT per credential identity. In Slice 1 the cache is
 * per-process in-memory; a Redis-backed cache (key = connector_instance_id, TTL < 10d) is the
 * multi-replica prod form — the getToken/invalidate interface is unchanged.
 */
export class ShiprocketTokenProvider {
  private cache: CachedToken | null = null;

  constructor(
    private readonly creds: ShiprocketApiCredentials,
    private readonly baseUrl: string = process.env['SHIPROCKET_BASE_URL'] ?? DEFAULT_BASE_URL,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Return a valid Bearer token, minting (logging in) if the cache is cold or stale. */
  async getToken(): Promise<string> {
    if (this.cache && this.now() - this.cache.mintedAtMs < TOKEN_TTL_MS) {
      return this.cache.token;
    }
    return this.mint();
  }

  /** Drop the cached token so the next getToken() re-logs-in (call on a 401). */
  invalidate(): void {
    this.cache = null;
  }

  private async mint(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${LOGIN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.creds.email, password: this.creds.password }),
      });
    } catch (err) {
      // network failure — never include credentials in the message (I-S09)
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: login request failed: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: login rejected (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: login failed (${res.status})`);
    }
    const body = (await res.json()) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token) {
      throw new Error(`${SHIPROCKET_AUTH_ERROR}: login response missing token`);
    }
    this.cache = { token, mintedAtMs: this.now() };
    log.info('[shiprocket] auth token minted (10-day JWT cached)');
    return token;
  }
}
