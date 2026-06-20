/**
 * meta-token-refresh.unit.test.ts — the pure pieces of proactive Meta token refresh.
 *   • isTokenRefreshDue: absent/malformed/future → due; old → due; recent → not due.
 *   • exchangeLongLivedToken: success maps token+expiry; missing app creds / non-2xx / no-token throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isTokenRefreshDue,
  exchangeLongLivedToken,
  META_APP_CREDS_MISSING,
  META_TOKEN_EXCHANGE_FAILED,
  DEFAULT_REFRESH_AGE_DAYS,
} from '../jobs/meta-token-refresh/meta-token-client.js';

const NOW = Date.parse('2026-06-20T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();

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
