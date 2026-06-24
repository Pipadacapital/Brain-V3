/**
 * ask-brain.reproducibility.test.ts — the reproducible-from-snapshot proof (D3 / D6.4).
 *
 * THE INVARIANT: a persisted binding re-run at its snapshot_id reproduces the SAME number.
 * `askBrain` computes a number for a binding pinned at `as_of`; `reproduceAnswer` decodes the
 * snapshot_id back to that same `as_of` and re-runs the SAME engine compute path → a
 * byte-identical serialized number.
 *
 * This is a pure unit test with a DETERMINISTIC fake pg.Pool: the fake answers the engine's
 * brand-currency + realized_gmv_as_of seam reads with FIXED values keyed by the as_of it
 * receives. We assert: (a) askBrain and reproduceAnswer produce the identical money map; and
 * (b) the engine was driven with the SAME as_of both times (the snapshot pinned the frame).
 *
 * No model call (askBrain receives a stub resolver returning a fixed binding). No real DB.
 */

import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { askBrain, reproduceAnswer } from './ask-brain.js';
import { encodeSnapshot } from './snapshot.js';
import type { ResolverClient } from '@brain/ai-gateway-client';

const BRAND = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FIXED_REALIZED_MINOR = '123456'; // the deterministic seam value (INR minor units)

/** Records every as_of the realized-revenue gold read is called with (proves the pin). */
const seamAsOfCalls: string[] = [];

/**
 * A minimal deterministic fake StarRocks pool (mysql2/promise shape). MEDALLION REALIGNMENT: the
 * realized + provisional revenue seams now read brain_gold.gold_revenue_ledger via withSilverBrand
 * (a dedicated connection + `${BRAND_PREDICATE}` → `brand_id = ?`). The realized value is CONSTANT —
 * so the only way the two runs could differ is a snapshot-decode bug, which this test would catch.
 * The as_of is inlined into the gold query (`economic_effective_at <= 'YYYY-MM-DD'`); we record it.
 */
function makeFakeSilverPool(): never {
  const conn = {
    async query(sql: string): Promise<[unknown[], unknown]> {
      const text = String(sql);
      if (text.startsWith('SET ')) return [[], undefined];
      // realized-revenue read: SUM(...) AS v, MAX(currency_code) — record the inlined as_of.
      if (text.includes('MAX(currency_code)') && text.includes('gold_revenue_ledger')) {
        const m = text.match(/<=\s*'(\d{4}-\d{2}-\d{2})'/);
        if (m) seamAsOfCalls.push(m[1] as string);
        return [[{ v: FIXED_REALIZED_MINOR, currency_code: 'INR' }], undefined];
      }
      // provisional-revenue read: empty (no provisional rows).
      if (text.includes('provisional_minor')) return [[], undefined];
      // hasData existence check.
      if (text.includes('AS one') && text.includes('gold_revenue_ledger')) {
        return [[{ one: 1 }], undefined];
      }
      // Any other gold read → empty (fail-closed).
      return [[], undefined];
    },
    release() {
      /* no-op */
    },
  };
  return {
    getConnection: async () => conn,
    query: async (sql: string) => conn.query(sql),
  } as never;
}

/**
 * A minimal deterministic fake pg.Pool. It supports the exact query sequence
 * withBrandTxn + computeRealizedRevenue + getRevenueMetrics issue, returning fixed rows.
 * The realized_gmv_as_of value is CONSTANT — so the only way the two runs could differ is a
 * snapshot-decode bug, which this test would catch.
 */
function makeFakePool(): Pool {
  const client = {
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
      const text = String(sql);
      if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('set_config')) return { rows: [], rowCount: 0 };
      // getRevenueMetrics existence check.
      if (text.includes('EXISTS')) return { rows: [{ exists: true }], rowCount: 1 };
      // brand currency lookup.
      if (text.includes('currency_code FROM brand')) {
        return { rows: [{ currency_code: 'INR' }], rowCount: 1 };
      }
      // The as-of seam — record the as_of param (2nd param) and return the FIXED value.
      if (text.includes('realized_gmv_as_of')) {
        seamAsOfCalls.push(String(params?.[1]));
        return { rows: [{ realized_gmv_as_of: FIXED_REALIZED_MINOR }], rowCount: 1 };
      }
      // provisional seam returns TABLE(currency_code, provisional_minor) — empty = no provisional rows.
      if (text.includes('provisional_gmv_as_of')) {
        return { rows: [], rowCount: 0 };
      }
      // ai_provenance INSERT.
      if (text.includes('INSERT INTO ai_provenance')) {
        return { rows: [{ provenance_id: 'prov-1' }], rowCount: 1 };
      }
      // Any unexpected read → empty (fail-closed; the test would notice a missing value).
      return { rows: [], rowCount: 0 };
    },
    release() {
      /* no-op */
    },
  };
  return {
    connect: async () => client,
  } as unknown as Pool;
}

/** A stub resolver that always returns the realized_revenue binding (no model call). */
const stubResolver = {
  async resolve() {
    return { kind: 'binding', metric_id: 'realized_revenue', version: 'v1', params: { date_to: '2026-06-18' } };
  },
} as unknown as ResolverClient;

describe('askBrain — reproducible from snapshot_id (D3 / D6.4)', () => {
  it('re-running (binding, snapshot_id) yields the IDENTICAL serialized number', async () => {
    seamAsOfCalls.length = 0;
    const pool = makeFakePool();
    const srPool = makeFakeSilverPool();
    const asOf = '2026-06-18';

    // getMetricTrust reads dq data → no_data path returns grade 'D' (fine for this test;
    // the FAKE pool returns empty rows for the dq summary reads → honest floor).
    const answer = await askBrain(BRAND, 'what is my realized revenue', asOf, {
      engine: { pool },
      srPool, // realized + provisional now read the lakehouse gold ledger
      resolver: stubResolver,
    });

    expect(answer.kind).toBe('answer');
    if (answer.kind !== 'answer') return;

    // The snapshot_id deterministically encodes the as_of.
    expect(answer.binding.snapshot_id).toBe(encodeSnapshot(asOf));
    expect(answer.number.figure_kind).toBe('money');
    expect(answer.number.money).toEqual({ INR: FIXED_REALIZED_MINOR });

    // Reproduce from the persisted binding + snapshot_id — re-run the SAME engine path.
    const reproduced = await reproduceAnswer(
      BRAND,
      { metric_id: answer.binding.metric_id, version: answer.binding.metric_version, params: answer.binding.params },
      answer.binding.snapshot_id,
      { pool },
      srPool, // realized + provisional now read the lakehouse gold ledger
    );

    // Byte-identical money map — the reproducibility guarantee.
    expect(reproduced).toEqual(answer.number);

    // The engine was driven with the SAME decoded as_of both times (snapshot pinned the frame).
    const asOfsForRealized = seamAsOfCalls;
    expect(asOfsForRealized.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asOfsForRealized).size).toBe(1); // all identical
    expect(asOfsForRealized[0]).toBe(asOf);
  });
});
