/**
 * @brain/metric-engine — computeUtmSource (P3 — the UTM / acquisition-SOURCE matrix) + the
 * acquisition-source DRILLDOWN member resolver.
 *
 * Two read shapes over the Gold tier, ONE acquisition concept:
 *   • computeUtmSource — the matrix: the SOLE reader of the Gold mart `gold_utm_source`, served through
 *     the Trino serving view brain_serving.mv_gold_utm_source via withSilverBrand (I-ST01 — the engine
 *     is the only Gold reader; the UI never queries the lakehouse directly). One row per
 *     (source, medium): visitors, conversions, revenue_minor, avg_ltv_minor, repeat_rate_pct, currency.
 *   • getCustomerAcquisitionSourceMembers — the drilldown FILTER: the brain_ids whose
 *     gold_customer_360.acquisition_source matches a requested first-touch source, so the identity
 *     reader can paginate/search WITHIN that allowlist (same cross-store-safe seam the segment filter
 *     uses — the filter resolves at the mart, pagination stays in the graph).
 *
 * MONEY (I-S07): revenue_minor + avg_ltv_minor are bigint MINOR units paired with the row's sibling
 * currency_code (the group's dominant currency, carried verbatim from the mart) — never a float, never
 * blended across currencies. repeat_rate_pct is a NON-money integer 0-100.
 *
 * @see db/iceberg/spark/gold/gold_utm_source.py + db/trino/views/mv_gold_utm_source.sql
 * @see packages/metric-engine/src/customer-scores-batch.ts — the sibling member-resolver pattern
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Coerce a Trino numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** One (source, medium) row of the acquisition matrix. */
export interface UtmSourceRow {
  /** First-touch utm_source ('unknown' for an honest-empty dim). */
  source: string;
  /** First-touch utm_medium ('unknown' for an honest-empty dim). */
  medium: string;
  /** Distinct visitors whose FIRST touch carries this (source, medium). */
  visitors: bigint;
  /** Distinct orders attributed to those visitors (first-touch credit). */
  conversions: bigint;
  /** Σ attributed order value in bigint MINOR units (paired with currencyCode; never blended). */
  revenueMinor: bigint;
  /** AVG lifetime value of customers acquired via this source in bigint MINOR units (same currency). */
  avgLtvMinor: bigint;
  /** % of those acquired customers with >= 2 lifetime orders (integer 0-100; NON-money). */
  repeatRatePct: number;
  /** The group's dominant currency for revenueMinor + avgLtvMinor — never blended. Null = no money signal. */
  currencyCode: string | null;
}

export interface UtmSourceResult {
  /** True iff the brand has any acquisition-matrix rows (honest no_data). */
  hasData: boolean;
  /** The (source, medium) rows, ordered by revenue desc then visitors desc. */
  rows: UtmSourceRow[];
}

interface UtmRow {
  source: string;
  medium: string;
  visitors: string | number | null;
  conversions: string | number | null;
  revenue_minor: string | number | null;
  avg_ltv_minor: string | number | null;
  repeat_rate_pct: string | number | null;
  currency_code: string | null;
}

/**
 * computeUtmSource — the per-brand UTM / acquisition-source matrix.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_utm_source via brain_serving.mv_gold_utm_source).
 * @returns       The (source, medium) matrix; hasData=false when the brand has no rows.
 */
export async function computeUtmSource(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<UtmSourceResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally to its single `?`.
    const rows = await scope.runScoped<UtmRow>(
      `SELECT source, medium, visitors, conversions, revenue_minor,
              avg_ltv_minor, repeat_rate_pct, currency_code
         FROM brain_serving.mv_gold_utm_source
        WHERE ${BRAND_PREDICATE}
        ORDER BY revenue_minor DESC, visitors DESC, source ASC, medium ASC`,
      [],
    );

    if (rows.length === 0) {
      return { hasData: false, rows: [] };
    }

    return {
      hasData: true,
      rows: rows.map((r) => ({
        source: String(r.source),
        medium: String(r.medium),
        visitors: toBig(r.visitors),
        conversions: toBig(r.conversions),
        revenueMinor: toBig(r.revenue_minor),
        avgLtvMinor: toBig(r.avg_ltv_minor),
        repeatRatePct: Number(String(r.repeat_rate_pct ?? '0').split('.')[0] ?? '0'),
        currencyCode: r.currency_code ?? null,
      })),
    };
  });
}

/**
 * getCustomerAcquisitionSourceMembers — the brain_ids whose gold_customer_360.acquisition_source ===
 * `acquisitionSource` (first-touch channel).
 *
 * The acquisition-source DRILLDOWN seam: the identity reader paginates/searches WITHIN this allowlist,
 * so the acquisition source is resolved at the Gold mart while the graph keeps owning
 * pagination/search/total (no cross-store paging hazard). Mirrors getCustomerSegmentMembers.
 *
 * Bounded by `cap` (default 50_000 customers). Empty brand / unavailable tier / blank source → []
 * (honest-empty). Brand from session (D-1).
 */
export async function getCustomerAcquisitionSourceMembers(
  brandId: string,
  acquisitionSource: string,
  deps: { srPool: SilverPool },
  cap = 50_000,
): Promise<string[]> {
  const src = (acquisitionSource ?? '').trim();
  if (src.length === 0) return [];

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // The caller's own placeholder (acquisition_source) comes FIRST; the seam APPENDS brand_id = ? LAST.
    const rows = await scope.runScoped<{ brain_id: string }>(
      `SELECT brain_id
         FROM brain_serving.mv_gold_customer_360
        WHERE acquisition_source = ? AND ${BRAND_PREDICATE}
        LIMIT ${cap}`,
      [src],
    );
    return rows.map((r) => r.brain_id).filter((x) => typeof x === 'string' && x.length > 0);
  });
}
