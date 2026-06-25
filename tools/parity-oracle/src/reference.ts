/**
 * parity-oracle/reference.ts — INDEPENDENT reference recompute for realized revenue.
 *
 * ── MEDALLION RE-POINT (Phase G) ─────────────────────────────────────────────
 * The realized-revenue READ path moved off the PG `realized_revenue_ledger`
 * (dropped as a dashboard source) onto the lakehouse gold ledger
 * `brain_gold.gold_revenue_ledger`, reached over the StarRocks MySQL wire
 * (mysql2). The engine (computeRealizedRevenue / computeProvisionalRevenue) now
 * reads gold via withSilverBrand. So this independent reference reads the SAME
 * gold table — but with a STRUCTURALLY DIFFERENT predicate path, preserving the
 * non-tautological gate.
 *
 * CRITICAL INVARIANT (D-2, non-tautological parity gate):
 *   This helper MUST NOT import @brain/metric-engine.
 *   This helper MUST NOT reuse the engine's predicate expression.
 *   It uses a structurally different SQL predicate path over the same gold table.
 *   Violating this = the CI gate proves nothing (tautology = useless).
 *
 * The independent SQL differs from the engine path in two load-bearing ways:
 *   1. Different exclusion predicate:
 *      Engine (realized):  WHERE event_type <> 'provisional_recognition'
 *      Reference (realized): WHERE recognition_label = 'finalized'
 *      These are semantically equivalent for the ledger, but structurally
 *      different. A bug that lets a provisional row through the engine's
 *      event_type filter produces a non-zero delta here (recognition_label
 *      ='finalized' excludes it).
 *   2. Different shape:
 *      Engine realized path: SUM(...)→scalar + MAX(currency_code) (single row),
 *        wrapped into a Map by the engine.
 *      Reference path: GROUP BY currency_code → returns per-currency rows.
 *      A cross-currency blend in the engine produces a delta here.
 *
 * The provisional reference mirrors the inversion: the engine filters on
 *   recognition_label IN ('provisional','settling'); the reference filters on
 *   event_type = 'provisional_recognition' — the disjoint complement of the
 *   realized event_type predicate, again structurally distinct.
 *
 * The parity test compares Map<string, bigint> from the engine against
 * Map<string, bigint> from this helper. Per-currency equality, tolerance 0.
 * Any delta = CI FAIL.
 *
 * @see D-2 (03-architecture-plan.md) — the non-tautological parity binding
 * @see packages/metric-engine/src/realized-revenue.ts — the engine read path
 */

// IMPORTANT: DO NOT add 'import ... from "@brain/metric-engine"' here.
// DO NOT reuse the engine's predicate expression here.
// This file uses RAW SQL over the gold ledger only. That is what makes the
// oracle non-tautological.

/**
 * Minimal structural type for a mysql2/promise queryable (pool or connection).
 * Typed structurally so this tool does not import mysql2 types — the concrete
 * pool is injected by the test (the StarRocks brain_analytics pool).
 */
export interface GoldQueryable {
  /** mysql2/promise query — returns [rows, fields]. */
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

interface GoldRevenueRow {
  currency_code: string;
  amount_minor: string | number;
}

/**
 * getIndependentReferenceRevenue — INDEPENDENT recompute of realized revenue
 * from the lakehouse gold ledger.
 *
 * Runs the reference SQL directly against brain_gold.gold_revenue_ledger with a
 * structurally different predicate than the engine's realized path. Returns
 * Map<currency_code, bigint>.
 *
 * REFERENCE SQL:
 *   SELECT currency_code, SUM(amount_minor) AS amount_minor
 *   FROM brain_gold.gold_revenue_ledger
 *   WHERE brand_id = ?
 *     AND CAST(economic_effective_at AS DATE) <= ?
 *     AND recognition_label = 'finalized'
 *   GROUP BY currency_code
 *
 * @param brandId - The brand UUID (tenant key — explicit predicate, no GUC on dev StarRocks).
 * @param asOf    - The as-of date string ('YYYY-MM-DD').
 * @param db      - A mysql2/promise queryable against StarRocks (brain_gold).
 * @returns       Map<currency_code, bigint> — realized revenue per currency.
 *                Empty map if no finalized rows. bigint minor units (I-S07).
 */
export async function getIndependentReferenceRevenue(
  brandId: string,
  asOf: string,
  db: GoldQueryable,
): Promise<Map<string, bigint>> {
  // INDEPENDENT SQL — structurally different from the engine's realized path:
  //   - Uses recognition_label = 'finalized' (not event_type <> 'provisional_recognition')
  //   - Uses GROUP BY currency_code (not a scalar SUM + MAX(currency_code) single row)
  const [rows] = await db.query(
    `SELECT currency_code, COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM brain_gold.gold_revenue_ledger
      WHERE brand_id = ?
        AND CAST(economic_effective_at AS DATE) <= ?
        AND recognition_label = 'finalized'
      GROUP BY currency_code`,
    [brandId, asOf],
  );

  const map = new Map<string, bigint>();
  for (const row of rows as GoldRevenueRow[]) {
    // StarRocks may return the SUM as a string (BIGINT) or number; take the
    // integer part defensively and parse as bigint (no float precision loss).
    map.set(row.currency_code, BigInt(String(row.amount_minor).split('.')[0] ?? '0'));
  }
  return map;
}

/**
 * getIndependentReferenceProvisional — INDEPENDENT recompute of provisional
 * revenue from the lakehouse gold ledger.
 *
 * Structurally different from the engine's provisional path: the engine filters
 * recognition_label IN ('provisional','settling'); this reference filters
 * event_type = 'provisional_recognition' (the disjoint complement of the
 * realized event_type predicate). Returns Map<currency_code, bigint>.
 *
 * REFERENCE SQL:
 *   SELECT currency_code, SUM(amount_minor) AS amount_minor
 *   FROM brain_gold.gold_revenue_ledger
 *   WHERE brand_id = ?
 *     AND CAST(economic_effective_at AS DATE) <= ?
 *     AND event_type = 'provisional_recognition'
 *   GROUP BY currency_code
 *
 * @param brandId - The brand UUID.
 * @param asOf    - The as-of date string ('YYYY-MM-DD').
 * @param db      - A mysql2/promise queryable against StarRocks (brain_gold).
 * @returns       Map<currency_code, bigint> — provisional revenue per currency.
 *                Empty map if no provisional rows. bigint minor units (I-S07).
 */
export async function getIndependentReferenceProvisional(
  brandId: string,
  asOf: string,
  db: GoldQueryable,
): Promise<Map<string, bigint>> {
  const [rows] = await db.query(
    `SELECT currency_code, COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM brain_gold.gold_revenue_ledger
      WHERE brand_id = ?
        AND CAST(economic_effective_at AS DATE) <= ?
        AND event_type = 'provisional_recognition'
      GROUP BY currency_code`,
    [brandId, asOf],
  );

  const map = new Map<string, bigint>();
  for (const row of rows as GoldRevenueRow[]) {
    map.set(row.currency_code, BigInt(String(row.amount_minor).split('.')[0] ?? '0'));
  }
  return map;
}
