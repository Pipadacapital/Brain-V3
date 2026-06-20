/**
 * @brain/metric-engine — attribution clawback (saved-weight reversal, Tier-0, PURE).
 *
 * On an RTO / refund / chargeback / cancellation / concession against an order, the
 * attribution ledger appends MIRRORED NEGATIVE rows — one per ORIGINAL credit row of
 * that order — using the SAVED `weight_fraction` read back from the ledger. Credit is
 * NEVER re-apportioned: the journey may have changed since the credit was written, but
 * the clawback must reverse exactly what was credited.
 *
 * ── THE MATH (05-architecture.md §3) ──────────────────────────────────────────
 *   clawback_minor_i = −round_largest_remainder(saved_weight_i × reversal_basis_minor)
 *   where reversal_basis_minor is the (negative) realized delta.
 *     • FULL RTO:      basis = −(original realized_revenue_minor) → each clawback row
 *                      exactly negates its credit row → Σ(credit+clawback)=0 (closed-sum=0).
 *     • PARTIAL refund: basis = the partial negative delta → clawback proportional to the
 *                      SAVED weights (NOT a fresh re-apportionment) — fixture-asserted.
 *   Apportionment over the SAVED weight units, sign-preserving (basis is negative).
 *
 * ── IDEMPOTENT, APPEND-ONLY ───────────────────────────────────────────────────
 *   clawback credit_id = sha256(brand‖order‖anon‖touch_seq‖model‖'clawback'‖reversal_event_id)
 *   — keyed on the SOURCE reversal's ledger_event_id so a distinct refund event yields a
 *   distinct clawback, but a REPLAY of the same reversal yields the SAME id → ON CONFLICT
 *   DO NOTHING (no double-clawback). The original credit row is NEVER mutated.
 *   reversed_of_credit_id = the original credit row's id; confidence carried VERBATIM.
 *
 * PURE: reads the saved rows as input, returns the clawback rows; the ledger read +
 * append are the core writer use-case's job.
 *
 * @see 05-architecture.md §3
 * @see METRICS.md row `attribution_credit` (clawback invariant)
 */

import { createHash } from 'node:crypto';
import { apportionMinor, WEIGHT_SCALE } from './attribution-models.js';
import {
  ATTRIBUTION_MODEL_VERSION,
  type AttributionCreditRow,
} from './attribution-credit.js';

/** The reversal reasons that drive a clawback (mirror the ledger CHECK). */
export type ReversalReason =
  | 'rto_reversal'
  | 'refund'
  | 'chargeback'
  | 'cancellation'
  | 'concession';

/** A SAVED credit row read back from the ledger (the only basis for a clawback). */
export interface SavedCreditRow {
  creditId: string;
  brandId: string;
  orderId: string;
  brainAnonId: string;
  touchSeq: number;
  channel: string;
  campaignId: string | null;
  modelId: AttributionCreditRow['modelId'];
  /** The SAVED weight_fraction string 'D.DDDDDDDD' — carried verbatim onto the clawback. */
  weightFraction: string;
  /** The original signed credited revenue (positive on a credit). */
  creditedRevenueMinor: bigint;
  currencyCode: string;
  realizedRevenueMinor: bigint;
  confidenceGrade: AttributionCreditRow['confidenceGrade'];
  attributionConfidence: string;
}

export interface ClawbackInput {
  /** The SAVED credit rows for ONE order+model (the rows being reversed). */
  savedCredits: readonly SavedCreditRow[];
  /** The source reversal's deterministic ledger_event_id (idempotency key). */
  reversalLedgerEventId: string;
  reversalReason: ReversalReason;
  /**
   * The reversal basis in signed minor units. NEGATIVE. For a full RTO this is
   * −(original realized_revenue_minor); for a partial refund the partial negative delta.
   */
  reversalBasisMinor: bigint;
  /** Reversal event-time. */
  occurredAt: Date;
  economicEffectiveAt: Date;
  /** 'YYYY-MM' — the reversal posts to the CURRENT open period (dual-date). */
  billingPostedPeriod: string;
  metricSnapshotId?: string | null;
}

/**
 * parseWeightFraction — exact 'D.DDDDDDDD' → scaled-integer weight units (1e8).
 * Pure integer parsing (no float). Pads/truncates the fractional part to 8 digits.
 */
export function parseWeightFraction(weightFraction: string): bigint {
  const [wholeRaw, fracRaw = ''] = weightFraction.split('.');
  const whole = BigInt(wholeRaw ?? '0');
  const frac8 = (fracRaw + '00000000').slice(0, 8);
  return whole * WEIGHT_SCALE + BigInt(frac8);
}

/**
 * computeClawbackCreditId — the deterministic clawback-row id.
 * Keyed on the source reversal's ledger_event_id → replay-suppression.
 */
