/**
 * parity-oracle/reference.ts — INDEPENDENT reference recompute for realized revenue.
 *
 * CRITICAL INVARIANT (D-2, non-tautological parity gate):
 *   This helper MUST NOT import @brain/metric-engine.
 *   This helper MUST NOT call realized_gmv_as_of() or provisional_gmv_as_of().
 *   It uses a structurally different SQL predicate path over the same ledger.
 *   Violating this = the CI gate proves nothing (tautology = useless).
 *
 * The independent SQL differs from the engine's named seam in two load-bearing ways:
 *   1. Different exclusion predicate:
 *      Engine (realized_gmv_as_of): WHERE event_type <> 'provisional_recognition'
 *      Reference (this file):       WHERE recognition_label = 'finalized'
 *      These are semantically equivalent for the M1 ledger, but structurally different.
 *      A bug that lets a provisional row through path A (wrong event_type filter) will
 *      produce a non-zero delta here, because path B's recognition_label='finalized'
 *      excludes it.
 *   2. Different shape:
 *      Engine path: returns a single BIGINT (scalar), wrapped into Map by engine.
 *      Reference path: GROUP BY currency_code directly → returns per-currency rows.
 *      A cross-currency blend in the engine produces a delta here.
 *
 * The parity test compares Map<string, bigint> from the engine against Map<string, bigint>
 * from this helper. Per-currency equality, tolerance 0. Any delta = CI FAIL.
 *
 * @see D-2 (03-architecture-plan.md) — the non-tautological parity binding
 * @see 02-cto-advisor-review.md §CRITICAL — tautological oracle risk
 */

import type { PoolClient } from 'pg';

// IMPORTANT: DO NOT add 'import ... from "@brain/metric-engine"' here.
// DO NOT call realized_gmv_as_of() or provisional_gmv_as_of() here.
// This file uses RAW SQL only. That is what makes the oracle non-tautological.

/**
 * getIndependentReferenceRevenue — INDEPENDENT recompute of realized revenue.
 *
 * Runs the reference SQL directly against the ledger with a structurally different
 * predicate than realized_gmv_as_of(). Returns Map<currency_code, bigint>.
 *
 * REFERENCE SQL:
 *   SELECT currency_code, SUM(amount_minor) AS realized_minor
 *   FROM realized_revenue_ledger
 *   WHERE brand_id = $1
 *     AND economic_effective_at::date <= $2::date
 *     AND recognition_label = 'finalized'
 *   GROUP BY currency_code
 *
 * @param brandId - The brand UUID.
 * @param asOf    - The as-of date string ('YYYY-MM-DD').
 * @param client  - A pg PoolClient (must already have brand GUC set in caller's txn).
 * @returns       Map<currency_code, bigint> — realized revenue per currency.
 *                Empty map if no finalized rows. bigint minor units (I-S07).
 */
export async function getIndependentReferenceRevenue(
  brandId: string,
  asOf: string,
  client: PoolClient,
): Promise<Map<string, bigint>> {
  // INDEPENDENT SQL — structurally different from realized_gmv_as_of():
  //   - Uses recognition_label = 'finalized' (not event_type <> 'provisional_recognition')
  //   - Uses GROUP BY currency_code (not a scalar BIGINT return)
  const result = await client.query<{ currency_code: string; realized_minor: string }>(
    `SELECT currency_code, SUM(amount_minor)::BIGINT AS realized_minor
     FROM realized_revenue_ledger
     WHERE brand_id = $1
       AND economic_effective_at::date <= $2::date
       AND recognition_label = 'finalized'
     GROUP BY currency_code`,
    [brandId, asOf],
  );

  const map = new Map<string, bigint>();
  for (const row of result.rows) {
    // pg returns bigint columns as string to avoid JS precision loss
    map.set(row.currency_code, BigInt(row.realized_minor));
  }
  return map;
}

/**
 * getIndependentReferenceProvisional — INDEPENDENT recompute of provisional revenue.
 *
 * Structurally different from provisional_gmv_as_of() in predicate expression style
 * (direct raw SQL, not via the named function). Returns Map<currency_code, bigint>.
 *
 * REFERENCE SQL:
 *   SELECT currency_code, SUM(amount_minor) AS provisional_minor
 *   FROM realized_revenue_ledger
 *   WHERE brand_id = $1
 *     AND economic_effective_at::date <= $2::date
 *     AND recognition_label IN ('provisional', 'settling')
 *   GROUP BY currency_code
 *
 * @param brandId - The brand UUID.
 * @param asOf    - The as-of date string ('YYYY-MM-DD').
 * @param client  - A pg PoolClient (must already have brand GUC set in caller's txn).
 * @returns       Map<currency_code, bigint> — provisional revenue per currency.
 *                Empty map if no provisional/settling rows. bigint minor units (I-S07).
 */
export async function getIndependentReferenceProvisional(
  brandId: string,
  asOf: string,
  client: PoolClient,
): Promise<Map<string, bigint>> {
  const result = await client.query<{ currency_code: string; provisional_minor: string }>(
    `SELECT currency_code, SUM(amount_minor)::BIGINT AS provisional_minor
     FROM realized_revenue_ledger
     WHERE brand_id = $1
       AND economic_effective_at::date <= $2::date
       AND recognition_label IN ('provisional', 'settling')
     GROUP BY currency_code`,
    [brandId, asOf],
  );

  const map = new Map<string, bigint>();
  for (const row of result.rows) {
    map.set(row.currency_code, BigInt(row.provisional_minor));
  }
  return map;
}
