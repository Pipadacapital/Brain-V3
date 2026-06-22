/**
 * enumerate-coverage.test.ts — structural guard: every key in REPULL_DISPATCH
 * MUST be reachable from enumerateConnectedConnectors.
 *
 * Kills the silent-miss class permanently: if a provider is added to REPULL_DISPATCH
 * without being in REPULL_PROVIDERS (which feeds enumerateConnectedConnectors), this
 * test fails immediately (no DB required).
 *
 * Gap A (migration 0091): enumerateConnectedConnectors now issues ONE generic
 * `list_connectors_for_repull($1)` call per provider (Promise.all over REPULL_PROVIDERS),
 * replacing the former 6 bespoke per-provider SECURITY DEFINER fn calls.
 *
 * Mock design: pool.query inspects the second argument (params[0]) to determine which
 * provider is being queried, then returns a synthetic row with that provider stamped.
 * This is parameter-driven (not call-order driven) so it is order-independent and robust
 * to Promise.all concurrency.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { enumerateConnectedConnectors, REPULL_PROVIDERS } from './run.js';

/**
 * Build a fake Pool.query stub that returns one synthetic row per call.
 * The provider is read from the query parameter ($1) so the mock is parameter-driven,
 * not call-order driven — robust to Promise.all.
 */
function buildMockPool(): Pool {
  const mockQuery = vi.fn(
    (_sql: string, params?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
      // The generic fn is called as list_connectors_for_repull($1) with params[0] = provider.
      const provider = Array.isArray(params) ? (params[0] as string) : 'unknown';
      const rows: Array<{ connector_instance_id: string; brand_id: string; provider: string }> = [
        {
          connector_instance_id: `aaaaaaaa-0000-4000-8000-${provider.padStart(12, '0').slice(0, 12)}`,
          brand_id: `bbbbbbbb-0000-4000-8000-${provider.padStart(12, '0').slice(0, 12)}`,
          provider,
        },
      ];
      return Promise.resolve({
        rows,
        rowCount: rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } satisfies QueryResult<QueryResultRow>);
    },
  );

  return { query: mockQuery } as unknown as Pool;
}

describe('enumerateConnectedConnectors — REPULL_DISPATCH coverage guard', () => {
  it('returns at least one row for every provider in REPULL_DISPATCH', async () => {
    const pool = buildMockPool();
    const rows = await enumerateConnectedConnectors(pool);

    const returnedProviders = new Set(rows.map((r) => r.provider));
    const missingFromEnumerate = REPULL_PROVIDERS.filter((p) => !returnedProviders.has(p));

    expect(
      missingFromEnumerate,
      `enumerateConnectedConnectors does NOT produce rows for these REPULL_DISPATCH providers: [${missingFromEnumerate.join(', ')}]. ` +
        `Ensure REPULL_PROVIDERS (= Object.keys(REPULL_DISPATCH)) covers all expected providers.`,
    ).toHaveLength(0);
  });

  it('every enumerated row carries connector_instance_id, brand_id, and provider', async () => {
    const pool = buildMockPool();
    const rows = await enumerateConnectedConnectors(pool);

    for (const row of rows) {
      expect(row.connector_instance_id, 'row must have connector_instance_id').toBeTruthy();
      expect(row.brand_id, 'row must have brand_id').toBeTruthy();
      expect(row.provider, 'row must have provider').toBeTruthy();
    }
  });

  it('the set of providers returned equals REPULL_PROVIDERS (no extras, no gaps)', async () => {
    const pool = buildMockPool();
    const rows = await enumerateConnectedConnectors(pool);

    const returnedProviders = [...new Set(rows.map((r) => r.provider))].sort();
    const expectedProviders = [...REPULL_PROVIDERS].sort();

    expect(returnedProviders).toEqual(expectedProviders);
  });

  it('issues exactly one DB query per provider in REPULL_PROVIDERS', async () => {
    const pool = buildMockPool();
    await enumerateConnectedConnectors(pool);

    const mockQuery = (pool as unknown as { query: ReturnType<typeof vi.fn> }).query;
    // One call per provider via Promise.all
    expect(mockQuery).toHaveBeenCalledTimes(REPULL_PROVIDERS.length);
    // Each call passes the provider name as the first parameter
    for (const provider of REPULL_PROVIDERS) {
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('list_connectors_for_repull'),
        [provider],
      );
    }
  });
});
