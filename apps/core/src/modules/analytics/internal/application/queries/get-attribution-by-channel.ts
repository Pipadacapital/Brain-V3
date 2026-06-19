/**
 * getAttributionByChannel — analytics use-case (ADR-002 sole-read-path).
 *
 * Thin wrapper around computeAttributionReconciliationRate (metric engine) — the per-channel
 * attributed-revenue contributions + the unattributed residual + the reconciliation rate for
 * a model + window. The engine is the SOLE computation layer; NO ad-hoc SUM here (D-3). Reads
 * via the named ledger seams (channel_contribution_as_of / attributed_gmv_as_of / realized_gmv_as_of).
 *
 * The residual is ALWAYS returned (METRICS.md §Rules — never hidden). Serializes bigint→string (D-1).
 * Honest no_data when the brand has zero realized revenue in the window.
 *
 * I-ST01: the metric-engine is the SOLE ledger reader; the UI reaches it only through BFF → this
 * use-case → the seams. brandId is from session (D-1; NEVER body).
 */

import type { EngineDeps, AttributionModelId } from '@brain/metric-engine';
import { computeAttributionReconciliationRate } from '@brain/metric-engine';
import { hasAttributionCredit } from './_attribution-credit.js';

export interface ChannelContributionDto {
  channel: string;
  currency_code: string;
  contribution_minor: string; // bigint → string (D-1)
}

export type AttributionByChannelResult =
  | { state: 'no_data'; from: string; to: string; model: AttributionModelId }
  | { state: 'not_computed'; from: string; to: string; model: AttributionModelId }
  | {
      state: 'has_data';
      from: string;
      to: string;
      model: AttributionModelId;
      currency_code: string | null;
      attributed_gmv_minor: string;
      realized_gmv_minor: string;
      unattributed_minor: string;
      reconciliation_rate_pct: string | null;
      by_channel: ChannelContributionDto[];
      data_source: 'synthetic' | 'live';
    };

export interface AttributionByChannelParams {
  model: AttributionModelId;
  fromDate: Date;
  toDate: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getAttributionByChannel(
  brandId: string,
  params: AttributionByChannelParams,
  deps: EngineDeps,
): Promise<AttributionByChannelResult> {
  const result = await computeAttributionReconciliationRate(
    brandId,
    { model: params.model, fromDate: params.fromDate, toDate: params.toDate },
    deps,
  );

  if (!result.hasData) {
    return { state: 'no_data', from: params.fromStr, to: params.toStr, model: params.model };
  }

  // Honest-not-computed (R-10): realized revenue exists but the credit ledger is empty, so the
  // attribution numbers would be 0%/100%-unattributed — a lie dressed as data. Say so instead.
  if (!(await hasAttributionCredit(brandId, deps))) {
    return { state: 'not_computed', from: params.fromStr, to: params.toStr, model: params.model };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    model: params.model,
    currency_code: result.currencyCode,
    attributed_gmv_minor: String(result.attributedGmvMinor),
    realized_gmv_minor: String(result.realizedGmvMinor),
    unattributed_minor: String(result.unattributedMinor),
    reconciliation_rate_pct: result.reconciliationRatePct,
    by_channel: result.byChannel.map((c) => ({
      channel: c.channel,
      currency_code: c.currencyCode,
      contribution_minor: String(c.contributionMinor),
    })),
    data_source: params.dataSource,
  };
}
