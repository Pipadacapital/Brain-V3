/**
 * @brain/metric-engine — computeRealizedGmvForPeriod (the BILLING meter seam, Tier-0).
 *
 * The sanctioned per-billing-period realized-GMV figure for the billing meter (gmv_meter_snapshot).
 * D-3: money math lives in the metric engine, never as an ad-hoc SUM in app code — this is the
 * lakehouse replacement for the PostgreSQL realized_gmv_for_period() function (medallion realignment,
 * Epic 1 / decision B: billing reads the lakehouse, not the PG ledger).
 *
 * Realized GMV for a period = Σ amount_minor over the period's NON-provisional events
 * (finalization + cod_delivery_confirmed + reversals), i.e. the canonical realized definition, keyed by
 * billing_posted_period (the DELTA billed to THIS period, not a cumulative as-of). Signed BIGINT minor
 * units (I-S07); the caller floors at 0 for the non-negative billed figure. Also returns the period's
 * currency (single-per-brand, M1) + the provenance row count.
 *
 * Reads brain_gold.gold_revenue_ledger via withSilverBrand (I-ST01); never PostgreSQL.
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface RealizedGmvForPeriod {
  /** Realized GMV for the period in signed minor units (caller floors at 0). */
  gmvMinor: bigint;
  /** Currency of the period's rows (single-per-brand M1); null when the period has no rows. */
  currencyCode: string | null;
  /** Provenance: how many ledger rows posted to this billing period. */
  rowCount: number;
}

/**
 * computeRealizedGmvForPeriod — realized GMV billed to a 'YYYY-MM' period, from the lakehouse ledger.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param period  - 'YYYY-MM' billing_posted_period.
 * @param deps    - { srPool } — the StarRocks Silver/Gold pool.
 */
export async function computeRealizedGmvForPeriod(
  brandId: string,
  period: string,
  deps: { srPool: SilverPool },
): Promise<RealizedGmvForPeriod> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      gmv_minor: string | number;
      currency_code: string | null;
      row_count: string | number;
    }>(
      `SELECT
         SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END) AS gmv_minor,
         MAX(currency_code) AS currency_code,
         COUNT(*) AS row_count
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE billing_posted_period = ?
         AND ${BRAND_PREDICATE}`,
      [period],
    );
    const r = rows[0];
    return {
      gmvMinor: BigInt(String(r?.gmv_minor ?? '0').split('.')[0] || '0'),
      currencyCode: r?.currency_code ?? null,
      rowCount: Number(String(r?.row_count ?? '0').split('.')[0] || '0'),
    };
  });
}
