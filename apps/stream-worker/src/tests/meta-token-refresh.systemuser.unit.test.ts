/**
 * meta-token-refresh.systemuser.unit.test.ts — system-user tokens are SKIPPED by the refresh pass.
 *
 * A system-user token (ConnectMetaWithSystemUserTokenCommand, bundle token_type='system_user')
 * NEVER expires — there is nothing to re-exchange, and fb_exchange_token is a user-token grant
 * that fails on it. Without the skip, the issued-at clock marks the token due forever → a daily
 * doomed exchange that flips a HEALTHY connector to RECONNECT_REQUIRED. This proves:
 *   • a system_user bundle is skipped (no exchange fetch, no sync-state flip, counted honestly);
 *   • an ordinary user-token bundle on the same pass still refreshes (skip is surgical).
 *
 * enumerate/sync-state/health modules are mocked — no Postgres; readBundle's dev path reads the
 * bundle from a fake pool's dev_secret query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const enumerateConnectorsMock = vi.fn();
const setSyncStateMock = vi.fn();
vi.mock('../jobs/meta-spend-repull/run.js', () => ({
  enumerateConnectors: (...args: unknown[]) => enumerateConnectorsMock(...args),
  setSyncState: (...args: unknown[]) => setSyncStateMock(...args),
}));
vi.mock('../infrastructure/pg/ConnectorInstanceHealthRepository.js', () => ({
  // MUST return promises — the job chains `.catch()` on recoverConnectorInstanceHealth.
  updateConnectorInstanceHealth: vi.fn(async () => undefined),
  recoverConnectorInstanceHealth: vi.fn(async () => undefined),
}));
vi.mock('../infrastructure/observability/connector-auth-health.js', () => ({
  recordConnectorAuthRejected: vi.fn(),
}));
const incrementCounterMock = vi.fn();
// Partial mock: keep the real module (createLogger / CircuitBreaker are imported by log.ts and
// meta-token-client.ts) and spy ONLY on incrementCounter.
vi.mock('@brain/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brain/observability')>();
  return {
    ...actual,
    incrementCounter: (...args: unknown[]) => incrementCounterMock(...args),
  };
});

import { runMetaTokenRefresh } from '../jobs/meta-token-refresh/run.js';

const NOW = Date.parse('2026-07-12T00:00:00Z');
const BRAND = 'a3b70001-0a11-4a11-8a11-00000000aa01';

/** Fake app pool whose dev_secret lookup serves the given per-secret bundles. */
function makePool(bundles: Record<string, Record<string, string>>): Pool {
  return {
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      const name = String(params[0]);
      const bundle = bundles[name];
      return { rows: bundle ? [{ secret_value: JSON.stringify(bundle) }] : [] };
    }),
  } as unknown as Pool;
}

function connectorRow(ciId: string, secretName: string) {
  return {
    connector_instance_id: ciId,
    brand_id: BRAND,
    provider: 'meta',
    secret_ref: `arn:aws:secretsmanager:us-east-1:000000000000:secret:${secretName}`,
    ad_account_id: 'act_1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['META_APP_ID'] = 'app-id';
  process.env['META_APP_SECRET'] = 'app-secret';
});

describe('runMetaTokenRefresh — system-user token skip', () => {
  it('skips a token_type=system_user bundle: no exchange call, no sync-state flip, counted as skippedSystemUser', async () => {
    const secretName = 'brain/connector/meta/sut';
    enumerateConnectorsMock.mockResolvedValue([connectorRow('ci-sut', secretName)]);
    const pool = makePool({
      [secretName]: {
        access_token: 'SYSTEM-USER-TOKEN',
        token_type: 'system_user',
        // Deliberately ANCIENT issued_at — would be "due" for a user token; must still skip.
        access_token_issued_at: new Date(NOW - 400 * 86400000).toISOString(),
      },
    });
    const fetchSpy = vi.fn();

    const report = await runMetaTokenRefresh(pool, NOW, undefined, fetchSpy as unknown as typeof fetch);

    expect(report.scanned).toBe(1);
    expect(report.skippedSystemUser).toBe(1);
    expect(report.refreshed).toBe(0);
    expect(report.reconnectRequired).toBe(0);
    expect(report.errors).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled(); // NEVER attempts fb_exchange_token
    expect(setSyncStateMock).not.toHaveBeenCalled(); // healthy connector stays untouched
    expect(incrementCounterMock).toHaveBeenCalledWith('meta_token_refresh_skipped_total', {
      reason: 'system_user_token',
    });
  });

  it('still refreshes an ordinary due user token on the same pass (the skip is surgical)', async () => {
    const sutName = 'brain/connector/meta/sut';
    const userName = 'brain/connector/meta/user';
    enumerateConnectorsMock.mockResolvedValue([
      connectorRow('ci-sut', sutName),
      connectorRow('ci-user', userName),
    ]);
    const pool = makePool({
      [sutName]: { access_token: 'SYSTEM-USER-TOKEN', token_type: 'system_user' },
      [userName]: {
        access_token: 'OLD-USER-TOKEN',
        access_token_issued_at: new Date(NOW - 50 * 86400000).toISOString(), // due
      },
    });
    const okFetch = vi.fn(
      async () => new Response(JSON.stringify({ access_token: 'NEW-TOKEN', expires_in: 5184000 }), { status: 200 }),
    );

    const report = await runMetaTokenRefresh(pool, NOW, undefined, okFetch as unknown as typeof fetch);

    expect(report.scanned).toBe(2);
    expect(report.skippedSystemUser).toBe(1);
    expect(report.refreshed).toBe(1);
    expect(report.reconnectRequired).toBe(0);
    expect(report.errors).toBe(0);
    expect(okFetch).toHaveBeenCalledTimes(1); // only the user token exchanged
    // The refreshed bundle was written back (dev_secret upsert) — and NEVER for the system-user one.
    const upserts = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO dev_secret'),
    );
    expect(upserts).toHaveLength(1);
    expect(String(upserts[0]![1][0])).toBe(userName);
    expect(String(upserts[0]![1][1])).toContain('NEW-TOKEN');
  });
});