export function computeClawbackCreditId(params: {
  brandId: string;
  orderId: string;
  brainAnonId: string;
  touchSeq: number;
  modelId: string;
  reversalLedgerEventId: string;
}): string {
  const { brandId, orderId, brainAnonId, touchSeq, modelId, reversalLedgerEventId } = params;
  return createHash('sha256')
    .update(
      `${brandId}\0${orderId}\0${brainAnonId}\0${touchSeq}\0${modelId}\0clawback\0${reversalLedgerEventId}`,
    )
    .digest('hex');
}

/**
 * computeAttributionClawback — mirrored negative rows for ONE order+model reversal.
 *
 * PURE. Apportions `reversalBasisMinor` over the SAVED weight units (NOT a fresh
 * re-apportionment) so:
 *   • full RTO (basis = −realized) → each clawback exactly negates its credit (Σ=0).
 *   • partial refund (basis = partial −delta) → proportional to the saved weights.
 *
 * The clawback rows carry: row_kind='clawback', the SAVED weight_fraction verbatim,
 * reversed_of_credit_id = the original credit's id, the SAVED confidence grade, and a
 * deterministic clawback id keyed on the reversal event (idempotent replay).
 *
 * Returns [] when there are no saved credits (an unattributed order has nothing to claw back).
 */
/**
 * clampReversalBasis — cap a reversal so the CUMULATIVE clawback for an order can NEVER exceed what was
 * credited (Σ|clawback| ≤ Σcredit), guarding against duplicate / over-sized reversals driving net
 * attributed revenue negative (audit R-11). Because the clawback re-uses the SAVED weights, clamping the
 * BASIS to the remaining magnitude also keeps every per-touch clawback ≤ its credit (per-touch
 * non-negativity). `reversalBasisMinor` is signed-NEGATIVE; `creditTotalMinor` (Σ credit) and
 * `alreadyClawedMinor` (|Σ| of clawbacks already applied) are POSITIVE magnitudes. Returns the
 * (negative) clamped basis, or 0n when nothing remains to claw back.
 */
export function clampReversalBasis(
  reversalBasisMinor: bigint,
  creditTotalMinor: bigint,
  alreadyClawedMinor: bigint,
): bigint {
  if (reversalBasisMinor >= 0n) return 0n; // not a reversal → nothing to claw back (defensive)
  const remaining = creditTotalMinor - alreadyClawedMinor;
  if (remaining <= 0n) return 0n; // the order is already fully reversed
  const requested = -reversalBasisMinor; // magnitude of this reversal
  const effective = requested < remaining ? requested : remaining; // min(requested, remaining)
  return -effective; // sign-preserving (negative)
}

export function computeAttributionClawback(input: ClawbackInput): AttributionCreditRow[] {
  const saved = [...input.savedCredits].sort((a, b) => a.touchSeq - b.touchSeq);
  if (saved.length === 0) return [];

  // Re-build the saved weight units from the persisted weight_fraction strings (exact).
  const weightUnits = saved.map((s) => parseWeightFraction(s.weightFraction));
  const wSum = weightUnits.reduce((a, b) => a + b, 0n);
  if (wSum !== WEIGHT_SCALE) {
    throw new Error(
      `[attribution-clawback] saved weights must sum to ${WEIGHT_SCALE}, got ${wSum} ` +
        `(order=${saved[0]?.orderId} model=${saved[0]?.modelId})`,
    );
  }

  // Apportion the (negative) basis over the SAVED weights — sign-preserving.
  const clawbackMinor = apportionMinor(weightUnits, input.reversalBasisMinor);

  return saved.map((s, i) => {
    const amount = clawbackMinor[i];
    if (amount === undefined) {
      throw new Error('[attribution-clawback] saved/clawback length mismatch (invariant)');
    }
    return {
      brandId: s.brandId,
      creditId: computeClawbackCreditId({
        brandId: s.brandId,
        orderId: s.orderId,
        brainAnonId: s.brainAnonId,
        touchSeq: s.touchSeq,
        modelId: s.modelId,
        reversalLedgerEventId: input.reversalLedgerEventId,
      }),
      orderId: s.orderId,
      brainAnonId: s.brainAnonId,
      touchSeq: s.touchSeq,
      channel: s.channel,
      campaignId: s.campaignId,
      modelId: s.modelId,
      rowKind: 'clawback' as const,
      weightFraction: s.weightFraction, // SAVED weight, verbatim — never re-derived
      creditedRevenueMinor: amount, // signed-negative
      currencyCode: s.currencyCode,
      reversedOfCreditId: s.creditId,
      reversalReason: input.reversalReason,
      realizedRevenueMinor: input.reversalBasisMinor,
      confidenceGrade: s.confidenceGrade,
      attributionConfidence: s.attributionConfidence,
      modelVersion: ATTRIBUTION_MODEL_VERSION,
      metricSnapshotId: input.metricSnapshotId ?? null,
      occurredAt: input.occurredAt,
      economicEffectiveAt: input.economicEffectiveAt,
      billingPostedPeriod: input.billingPostedPeriod,
    };
  });
}
