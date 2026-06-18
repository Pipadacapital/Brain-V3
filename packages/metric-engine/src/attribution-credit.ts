/**
 * @brain/metric-engine — attribution credit writer (Tier-0 deterministic, PURE compute).
 *
 * Given the ORDERED touches for ONE journey (from silver.touchpoint via withSilverBrand)
 * and the order's realized_revenue basis, this computes the CREDIT rows to append to
 * attribution_credit_ledger. PURE: it does the math + deterministic IDs + confidence
 * stamping and returns rows; the I/O (the append) is the core writer use-case
 * (apps/core/.../attribution/internal/credit-writer.ts) — domain math stays out of I/O.
 *
 * ── DETERMINISTIC, NO FLOAT ───────────────────────────────────────────────────
 *   • weights + apportionment from attribution-models.ts (scaled-integer; Σw=1.0,
 *     Σ credited = realized exactly).
 *   • credit_id = sha256(brand‖order‖anon‖touch_seq‖model‖'credit'‖version) — replay
 *     of the same credit produces the SAME id → ON CONFLICT DO NOTHING (idempotent).
 *   • confidence grade stamped per row (carried verbatim onto clawback later).
 *
 * @see 05-architecture.md §2 (models) + §4 (confidence)
 * @see METRICS.md row `attribution_credit`
 */

import { createHash } from 'node:crypto';
import {
  computeTouchCredits,
  type AttributionModelId,
} from './attribution-models.js';
import {
  gradeJourneyConfidence,
  isDeterministicChannel,
  type AttributionConfidenceResult,
} from './attribution-confidence.js';

/** Credit-ledger row-kind discriminator. */
export type AttributionRowKind = 'credit' | 'clawback';

/** The model_version provenance carried on every row (metric_version). */
export const ATTRIBUTION_MODEL_VERSION = 'v1';

/** A touch as projected from silver.touchpoint for crediting. */
export interface CreditTouch {
  touchSeq: number;
  channel: string;
  campaignId: string | null;
  utmMedium: string | null;
  fbclid: string | null;
  gclid: string | null;
  ttclid: string | null;
}

/** The journey + order basis the credit computation needs. */
export interface CreditInput {
  brandId: string;
  orderId: string;
  brainAnonId: string;
  model: AttributionModelId;
  /** Whether the journey deterministically stitched to the order (confidence floor). */
  stitched: boolean;
  /** The order's realized revenue basis (signed BIGINT minor units). */
  realizedRevenueMinor: bigint;
  currencyCode: string;
  /** Ordered touches (conversion order). Empty → no credit rows (honest unattributed). */
  touches: readonly CreditTouch[];
  /** Conversion/credit event-time. */
  occurredAt: Date;
  /** Economic-effective time (drives the as-of read). */
  economicEffectiveAt: Date;
  /** 'YYYY-MM' open billing period for this credit. */
  billingPostedPeriod: string;
  /** Optional metric snapshot provenance. */
  metricSnapshotId?: string | null;
}

/** A fully-resolved credit row ready to append (all money signed BIGINT). */
export interface AttributionCreditRow {
  brandId: string;
  creditId: string;
  orderId: string;
  brainAnonId: string;
  touchSeq: number;
  channel: string;
  campaignId: string | null;
  modelId: AttributionModelId;
  rowKind: AttributionRowKind;
  weightFraction: string;
  creditedRevenueMinor: bigint;
  currencyCode: string;
  reversedOfCreditId: string | null;
  reversalReason: string | null;
  realizedRevenueMinor: bigint;
  confidenceGrade: AttributionConfidenceResult['grade'];
  attributionConfidence: string;
  modelVersion: string;
  metricSnapshotId: string | null;
  occurredAt: Date;
  economicEffectiveAt: Date;
  billingPostedPeriod: string;
}

/**
 * computeCreditId — the deterministic credit-row id for a CREDIT row.
 * sha256(brand‖order‖anon‖touch_seq‖model‖'credit'‖version). Replay → same id.
 */
export function computeCreditId(params: {
  brandId: string;
  orderId: string;
  brainAnonId: string;
  touchSeq: number;
  modelId: string;
}): string {
  const { brandId, orderId, brainAnonId, touchSeq, modelId } = params;
  return createHash('sha256')
    .update(
      `${brandId}\0${orderId}\0${brainAnonId}\0${touchSeq}\0${modelId}\0credit\0${ATTRIBUTION_MODEL_VERSION}`,
    )
    .digest('hex');
}

/**
 * computeAttributionCredit — the per-touch CREDIT rows for one journey under a model.
 *
 * PURE. Returns [] when the journey has zero touches (the order's realized revenue
 * lands entirely in the unattributed residual — never fabricate a touch). The
 * confidence grade is computed ONCE for the journey (the floor over its credited
 * touches' channel quality) and stamped on every row.
 *
 * Σ creditedRevenueMinor over the returned rows == realizedRevenueMinor EXACTLY
 * (the per-order leg of the parity oracle), guaranteed by computeTouchCredits.
 */
export function computeAttributionCredit(input: CreditInput): AttributionCreditRow[] {
  if (input.touches.length === 0) return [];

  const credits = computeTouchCredits(input.model, input.touches, input.realizedRevenueMinor);

  // Confidence floor over the CREDITED touches' channel determinism.
  const confidence = gradeJourneyConfidence(
    input.stitched,
    input.touches.map((t) => ({ isDeterministicChannel: isDeterministicChannel(t) })),
  );

  return input.touches.map((t, i) => {
    const c = credits[i];
    if (c === undefined) {
      throw new Error('[attribution-credit] touch/credit length mismatch (invariant)');
    }
    return {
      brandId: input.brandId,
      creditId: computeCreditId({
        brandId: input.brandId,
        orderId: input.orderId,
        brainAnonId: input.brainAnonId,
        touchSeq: t.touchSeq,
        modelId: input.model,
      }),
      orderId: input.orderId,
      brainAnonId: input.brainAnonId,
      touchSeq: t.touchSeq,
      channel: t.channel,
      campaignId: t.campaignId,
      modelId: input.model,
      rowKind: 'credit' as const,
      weightFraction: c.weightFraction,
      creditedRevenueMinor: c.creditedRevenueMinor,
      currencyCode: input.currencyCode,
      reversedOfCreditId: null,
      reversalReason: null,
      realizedRevenueMinor: input.realizedRevenueMinor,
      confidenceGrade: confidence.grade,
      attributionConfidence: confidence.confidence,
      modelVersion: ATTRIBUTION_MODEL_VERSION,
      metricSnapshotId: input.metricSnapshotId ?? null,
      occurredAt: input.occurredAt,
      economicEffectiveAt: input.economicEffectiveAt,
      billingPostedPeriod: input.billingPostedPeriod,
    };
  });
}
