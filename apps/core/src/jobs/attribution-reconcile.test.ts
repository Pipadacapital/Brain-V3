/**
 * attribution-reconcile.test.ts — empty-state vs real-error semantics of the hourly job.
 *
 * Prod evidence (2026-07-12): on a fresh deployment (no finalized orders, serving marts not yet
 * materialized) the job completed with `errors: 1` → exit 1. Empty is an HONEST state (Brain rule:
 * fail safely; no data yet ≠ failure) — these tests pin the classification:
 *   • TRINO_HOST unset OR EMPTY            → whole-job no-op (exit-0 result), never `http://:PORT`.
 *   • serving tier not provisioned         → per-brand skipped_empty (info), errors stays 0.
 *   • anything else (IAM, connectivity, …) → per-brand REAL error, errors > 0 (exit-1 semantics).
 *
 * Runs against a FAKE pg pool + a FAKE Trino pool (mirrors audit-checkpoint.test.ts) — no DB, no
 * Trino. The live-path counterpart is jobs.live.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import type { SilverPool } from '@brain/metric-engine';
import { runAttributionReconcile } from './attribution-reconcile.js';

const BRAND = '5a0f3ac6-1111-4222-8333-444455556666';

/** Minimal pg.Pool stand-in: the job only runs `SELECT id FROM list_active_brand_ids()`. */
function fakePgPool(brandIds: string[]): pg.Pool {
  return {
    query: async () => ({ rows: brandIds.map((id) => ({ id })), rowCount: brandIds.length }),
  } as unknown as pg.Pool;
}

const NOT_FOUND = new Error(
  "[trino-adapter] Trino query error (code 46): line 1:18: Table 'iceberg.brain_serving.mv_gold_attribution_credit' does not exist",
);

/**
 * Scripted Trino pool that reproduces the ONE serving-read path that escapes withSilverBrand's
 * honest-empty degradation: the @brain/attribution-writer DIRECT read-back (readSavedCredits).
 * The wrapped reads answer just enough (a credited order + a reversal on it) to reach the
 * clawback pass, whose direct read-back then throws `directErr`.
 */
function fakeSrPoolReachingDirectReadback(directErr: Error): SilverPool {
  return {
    async query<T>(sql: string): Promise<T[]> {
      // readCreditedOrderIds (wrapped): a non-empty credited set unlocks the clawback pass.
      if (sql.includes('SELECT DISTINCT order_id')) return [{ order_id: 'o1' }] as T[];
      // readSavedCredits (DIRECT srPool.query — bypasses the degradation seam): the thrower.
      if (sql.includes("row_kind = 'credit'") && sql.includes('ORDER BY touch_seq')) throw directErr;
      // readUncreditedRecognized (wrapped): no recognized orders yet (empty basis — honest).
      if (sql.includes("'finalization'")) return [] as T[];
      // readReversalsOnCredited (wrapped): one reversal landing on the credited order.
      if (sql.includes("'refund'")) {
        return [
          {
            order_id: 'o1',
            event_type: 'refund',
            ledger_event_id: 'led-1',
            amount_minor: '1000',
            occurred_at: '2026-07-01 00:00:00.000',
          },
        ] as T[];
      }
      // Corpus / touch reads (wrapped) — nothing stitched yet.
      return [] as T[];
    },
  };
}

describe('runAttributionReconcile — TRINO_HOST gate', () => {
  it('no-ops when TRINO_HOST is unset (no serving tier)', async () => {
    const prev = process.env['TRINO_HOST'];
    delete process.env['TRINO_HOST'];
    try {
      const res = await runAttributionReconcile();
      expect(res).toEqual({ brands: 0, credited: 0, clawed_back: 0, unattributed: 0, skipped_empty: 0, errors: 0 });
    } finally {
      if (prev !== undefined) process.env['TRINO_HOST'] = prev;
    }
  });

  it('no-ops when TRINO_HOST is set but EMPTY (blank secret key ≠ a serving tier)', async () => {
    // Regression pin: an empty-string TRINO_HOST used to pass the `=== undefined` gate and build
    // baseUrl `http://:PORT` — every brand then failed its first fetch → errors:N → exit 1.
    const prev = process.env['TRINO_HOST'];
    process.env['TRINO_HOST'] = '';
    try {
      const res = await runAttributionReconcile();
      expect(res.brands).toBe(0);
      expect(res.errors).toBe(0);
    } finally {
      if (prev === undefined) delete process.env['TRINO_HOST'];
      else process.env['TRINO_HOST'] = prev;
    }
  });
});

describe('runAttributionReconcile — empty-state vs real-error classification', () => {
  it('serving tier fully unprovisioned → wrapped reads degrade to empty, zero errors', async () => {
    // Every serving query fails not-found (fresh env: no brain_serving views / Iceberg marts).
    // The withSilverBrand seam degrades those to [] — the job must complete honestly-empty.
    const srPool: SilverPool = {
      async query(): Promise<never[]> {
        throw NOT_FOUND;
      },
    };
    const res = await runAttributionReconcile({ pool: fakePgPool([BRAND]), srPool });
    expect(res.brands).toBe(1);
    expect(res.errors).toBe(0);
    expect(res.credited).toBe(0);
    expect(res.clawed_back).toBe(0);
  });

  it('a not-found from the DIRECT writer read-back is classified skipped_empty, not an error', async () => {
    // The one escape hatch past the degradation seam: @brain/attribution-writer queries srPool
    // directly for saved credits. A missing mart there is still "no data to reconcile" → exit 0.
    const srPool = fakeSrPoolReachingDirectReadback(NOT_FOUND);
    const res = await runAttributionReconcile({ pool: fakePgPool([BRAND]), srPool });
    expect(res.brands).toBe(1);
    expect(res.skipped_empty).toBe(1);
    expect(res.errors).toBe(0); // exit-0 semantics (entrypoint gates on errors > 0)
  });

  it('a REAL failure (e.g. IAM / connectivity) still counts as an error (exit-1 semantics)', async () => {
    const srPool = fakeSrPoolReachingDirectReadback(
      new Error('[trino-adapter] Trino query error (code 65545): Access Denied (Service: Amazon S3)'),
    );
    const res = await runAttributionReconcile({ pool: fakePgPool([BRAND]), srPool });
    expect(res.brands).toBe(1);
    expect(res.skipped_empty).toBe(0);
    expect(res.errors).toBe(1);
  });

  it('one brand failing does not abort the run — remaining brands still reconcile', async () => {
    const BRAND_B = '6b1f3ac6-2222-4222-8333-444455557777';
    let calls = 0;
    const srPool: SilverPool = {
      async query<T>(_sql: string, params?: unknown[]): Promise<T[]> {
        calls += 1;
        // The seam appends the brand id as the LAST param (brand_id = ?). Only reads for the
        // FIRST brand blow up with a real error; brand B reads honest-empty.
        if (params?.includes(BRAND)) throw new Error('connection reset by peer');
        return [] as T[];
      },
    };
    const res = await runAttributionReconcile({ pool: fakePgPool([BRAND, BRAND_B]), srPool });
    expect(res.brands).toBe(2);
    expect(res.errors).toBe(1);
    expect(calls).toBeGreaterThan(1); // brand B was still attempted after brand A errored
  });
});
