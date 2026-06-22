/**
 * enumerate-coverage.test.ts — structural guard: every key in REPULL_DISPATCH
 * MUST be reachable from enumerateConnectedConnectors.
 *
 * Kills the silent-miss class permanently: if a provider is added to REPULL_DISPATCH
 * without a matching enumerate block, this test fails immediately (no DB required).
 *
 * Design: mock the Pool.query() method so each DB call returns one synthetic row with
 * a recognisable connector_instance_id and brand_id. The mock is a call-order stub —
 * the N-th call returns the N-th provider row. Because enumerateConnectedConnectors
 * issues one query per provider (plus the ads query that returns multiple providers),
 * we rely on the fact that every provider except 'meta' and 'google_ads' maps 1:1 to
 * one query block. The ad-spend block returns both meta+google_ads from a single fn;
 * the rest return exactly one provider per block. The test verifies the FULL SET of
 * providers appears in the returned rows — not call order.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { enumerateConnectedConnectors, REPULL_PROVIDERS } from './run.js';

/**
 * Build a fake Pool.query stub that returns one synthetic row per SQL call.
 * Each call is mapped to a specific provider so the stub is deterministic.
 *
 * The mapping must mirror enumerateConnectedConnectors exactly:
 *   1st call → shopify           (list_connectors_for_repull)
 *   2nd call → razorpay          (list_razorpay_connectors_for_settlement_repull)
 *   3rd call → meta + google_ads (list_ad_connectors_for_spend_repull — one fn, two rows)
 *   4th call → gokwik            (list_gokwik_connectors_for_awb_repull)
 *   5th call → shiprocket        (list_shiprocket_connectors_for_repull)
 *   6th call → woocommerce       (list_woocommerce_connectors_for_repull)
 */
function buildMockPool(): Pool {
  const callSequence: Array<Array<{ connector_instance_id: string; brand_id: string; provider?: string }>> = [
    // call 1: shopify
    [{ connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000001', brand_id: 'bbbbbbbb-0000-4000-8000-000000000001' }],
    // call 2: razorpay
    [{ connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000002', brand_id: 'bbbbbbbb-0000-4000-8000-000000000002' }],
    // call 3: ads (returns meta + google_ads — two rows with explicit provider column)
    [
      { connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000003', brand_id: 'bbbbbbbb-0000-4000-8000-000000000003', provider: 'meta' },
      { connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000004', brand_id: 'bbbbbbbb-0000-4000-8000-000000000004', provider: 'google_ads' },
    ],
    // call 4: gokwik
    [{ connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000005', brand_id: 'bbbbbbbb-0000-4000-8000-000000000005' }],
    // call 5: shiprocket
    [{ connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000006', brand_id: 'bbbbbbbb-0000-4000-8000-000000000006' }],
    // call 6: woocommerce
    [{ connector_instance_id: 'aaaaaaaa-0000-4000-8000-000000000007', brand_id: 'bbbbbbbb-0000-4000-8000-000000000007' }],
  ];

  let callIndex = 0;
  const mockQuery = vi.fn((): Promise<QueryResult<QueryResultRow>> => {
    const rows = callSequence[callIndex] ?? [];
    callIndex++;
    return Promise.resolve({
      rows,
      rowCount: rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } satisfies QueryResult<QueryResultRow>);
  });

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
        `Add a query block for each missing provider — a "Sync now" for them is a silent no-op.`,
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
});
