/**
 * getKpiSummary — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin query wrapper around computeKpiSummary (metric engine).
 * Serializes bigint → string for JSON safety (D-1).
 */

import type { EngineDeps } from '@brain/metric-engine';
import { computeKpiSummary, withBrandTxn } from '@brain/metric-engine';

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
  | { state: 'has_data'; as_of: string; kpis: KpiSummaryDto[] };

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
  deps: EngineDeps,
): Promise<KpiSummaryResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  // EXISTS check (D-2)
  const hasData = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
  });

  if (!hasData) {
    return { state: 'no_data', as_of: asOfStr };
  }

  const kpis = await computeKpiSummary(brandId, asOf, deps);

  return {
    state: 'has_data',
    as_of: asOfStr,
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
