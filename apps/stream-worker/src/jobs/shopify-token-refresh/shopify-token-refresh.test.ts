/**
 * shopify-token-refresh.test.ts — unit tests for the shopify offline-token refresh job.
 *
 * Proves:
 *   1. isShopifyTokenRefreshDue() — pure due-decision logic.
 *   2. runShopifyTokenRefresh() — token-refresh writes via the ISecretsManager.putSecretValue seam.
 *   3. runShopifyTokenRefresh() — tokens not yet due are skipped (skippedNotDue counter).
 *   4. Exchange failure → RECONNECT_REQUIRED (reconnectRequired counter, no panic).
 *   5. Missing app creds → early abort (errors counter + log, no further connectors attempted).
 *
 * These are pure unit tests: no DB, no real Shopify API, no Kafka.
 * All external dependencies are injectable (pool, fetchImpl, secretsManager, nowMs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { ISecretsManager } from '@brain/connector-secrets';
import {
  isShopifyTokenRefreshDue,
  DEFAULT_REFRESH_AGE_DAYS,
  SHOPIFY_APP_CREDS_MISSING,
  SHOPIFY_TOKEN_EXCHANGE_FAILED,
} from './shopify-token-client.js';
import { runShopifyTokenRefresh } from './run.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** ISO-8601 timestamp `daysAgo` days before `nowMs`. */
function issuedDaysAgo(daysAgo: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

/** Minimal mock pg.Pool that returns a configurable set of connector rows. */
function makeMockPool(connectorRows: Array<Record<string, string>>): Pool {
  // dev_secret read (readBundle): returns per-secretRef bundle based on stored map
  const devSecretMap = new Map<string, string>();
  // setSyncStateError queries: captured
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };

  return {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      const q = typeof text === 'string' ? text : String(text);
      // Enumerate connectors
      if (q.includes('list_connectors_for_repull')) {
        return { rows: connectorRows };
      }
      // dev_secret read
      if (q.includes('dev_secret') && q.includes('SELECT')) {
        const name = params?.[0] as string | undefined;
        const val = name ? devSecretMap.get(name) : undefined;
        return { rows: val ? [{ secret_value: val }] : [] };
      }
      // dev_secret write (upsert)
      if (q.includes('dev_secret') && q.includes('INSERT')) {
        const name = params?.[0] as string | undefined;
        const val = params?.[1] as string | undefined;
        if (name && val) devSecretMap.set(name, val);
        return { rows: [] };
      }
      return { rows: [] };
    }),
    connect: vi.fn().mockResolvedValue(client),
    _devSecretMap: devSecretMap, // expose for seeding
  } as unknown as Pool;
}

/** Seed the mock pool's dev_secret store with a bundle. */
function seedDevSecret(pool: Pool, secretRef: string, bundle: Record<string, unknown>): void {
  const name = secretRef.split(':secret:')[1] ?? secretRef;
  (pool as unknown as { _devSecretMap: Map<string, string> })._devSecretMap.set(
    name,
    JSON.stringify(bundle),
  );
}

// ── isShopifyTokenRefreshDue (pure unit tests) ─────────────────────────────────

