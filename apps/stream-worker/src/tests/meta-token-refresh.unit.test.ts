/**
 * meta-token-refresh.unit.test.ts — the pure pieces of proactive Meta token refresh.
 *   • isTokenRefreshDue: absent/malformed/future → due; old → due; recent → not due.
 *   • exchangeLongLivedToken: success maps token+expiry; missing app creds / non-2xx / no-token throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isTokenRefreshDue,
  isTokenExpiringSoon,
  expiresAtFromSeconds,
  exchangeLongLivedToken,
  META_APP_CREDS_MISSING,
  META_TOKEN_EXCHANGE_FAILED,
  DEFAULT_REFRESH_AGE_DAYS,
} from '../jobs/meta-token-refresh/meta-token-client.js';

const NOW = Date.parse('2026-06-20T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86400000).toISOString();

describe('isTokenRefreshDue', () => {
  it('absent / malformed / future issued_at → due (fail toward freshness)', () => {
    expect(isTokenRefreshDue(undefined, NOW)).toBe(true);
    expect(isTokenRefreshDue(null, NOW)).toBe(true);
    expect(isTokenRefreshDue('not-a-date', NOW)).toBe(true);
    expect(isTokenRefreshDue(daysAgo(-5), NOW)).toBe(true); // future
  });

  it('older than threshold → due; newer → not due', () => {
    expect(isTokenRefreshDue(daysAgo(DEFAULT_REFRESH_AGE_DAYS + 1), NOW)).toBe(true);
    expect(isTokenRefreshDue(daysAgo(DEFAULT_REFRESH_AGE_DAYS - 1), NOW)).toBe(false);
    expect(isTokenRefreshDue(daysAgo(1), NOW)).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(isTokenRefreshDue(daysAgo(10), NOW, 7)).toBe(true);
    expect(isTokenRefreshDue(daysAgo(5), NOW, 7)).toBe(false);
  });
});

describe('isTokenExpiringSoon (A2 expiry hardening)', () => {
  it('fires when a known expiry is within the refresh margin (short-lived "looks fresh" case)', () => {
    // expires in ~2h → due regardless of issued_at being recent
    expect(isTokenExpiringSoon(new Date(NOW + 2 * 3600_000).toISOString(), NOW)).toBe(true);
    expect(isTokenExpiringSoon(daysAhead(DEFAULT_REFRESH_AGE_DAYS - 1), NOW)).toBe(true);
  });

  it('does NOT fire for a comfortably-distant expiry', () => {
    expect(isTokenExpiringSoon(daysAhead(DEFAULT_REFRESH_AGE_DAYS + 5), NOW)).toBe(false);
    expect(isTokenExpiringSoon(daysAhead(59), NOW)).toBe(false);
  });

  it('an already-past expiry is "soon" (best-effort last exchange, never a silent skip)', () => {
    expect(isTokenExpiringSoon(daysAgo(1), NOW)).toBe(true);
  });

  it('unknown / malformed expiry defers to the issued-at age path (returns false, no false-positive storm)', () => {
    expect(isTokenExpiringSoon(undefined, NOW)).toBe(false);
    expect(isTokenExpiringSoon(null, NOW)).toBe(false);
    expect(isTokenExpiringSoon('not-a-date', NOW)).toBe(false);
  });
});

describe('expiresAtFromSeconds', () => {
  it('derives an ISO expiry from Graph expires_in seconds', () => {
    expect(expiresAtFromSeconds(5184000, NOW)).toBe(new Date(NOW + 5184000 * 1000).toISOString());
  });
  it('returns null when expires_in is absent (Graph omitted it)', () => {
    expect(expiresAtFromSeconds(null, NOW)).toBeNull();
  });
});

describe('exchangeLongLivedToken', () => {
  beforeEach(() => {
    process.env['META_APP_ID'] = 'app-id';
    process.env['META_APP_SECRET'] = 'app-secret';
  });
  afterEach(() => {
    delete process.env['META_APP_ID'];
    delete process.env['META_APP_SECRET'];
  });

  const stub = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('returns the fresh token + expiry on success', async () => {
    const r = await exchangeLongLivedToken('old-token', stub(200, { access_token: 'NEW', expires_in: 5184000 }));
    expect(r.accessToken).toBe('NEW');
    expect(r.expiresInSeconds).toBe(5184000);
  });

  it('tolerates a missing expires_in (null)', async () => {
    const r = await exchangeLongLivedToken('old', stub(200, { access_token: 'NEW' }));
    expect(r.expiresInSeconds).toBeNull();
  });

  it('throws META_APP_CREDS_MISSING when app creds absent', async () => {
    delete process.env['META_APP_ID'];
    await expect(exchangeLongLivedToken('old', stub(200, { access_token: 'x' }))).rejects.toThrow(META_APP_CREDS_MISSING);
  });

  it('throws META_TOKEN_EXCHANGE_FAILED on a non-2xx (expired/invalid token)', async () => {
    await expect(exchangeLongLivedToken('dead', stub(400, { error: { code: 190 } }))).rejects.toThrow(META_TOKEN_EXCHANGE_FAILED);
  });

  it('throws META_TOKEN_EXCHANGE_FAILED when no access_token in the response', async () => {
    await expect(exchangeLongLivedToken('old', stub(200, { token_type: 'bearer' }))).rejects.toThrow(META_TOKEN_EXCHANGE_FAILED);
  });
});
