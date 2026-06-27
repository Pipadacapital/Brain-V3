/**
 * isolation-fuzz/silver-order-state.test.ts — Silver read seam isolation (NN-2, I-ST01)
 *
 * Proves per-brand isolation on the Silver READ path (silver.order_state) and that the
 * guard is NON-INERT — the exact bypass-green trap a naive isolation test falls into.
 *
 * THE MECHANISM UNDER TEST: packages/metric-engine/src/silver-deps.ts `withSilverBrand`.
 *
 * ── BRAIN V4: this seam now runs over TRINO (Iceberg), not StarRocks ──────────────
 * Brain V4 removes StarRocks as the serving engine; `withSilverBrand` delegates to
 * `withTrinoBrand`, and SilverPool IS the Trino query PORT. Trino's REST API has NO
 * native row-level security (unlike managed StarRocks), so the ${BRAND_PREDICATE} →
 * `brand_id = ?` injection at this seam is the SOLE load-bearing isolation. This test
 * therefore drives the REAL seam (imported from @brain/metric-engine — not a copy) over a
 * Trino-SHAPED in-memory pool, so the positive + mutation-leak proof is deterministic and
 * always runs (no live store / no PEND) while exercising exactly the code that ships.
 *
 * THE NON-INERT PROOF (the part that matters):
 *   1. [positive] withSilverBrand(brandA) returns ONLY brand-A rows (>0), zero brand-B.
 *   2. [mutation / negative-control] the SAME seam, asked for brandA but with the
 *      predicate injection DISABLED (__unsafeDisableBrandPredicate), MUST leak brand-B
 *      rows. If disabling the filter does NOT leak, the predicate was inert (it wasn't
 *      doing the work) → the test FAILS LOUD. This makes the guard's effectiveness
 *      observable (the R1/M-01 demand).
 *
 * The Trino-shaped fake honors the injected predicate exactly the way the Trino REST
 * adapter would: when the SQL contains `brand_id = ?`, it filters to the trailing brandId
 * param; when the mutation path rewrites the sentinel to `1 = 1`, it returns ALL brands.
 */

import { describe, it, expect } from 'vitest';
import { withSilverBrand, type SilverPool } from '@brain/metric-engine';

// Throwaway brand ids unique to this test.
const BRAND_A = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';

interface OrderStateRow {
  brand_id: string;
  order_id: string;
}

/**
 * A Trino-SHAPED in-memory SilverPool. Mirrors how the real Trino adapter would behave
 * AFTER the withSilverBrand/withTrinoBrand seam has substituted the sentinel:
 *   • enabled seam  → SQL contains `brand_id = ?`; the trailing param is the brandId →
 *                     the fake filters rows to that brand (no cross-brand rows returned).
 *   • disabled seam → SQL contains `1 = 1` (no `brand_id = ?`) and no brandId param →
 *                     the fake returns ALL brands (the cross-brand leak the mutation proves).
 *
 * This is engine-agnostic: the seam under test is the ${BRAND_PREDICATE} injection, and
 * this fake makes the injected predicate load-bearing exactly as a real Trino read would.
 */
function makeTrinoShapedPool(rows: OrderStateRow[]): SilverPool {
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const hasBrandPredicate = sql.includes('brand_id = ?');
      if (hasBrandPredicate) {
        // The seam appends brandId as the LAST param (parameterized predicate).
        const brandId = params[params.length - 1] as string;
        return rows.filter((r) => r.brand_id === brandId) as unknown as T[];
      }
      // Mutation path (`1 = 1`): no brand filter → every brand's rows leak.
      return [...rows] as unknown as T[];
    },
  };
}

const SEED_ROWS: OrderStateRow[] = [
  { brand_id: BRAND_A, order_id: 'iso-fuzz-a-1' },
  { brand_id: BRAND_B, order_id: 'iso-fuzz-b-1' },
];

const SEED_TABLE = 'brain_serving.mv_silver_order_state';

describe('Silver read seam — per-brand isolation (NN-2 / I-ST01, withSilverBrand over Trino)', () => {
  it('[positive] withSilverBrand(brandA) returns ONLY brand-A rows, zero brand-B', async () => {
    const pool = makeTrinoShapedPool(SEED_ROWS);

    const rows = await withSilverBrand(pool, BRAND_A, async (scope) =>
      scope.runScoped<{ brand_id: string }>(
        `SELECT brand_id FROM ${SEED_TABLE} WHERE \${BRAND_PREDICATE} AND order_id IN ('iso-fuzz-a-1','iso-fuzz-b-1')`,
      ),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.brand_id).toBe(BRAND_A);
    expect(rows.some((r) => r.brand_id === BRAND_B)).toBe(false);
  });

  it('[mutation / NON-INERT proof] disabling the seam predicate MUST leak brand-B rows', async () => {
    const pool = makeTrinoShapedPool(SEED_ROWS);

    // Same logical read, asked for brand-A, but with predicate injection DISABLED.
    // If the predicate were inert (not doing the work), the result would be unchanged
    // and brand-B would still be excluded — and THIS assertion would fail, exposing it.
    const leaked = await withSilverBrand(
      pool,
      BRAND_A,
      async (scope) =>
        scope.runScoped<{ brand_id: string }>(
          `SELECT brand_id FROM ${SEED_TABLE} WHERE \${BRAND_PREDICATE} AND order_id IN ('iso-fuzz-a-1','iso-fuzz-b-1')`,
        ),
      { __unsafeDisableBrandPredicate: true },
    );

    // The guard is PROVEN non-inert: without it, brand-B leaks.
    expect(leaked.some((r) => r.brand_id === BRAND_B)).toBe(true);
  });

  it('[fail-closed] a query missing the ${BRAND_PREDICATE} sentinel THROWS (never runs un-scoped)', async () => {
    const pool = makeTrinoShapedPool(SEED_ROWS);
    await expect(
      withSilverBrand(pool, BRAND_A, async (scope) =>
        scope.runScoped<{ brand_id: string }>(`SELECT brand_id FROM ${SEED_TABLE} WHERE 1 = 1`),
      ),
    ).rejects.toThrow(/BRAND_PREDICATE/);
  });

  it('[documentation] Trino has no native row policy — the seam predicate IS the isolation', () => {
    // ALWAYS PASSES — documents the platform boundary honestly. Brain V4 serving is Trino over
    // Iceberg; unlike managed StarRocks (CREATE ROW POLICY) there is no engine row filter, so the
    // withSilverBrand/withTrinoBrand seam predicate is the SOLE isolation, proven non-inert above.
    expect('Silver isolation = app-seam predicate over Trino (non-inert); no native row policy').toBeTruthy();
  });
});