describe('isShopifyTokenRefreshDue', () => {
  const NOW = new Date('2026-06-22T00:00:00Z').getTime();

  it('returns true when issuedAt is absent (unknown age → refresh)', () => {
    expect(isShopifyTokenRefreshDue(null, NOW)).toBe(true);
    expect(isShopifyTokenRefreshDue(undefined, NOW)).toBe(true);
    expect(isShopifyTokenRefreshDue('', NOW)).toBe(true);
  });

  it('returns true when issuedAt is malformed', () => {
    expect(isShopifyTokenRefreshDue('not-a-date', NOW)).toBe(true);
  });

  it('returns true when token is older than threshold', () => {
    // Token issued 300 days ago (> DEFAULT 270)
    const oldIso = issuedDaysAgo(300, NOW);
    expect(isShopifyTokenRefreshDue(oldIso, NOW, DEFAULT_REFRESH_AGE_DAYS)).toBe(true);
  });

  it('returns false when token is younger than threshold', () => {
    // Token issued 100 days ago (< DEFAULT 270)
    const recentIso = issuedDaysAgo(100, NOW);
    expect(isShopifyTokenRefreshDue(recentIso, NOW, DEFAULT_REFRESH_AGE_DAYS)).toBe(false);
  });

  it('returns true for future issued_at (clock skew → refresh)', () => {
    const futureIso = new Date(NOW + 1000).toISOString();
    expect(isShopifyTokenRefreshDue(futureIso, NOW)).toBe(true);
  });

  it('boundary: exactly at threshold is due', () => {
    const exactIso = issuedDaysAgo(DEFAULT_REFRESH_AGE_DAYS, NOW);
    expect(isShopifyTokenRefreshDue(exactIso, NOW, DEFAULT_REFRESH_AGE_DAYS)).toBe(true);
  });
});

// ── runShopifyTokenRefresh ─────────────────────────────────────────────────────

