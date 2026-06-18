/**
 * getAttributionReconciliation — analytics use-case (ADR-002 sole-read-path).
 *
 * The headline reconciliation surface: attribution_reconciliation_rate +
 * the unattributed residual for a model + window, from computeAttributionReconciliationRate
 * (metric engine). NO ad-hoc arithmetic here (D-3). The residual is ALWAYS returned
 * (METRICS.md §Rules — never hidden, never silently spread). Serializes bigint→string (D-1).
 *
 * This is the slimmer sibling of getAttributionByChannel (which carries the per-channel
 * breakdown); this one is the rate + residual card. brandId from session (D-1; NEVER body).
 */

import type { EngineDeps, AttributionModelId } from '@brain/metric-engine';
import { computeAttributionReconciliationRate } from '@brain/metric-engine';

export type AttributionReconciliationResultDto =
  | { state: 'no_data'; from: string; to: string; model: AttributionModelId }
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
      data_source: 'synthetic' | 'live';
    };

export interface AttributionReconciliationParams {
  model: AttributionModelId;
  fromDate: Date;
  toDate: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getAttributionReconciliation(
  brandId: string,
  params: AttributionReconciliationParams,
  deps: EngineDeps,
): Promise<AttributionReconciliationResultDto> {
  const result = await computeAttributionReconciliationRate(
    brandId,
    { model: params.model, fromDate: params.fromDate, toDate: params.toDate },
    deps,
  );

  if (!result.hasData) {
    return { state: 'no_data', from: params.fromStr, to: params.toStr, model: params.model };
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
    data_source: params.dataSource,
  };
}
