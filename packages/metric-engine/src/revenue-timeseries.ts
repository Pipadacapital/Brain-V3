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

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

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
  deps: { srPool: SilverPool },
): Promise<TimeseriesBucket[]> {
  const fromStr = params.fromDate.toISOString().split('T')[0] as string;
  const toStr = params.toDate.toISOString().split('T')[0] as string;
  // 'day' | 'week' — TS-controlled constant; guard before interpolating into date_trunc.
  const grain = params.grain === 'week' ? 'week' : 'day';

  // MEDALLION REALIGNMENT (Epic 1): read the lakehouse (brain_gold.gold_revenue_ledger, sourced from
  // Bronze recognition) via withSilverBrand — NOT the PostgreSQL ledger. Realized = every non-provisional
  // event (the canonical realized definition, COD-inclusive). One pass, conditional aggregation.
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
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
    const rows = await scope.runScoped<{
      bucket: string;
      currency_code: string;
      realized_minor: string | number;
      provisional_minor: string | number;
    }>(
      `SELECT
         CAST(date_trunc('${grain}', occurred_at) AS DATE) AS bucket,
         currency_code,
         SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END) AS realized_minor,
         SUM(CASE WHEN event_type = 'provisional_recognition' THEN amount_minor ELSE 0 END)  AS provisional_minor
       FROM brain_gold.gold_revenue_ledger
       WHERE CAST(occurred_at AS DATE) BETWEEN ? AND ?
         AND ${BRAND_PREDICATE}
       GROUP BY 1, 2
       ORDER BY 1 ASC, 2 ASC`,
      [fromStr, toStr],
    );

    return rows.map((row) => ({
      bucket: String(row.bucket).split('T')[0] as string,
      currency_code: row.currency_code,
      realizedMinor: BigInt(String(row.realized_minor ?? '0').split('.')[0] || '0'),
      provisionalMinor: BigInt(String(row.provisional_minor ?? '0').split('.')[0] || '0'),
    }));
  });
}