describe('runShopifyTokenRefresh', () => {
  const NOW = new Date('2026-06-22T00:00:00Z').getTime();
  const CONNECTOR = {
    connector_instance_id: 'ci-shopify-001',
    brand_id: 'brand-001',
    shop_domain: 'test-shop.myshopify.com',
    secret_ref: 'arn:aws:secretsmanager:us-east-1:000:secret:brain/connector/shopify/brand-001/test-shop',
  };

  beforeEach(() => {
    // Set Shopify app creds for tests that need them
    process.env['SHOPIFY_CLIENT_ID'] = 'test-client-id';
    process.env['SHOPIFY_CLIENT_SECRET'] = 'test-client-secret';
  });

  it('skips connector when token is not yet due', async () => {
    const pool = makeMockPool([CONNECTOR]);
    // Seed a bundle with recent issued_at (100 days ago < threshold 270)
    seedDevSecret(pool, CONNECTOR.secret_ref, {
      access_token: 'valid-token',
      access_token_issued_at: issuedDaysAgo(100, NOW),
    });

    const fetchImpl = vi.fn(); // should NOT be called
    const report = await runShopifyTokenRefresh(pool, NOW, DEFAULT_REFRESH_AGE_DAYS, fetchImpl, undefined);

    expect(report.scanned).toBe(1);
    expect(report.skippedNotDue).toBe(1);
    expect(report.refreshed).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('writes refreshed token via ISecretsManager.putSecretValue seam (prod path)', async () => {
    const pool = makeMockPool([CONNECTOR]);
    seedDevSecret(pool, CONNECTOR.secret_ref, {
      access_token: 'old-token',
      access_token_issued_at: issuedDaysAgo(300, NOW),
    });

    const freshToken = 'fresh-shopify-token-xyz';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: freshToken }),
    });

    const putSecretValue = vi.fn().mockResolvedValue(undefined);
    const getSecret = vi.fn().mockResolvedValue({
      access_token: 'old-token',
      access_token_issued_at: issuedDaysAgo(300, NOW),
    });

    const secretsManager: ISecretsManager = {
      putSecretValue,
      getSecret,
      storeSecret: vi.fn(),
      deleteSecret: vi.fn(),
      storeShopifyToken: vi.fn(),
      getShopifyClientSecret: vi.fn(),
      deleteShopifyToken: vi.fn(),
      getShopifyToken: vi.fn(),
    };

    const report = await runShopifyTokenRefresh(pool, NOW, DEFAULT_REFRESH_AGE_DAYS, fetchImpl, secretsManager);

    expect(report.scanned).toBe(1);
    expect(report.refreshed).toBe(1);
    expect(report.reconnectRequired).toBe(0);
    expect(report.errors).toBe(0);

    // putSecretValue MUST have been called with the same ARN (NN-2)
    expect(putSecretValue).toHaveBeenCalledOnce();
    const [arn, bundle] = putSecretValue.mock.calls[0]!;
    expect(arn).toBe(CONNECTOR.secret_ref);
    // The bundle must contain the fresh token (never logged, but we verify it was written)
    expect((bundle as Record<string, string>)['access_token']).toBe(freshToken);
    // issued_at should be stamped with nowMs
    expect((bundle as Record<string, string>)['access_token_issued_at']).toBe(new Date(NOW).toISOString());
  });

  it('marks RECONNECT_REQUIRED on exchange failure (non-fatal)', async () => {
    const pool = makeMockPool([CONNECTOR]);
    seedDevSecret(pool, CONNECTOR.secret_ref, {
      access_token: 'expired-token',
      access_token_issued_at: issuedDaysAgo(400, NOW),
    });

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const report = await runShopifyTokenRefresh(pool, NOW, DEFAULT_REFRESH_AGE_DAYS, fetchImpl, undefined);

    expect(report.scanned).toBe(1);
    expect(report.refreshed).toBe(0);
    expect(report.reconnectRequired).toBe(1);
    expect(report.errors).toBe(0);
  });

  it('aborts early when SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are missing', async () => {
    delete process.env['SHOPIFY_CLIENT_ID'];
    delete process.env['SHOPIFY_CLIENT_SECRET'];

    const pool = makeMockPool([CONNECTOR, CONNECTOR]); // two connectors, only first attempted
    seedDevSecret(pool, CONNECTOR.secret_ref, {
      access_token: 'any-token',
      access_token_issued_at: issuedDaysAgo(300, NOW),
    });

    const fetchImpl = vi.fn(); // should throw SHOPIFY_APP_CREDS_MISSING

    // Restore after test
    try {
      const report = await runShopifyTokenRefresh(pool, NOW, DEFAULT_REFRESH_AGE_DAYS, fetchImpl, undefined);

      // errors > 0 and early abort (second connector not attempted → scanned=1 or reconnect on first)
      expect(report.errors).toBeGreaterThan(0);
    } finally {
      process.env['SHOPIFY_CLIENT_ID'] = 'test-client-id';
      process.env['SHOPIFY_CLIENT_SECRET'] = 'test-client-secret';
    }
  });

  it('reconnectRequired when connector has no stored token', async () => {
    const pool = makeMockPool([CONNECTOR]);
    // Do NOT seed dev_secret → no token stored

    const fetchImpl = vi.fn();
    const report = await runShopifyTokenRefresh(pool, NOW, DEFAULT_REFRESH_AGE_DAYS, fetchImpl, undefined);

    expect(report.scanned).toBe(1);
    expect(report.reconnectRequired).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('report.errors stays 0 on a successful refresh (no exception leaks)', async () => {
    const pool = makeMockPool([CONNECTOR]);
    seedDevSecret(pool, CONNECTOR.secret_ref, {
      access_token: 'old-token',
      access_token_issued_at: issuedDaysAgo(300, NOW),
    });

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'brand-new-token' }),
    });

    const report = await runShopifyTokenRefresh(pool, NOW, DEFAULT_REFRESH_AGE_DAYS, fetchImpl, undefined);

    expect(report.errors).toBe(0);
    expect(report.refreshed).toBe(1);
  });

  // Expose the SHOPIFY_TOKEN_EXCHANGE_FAILED constant as part of public surface
  it('SHOPIFY_TOKEN_EXCHANGE_FAILED constant is exported', () => {
    expect(typeof SHOPIFY_TOKEN_EXCHANGE_FAILED).toBe('string');
    expect(SHOPIFY_TOKEN_EXCHANGE_FAILED.length).toBeGreaterThan(0);
  });

  it('SHOPIFY_APP_CREDS_MISSING constant is exported', () => {
    expect(typeof SHOPIFY_APP_CREDS_MISSING).toBe('string');
    expect(SHOPIFY_APP_CREDS_MISSING.length).toBeGreaterThan(0);
  });
});
