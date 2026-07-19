/**
 * getCodRto — analytics use-case (ADR-002 sole-read-path) for the DR-006 COD/RTO outcome funnel.
 *
 * Per-currency COD/RTO outcomes over the Gold mart gold_cod_rto, via computeCodRto (metric
 * engine) through the withSilverBrand seam (I-ST01 — the engine is the sole Gold reader; the
 * UI never queries the lakehouse directly). Returns, per currency, the COD order count +
 * at-risk COD cash, predicted-RTO count, delivered vs RTO outcomes, and the checkout-
 * prediction accuracy. NO ad-hoc arithmetic (D-3); the mart computes the integer-bps rates.
 *
 * Money: cod_amount_minor is a bigint-serialized minor-unit string (I-S07), paired with its
 * currency_code on-row. Rates stay integer BASIS POINTS; NULL bps pass through as null —
 * honest insufficient-data (unresolved shipments / unevaluated predictions), never a fake 0.
 *
 * Serializes bigint → string (D-1) and returns generated_at (honest server compute time) so
 * the FreshnessBadge shows a real served-at. brandId from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/cod-rto.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeCodRto } from '@brain/metric-engine';

export interface CodRtoCurrencyDto {
  currency_code: string;
  cod_orders: string; // bigint → string
  cod_amount_minor: string; // bigint → string (minor units — at-risk COD cash)
  predicted_rto: string; // bigint → string
  actual_delivered: string; // bigint → string
  actual_rto: string; // bigint → string
  resolved: string; // bigint → string (delivered + RTO — the rate base)
  rto_rate_bps: number | null; // integer basis points; null when resolved = 0
  prediction_correct: string; // bigint → string
  prediction_evaluated: string; // bigint → string
  prediction_accuracy_bps: number | null; // integer basis points; null when unevaluated
  updated_at: string | null; // mart refresh timestamp (as served)
}

export type CodRtoResult =
  | { state: 'no_data'; generated_at: string }
  | {
      state: 'has_data';
      by_currency: CodRtoCurrencyDto[];
      generated_at: string;
    };

/**
 * getCodRto — a brand's per-currency COD/RTO outcome funnel + prediction accuracy.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (mv_gold_cod_rto).
 */
export async function getCodRto(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CodRtoResult> {
  // served_at: honest server compute time for this read (the FreshnessBadge shows a real relative time).
  const generatedAt = new Date().toISOString();
  const result = await computeCodRto(brandId, deps);

  if (!result.hasData) {
    return { state: 'no_data', generated_at: generatedAt };
  }

  return {
    state: 'has_data',
    generated_at: generatedAt,
    by_currency: result.byCurrency.map((c) => ({
      currency_code: c.currencyCode,
      cod_orders: String(c.codOrders),
      cod_amount_minor: String(c.codAmountMinor),
      predicted_rto: String(c.predictedRto),
      actual_delivered: String(c.actualDelivered),
      actual_rto: String(c.actualRto),
      resolved: String(c.resolved),
      rto_rate_bps: c.rtoRateBps,
      prediction_correct: String(c.predictionCorrect),
      prediction_evaluated: String(c.predictionEvaluated),
      prediction_accuracy_bps: c.predictionAccuracyBps,
      updated_at: c.updatedAt,
    })),
  };
}
