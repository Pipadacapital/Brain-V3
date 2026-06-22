/**
 * getContributionMargin — analytics use-case for CM1/CM2 (ADR-002 sole-read-path).
 *
 * Thin wrapper over computeContributionMargin (metric engine) — the SOLE margin computer. No ad-hoc
 * math here. Serializes bigint → string (D-1); honest no_data; money is bigint-as-string minor units
 * (I-S07). brandId from session (D-1). @see packages/metric-engine/src/contribution-margin.ts
 */
import type { ContributionMarginDeps, CostConfidence } from '@brain/metric-engine';
import { computeContributionMargin } from '@brain/metric-engine';

export interface ContributionMarginDto {
  currency_code: string;
  net_revenue_minor: string;
  cogs_minor: string;
  variable_cost_minor: string;
  cm1_minor: string;
  marketing_minor: string;
  cm2_minor: string;
  cost_confidence: CostConfidence;
}

export type ContributionMarginResult =
  | { state: 'no_data'; as_of: string }
  | { state: 'has_data'; as_of: string; margin: ContributionMarginDto };

export async function getContributionMargin(
  brandId: string,
  asOf: Date,
  deps: ContributionMarginDeps,
): Promise<ContributionMarginResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;
  const r = await computeContributionMargin(brandId, asOf, deps);
  if (!r.hasData || r.currencyCode === null) {
    return { state: 'no_data', as_of: asOfStr };
  }
  return {
    state: 'has_data',
    as_of: asOfStr,
    margin: {
      currency_code: r.currencyCode,
      net_revenue_minor: String(r.netRevenueMinor),
      cogs_minor: String(r.cogsMinor),
      variable_cost_minor: String(r.variableCostMinor),
      cm1_minor: String(r.cm1Minor),
      marketing_minor: String(r.marketingMinor),
      cm2_minor: String(r.cm2Minor),
      cost_confidence: r.costConfidence,
    },
  };
}
