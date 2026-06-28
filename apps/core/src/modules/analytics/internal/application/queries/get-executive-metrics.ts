/**
 * getExecutiveMetrics — analytics use-case (ADR-002 sole-read-path) for the executive headline tiles.
 *
 * H9: the headline KPIs (AOV, LTV, repeat_rate) now go THROUGH the metric registry over the Gold
 * serving marts (gold_executive_metrics + gold_customer_360 + gold_cohorts) instead of an ad-hoc BFF
 * SUM. CAC + ROAS are surfaced alongside (CAC from gold_cac via computeCac; ROAS from the existing
 * blended-roas read). NO ad-hoc arithmetic here (D-3); the engine derives every ratio. Serializes
 * bigint→string (D-1). Money = BIGINT minor units + currency_code (I-S07).
 *
 * Honest no_data when the brand has no Gold executive rows. Per-currency rows; the UI surfaces the
 * primary-currency tile (multi-currency brands see the full set).
 */

import type { SilverPool, AttributionModelId } from '@brain/metric-engine';
import { computeExecutiveMetrics, computeCac } from '@brain/metric-engine';
import { getBlendedRoas } from './get-blended-roas.js';

export interface ExecutiveMetricDto {
  currency_code: string;
  realized_minor: string;      // bigint → string
  total_orders: string;        // bigint → string
  distinct_customers: string;  // bigint → string
  aov_minor: string | null;    // exact decimal string of minor units, or null when orders=0
  ltv_minor: string | null;    // cohort-naive realized-per-customer, or null when customers=0
  repeat_rate_pct: string | null; // percent string, or null when no customers
  cac_minor: string | null;    // CAC minor units, or null when no acquisitions / no spend
  roas_ratio: string | null;   // blended ROAS, or null when spend=0
}

export type ExecutiveMetricsResult =
  | { state: 'no_data'; generated_at: string }
  | { state: 'has_data'; metrics: ExecutiveMetricDto[]; generated_at: string };

export interface ExecutiveMetricsParams {
  /** Inclusive window for CAC + ROAS (the headline ratios are point-in-time over the order spine). */
  fromDate: Date;
  toDate: Date;
  /** Attribution model is irrelevant to blended ROAS; kept for parity with the attribution surfaces. */
  model?: AttributionModelId;
}

export async function getExecutiveMetrics(
  brandId: string,
  params: ExecutiveMetricsParams,
  deps: { srPool: SilverPool },
): Promise<ExecutiveMetricsResult> {
  // served_at: the server compute time for this read — an HONEST "as of" the FreshnessBadge can show as
  // a real relative time (the Gold marts carry no per-read watermark of their own at this grain).
  const generatedAt = new Date().toISOString();

  const exec = await computeExecutiveMetrics(brandId, deps);
  if (!exec.hasData) {
    return { state: 'no_data', generated_at: generatedAt };
  }

  // CAC (per currency) + blended ROAS (per currency) over the window — both lakehouse reads.
  const cacRows = await computeCac(brandId, { fromDate: params.fromDate, toDate: params.toDate }, deps);
  const cacByCcy = new Map(cacRows.map((r) => [r.currency_code, r.cacMinor]));

  const roas = await getBlendedRoas(brandId, { fromDate: params.fromDate, toDate: params.toDate }, deps);
  const roasByCcy = new Map<string, string | null>();
  if (roas.state === 'has_data') {
    for (const r of roas.rows) roasByCcy.set(r.currency_code, r.roas_ratio);
  }

  return {
    state: 'has_data',
    generated_at: generatedAt,
    metrics: exec.rows.map((r) => ({
      currency_code: r.currencyCode,
      realized_minor: String(r.realizedValueMinor),
      total_orders: String(r.totalOrders),
      distinct_customers: String(r.distinctCustomers),
      aov_minor: r.aovMinor,
      ltv_minor: r.ltvMinor,
      repeat_rate_pct: r.repeatRatePct,
      cac_minor: cacByCcy.get(r.currencyCode) ?? null,
      roas_ratio: roasByCcy.get(r.currencyCode) ?? null,
    })),
  };
}
