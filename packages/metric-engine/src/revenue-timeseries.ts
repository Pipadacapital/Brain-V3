/**
 * @brain/metric-engine — computeRevenueTimeseries
 *
 * Returns per-bucket realized + provisional revenue for charting.
 * The metric engine is the SOLE sanctioned computation layer (ADR-002 / D-3).
 * No ad-hoc SUM(amount_minor) lives outside this package.
 *
 * Realized bucket  = SUM of finalization events + net rto_reversal events
 *                    grouped by date_trunc(grain, occurred_at).
 * Provisional bucket = SUM of provisional_recognition events not yet finalized
 *                      (recognition_label IN ('provisional','settling'))
 *                      grouped by date_trunc(grain, occurred_at).
 *
 * Returns an array of { bucket, currency_code, realizedMinor, provisionalMinor }
 * per distinct (bucket, currency_code) combination inside the date window.
 * Buckets with zero activity in one dimension carry 0n (not null).
 *
 * F-SEC-02: all reads happen inside withBrandTxn so the GUC is transaction-scoped.
 * RLS policy (brand_id = current_setting(...)) scopes rows to the active brand.
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

export type TimeGrain = 'day' | 'week';

export interface TimeseriesBucket {
  /** ISO date string of the bucket start: 'YYYY-MM-DD' */
  bucket: string;
  /** ISO 4217 currency code */
  currency_code: string;
  /** Realized revenue minor units for this bucket */
  realizedMinor: bigint;
  /** Provisional revenue minor units for this bucket */
  provisionalMinor: bigint;
}

/**
 * computeRevenueTimeseries — per-bucket realized + provisional revenue.
 *
 * @param brandId  - Brand UUID (from session — D-1).
 * @param params   - Date window + grain.
 * @param deps     - EngineDeps with raw pg.Pool.
 * @returns        Array of TimeseriesBucket, ordered by bucket ASC.
 *                 Empty array when no ledger rows exist in the window.
 */
export async function computeRevenueTimeseries(
  brandId: string,
  params: { fromDate: Date; toDate: Date; grain: TimeGrain },
  deps: EngineDeps,
): Promise<TimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0];
  const toStr = params.toDate.toISOString().split('T')[0];
  const grain = params.grain; // 'day' | 'week' — safe constant, not user-interpolated

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // Two CTEs — realized and provisional — joined on (bucket, currency_code).
    // Realized = finalization + rto_reversal (net: rto_reversal amounts are negative
    // in the ledger by convention, so SUM gives the correct net figure).
    // Provisional = provisional_recognition where recognition_label IS still provisional/settling
    // (not yet finalized — finalization events share the same order_id but different event_type).
    //
    // We use date_trunc on occurred_at (the ledger event timestamp), not economic_effective_at,
    // because we are charting WHEN events were recorded (the time-series view).
    //
    // grain is a TypeScript-controlled constant ('day'|'week'); safe to embed via
    // a parameterized enum — here we use $3 to pass a string that pg casts to text.
    // We cannot use $3 directly inside date_trunc() because PostgreSQL requires a literal
    // for the first argument. We use CASE to translate.
    const sql = `
      WITH realized AS (
        SELECT
          date_trunc(
            CASE $3::text
              WHEN 'week' THEN 'week'
              ELSE 'day'
            END,
            occurred_at
          )::date AS bucket,
          currency_code,
          SUM(amount_minor) AS realized_minor
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type IN ('finalization', 'rto_reversal')
          AND occurred_at::date BETWEEN $2::date AND $4::date
        GROUP BY 1, 2
      ),
      provisional AS (
        SELECT
          date_trunc(
            CASE $3::text
              WHEN 'week' THEN 'week'
              ELSE 'day'
            END,
            occurred_at
          )::date AS bucket,
          currency_code,
          SUM(amount_minor) AS provisional_minor
        FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type = 'provisional_recognition'
          AND recognition_label IN ('provisional', 'settling')
          AND occurred_at::date BETWEEN $2::date AND $4::date
        GROUP BY 1, 2
      ),
      combined AS (
        SELECT COALESCE(r.bucket, p.bucket) AS bucket,
               COALESCE(r.currency_code, p.currency_code) AS currency_code,
               COALESCE(r.realized_minor, 0) AS realized_minor,
               COALESCE(p.provisional_minor, 0) AS provisional_minor
        FROM realized r
        FULL OUTER JOIN provisional p
          ON r.bucket = p.bucket AND r.currency_code = p.currency_code
      )
      SELECT bucket, currency_code, realized_minor::text, provisional_minor::text
      FROM combined
      ORDER BY bucket ASC, currency_code ASC
    `;

    const result = await client.query<{
      bucket: Date;
      currency_code: string;
      realized_minor: string;
      provisional_minor: string;
    }>(sql, [brandId, fromStr, grain, toStr]);

    return result.rows.map((row) => ({
      bucket: row.bucket.toISOString().split('T')[0] as string,
      currency_code: row.currency_code,
      realizedMinor: BigInt(row.realized_minor),
      provisionalMinor: BigInt(row.provisional_minor),
    }));
  });
}
