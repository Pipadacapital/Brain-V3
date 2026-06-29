/**
 * getKpiSummary — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeKpiSummary (metric engine).
 * Serializes bigint → string for JSON safety (D-1).
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeKpiSummary, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface KpiSummaryDto {
  currency_code: string;
  realized_minor: string;    // bigint → string
  provisional_minor: string; // bigint → string
  order_count: string;       // bigint → string
  aov_minor: string;         // bigint → string
  rto_rate_pct: string;      // numeric string e.g. '3.25'
}

export type KpiSummaryResult =
  | { state: 'no_data'; as_of: string }
  // coverage_start/coverage_end bound the data window these (cumulative, all-time) KPIs are
  // computed over — the earliest and latest recognised order date for the brand. The UI shows
  // them as the metric's timeframe ("All-time · <start> – <end>") so a brand can verify exactly
  // what period a number reflects (Brain rule: confidence + freshness measurable). ISO date,
  // null only if the ledger somehow has no dated rows.
  | {
      state: 'has_data';
      as_of: string;
      coverage_start: string | null;
      coverage_end: string | null;
      kpis: KpiSummaryDto[];
    };

/**
 * getKpiSummary — returns brand KPI snapshot as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param asOf    - As-of date.
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getKpiSummary(
  brandId: string,
  asOf: Date,
  deps: { srPool: SilverPool },
): Promise<KpiSummaryResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // EXISTS check (D-2) + data-coverage window in one scoped read over the lakehouse ledger
  // (Epic 1). min/max(occurred_at) is the honest timeframe the all-time KPIs span; the UI
  // surfaces it so a brand can verify what period each number reflects.
  const coverage = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const r = await scope.runScoped<{ n: string | number; cov_start: string | null; cov_end: string | null }>(
      `SELECT COUNT(*) AS n,
              CAST(min(occurred_at) AS varchar) AS cov_start,
              CAST(max(occurred_at) AS varchar) AS cov_end
         FROM brain_serving.mv_gold_revenue_ledger WHERE ${BRAND_PREDICATE}`,
      [],
    );
    return {
      hasData: Number(r[0]?.n ?? 0) > 0,
      start: r[0]?.cov_start ?? null,
      end: r[0]?.cov_end ?? null,
    };
  });

  if (!coverage.hasData) {
    return { state: 'no_data', as_of: asOfStr };
  }

  const kpis = await computeKpiSummary(brandId, asOf, deps);

  return {
    state: 'has_data',
    as_of: asOfStr,
    coverage_start: coverage.start,
    coverage_end: coverage.end,
    kpis: kpis.map((k) => ({
      currency_code: k.currency_code,
      realized_minor: String(k.realizedMinor),
      provisional_minor: String(k.provisionalMinor),
      order_count: String(k.orderCount),
      aov_minor: String(k.aovMinor),
      rto_rate_pct: k.rtoRatePct,
    })),
  };
}
