/**
 * @brain/metric-engine — attribution credit models (Tier-0 deterministic, PURE).
 *
 * The credit-weight policy for the attribution ledger. A pure function module
 * (NO I/O — the domain-policy analogue): given the ORDERED touch list for ONE
 * journey + the order's realized_revenue_minor, it returns the per-touch
 * `weight_fraction` (DECIMAL(9,8), summing EXACTLY to 1.0) and the per-touch
 * `credited_revenue_minor` (BIGINT, signed, summing EXACTLY to realized_revenue_minor).
 *
 * ── NO FLOAT EVER (I-S07 / I-E03/E04) ─────────────────────────────────────────
 * Weights are computed as integer HUNDRED-MILLIONTHS (scale 1e8, the exact
 * granularity of DECIMAL(9,8)). TOTAL = 100_000_000n. Every model's weights are
 * integer units that sum to TOTAL EXACTLY via largest-remainder rounding. The
 * `weight_fraction` string is rendered `D.DDDDDDDD` from those units. No IEEE
 * float touches a weight or a money value at any point.
 *
 * ── THE MODEL SET (brand-configurable; position_based default) ────────────────
 * For N touches in conversion order [t_1 … t_N]:
 *   • first_touch:     w_1 = 1, rest 0.
 *   • last_touch:      w_N = 1, rest 0.
 *   • linear:          each w_i = 1/N (largest-remainder distributes the rounding).
 *   • position_based:  N=1 → 1.0;  N=2 → 0.5/0.5;
 *                      N≥3 → first=last=0.40, middle 0.20 split evenly across the
 *                      N−2 middle touches (0.20/(N−2) each), remainder largest-rem'd.
 *
 * ── CLOSED-SUM APPORTIONMENT (the per-order leg of the parity oracle) ─────────
 * credited_revenue_minor is NOT round(weight×revenue) independently (that leaks
 * pennies). It is largest-remainder over minor units: raw_i = floor(w_i×rev/TOTAL),
 * residual R = rev − Σ raw_i handed one-each to the largest fractional parts
 * (deterministic tiebreak by touch_seq). Guarantees Σ credited = realized EXACTLY,
 * SIGN-PRESERVING (a negative reversal basis apportions with the same algorithm).
 *
 * @see 05-architecture.md §2 (credit model set) + §3 (clawback uses SAVED weights)
 * @see METRICS.md row `attribution_credit`
 */

/**
 * The model set. position_based is the brand default.
 *
 * 'data_driven' is the Markov removal-effect model (attribution-datadriven.ts). UNLIKE the other
 * four it is GLOBAL — per-channel weights are learned from the whole journey corpus, not a
 * closed-form of a single journey's touch count — so it is NOT in PER_JOURNEY_MODEL_IDS and is
 * written by a separate corpus-trained driver, never the per-order writeCredit loop. It is still a
 * first-class AttributionModelId for the ledger, serving (channel-roas) and the UI.
 */
export type AttributionModelId =
  | 'first_touch'
  | 'last_touch'
  | 'linear'
  | 'position_based'
  | 'data_driven';

/** The PER-JOURNEY closed-form models — the set reconcileAttribution's per-order loop computes. */
export const PER_JOURNEY_MODEL_IDS: readonly AttributionModelId[] = [
  'first_touch',
  'last_touch',
  'linear',
  'position_based',
] as const;

/**
 * Back-compat alias — the per-order reconcile loop iterates this. Kept as the per-journey set
 * (data_driven is global; adding it here would crash computeWeightUnits in the per-order path).
 */
export const ATTRIBUTION_MODEL_IDS: readonly AttributionModelId[] = PER_JOURNEY_MODEL_IDS;

/** Every model the system can serve/select (per-journey + the global data_driven). */
export const ALL_ATTRIBUTION_MODEL_IDS: readonly AttributionModelId[] = [
  ...PER_JOURNEY_MODEL_IDS,
  'data_driven',
] as const;

export const DEFAULT_ATTRIBUTION_MODEL: AttributionModelId = 'position_based';

/** Weight scale: 1e8 hundred-millionths == the exact granularity of DECIMAL(9,8). */
export const WEIGHT_SCALE = 100_000_000n;

/** Position-based endpoint weight (0.40) in scaled units. */
const POSITION_ENDPOINT = 40_000_000n;
/** Position-based total middle mass (0.20) in scaled units. */
const POSITION_MIDDLE_MASS = 20_000_000n;

/** A single touch's resolved credit (weight + apportioned money). */
export interface TouchCredit {
  /** The touch sequence (conversion order, 1-based as carried from Silver). */
  touchSeq: number;
  /** Weight units in 1e8 scale (Σ over touches = WEIGHT_SCALE exactly). */
  weightUnits: bigint;
  /** weight_fraction rendered as a DECIMAL(9,8) string 'D.DDDDDDDD'. */
  weightFraction: string;
  /** Apportioned credited revenue in signed minor units (Σ = realized exactly). */
  creditedRevenueMinor: bigint;
}

/** The minimal touch shape the models need (a projection of a Silver touch row). */
export interface AttributionTouch {
  /** Conversion-order sequence (as carried from silver.touchpoint touch_seq). */
  touchSeq: number;
}

/**
 * Render scaled weight units (1e8) as a DECIMAL(9,8) string 'D.DDDDDDDD'.
 * Pure integer formatting — no float. units must be in [0, 10^9) (i.e. ≤ 9.99999999).
 */
export function weightFractionString(units: bigint): string {
  if (units < 0n) {
    throw new Error(`[attribution-models] negative weight units: ${units}`);
  }
  const whole = units / WEIGHT_SCALE;
  const frac = units % WEIGHT_SCALE;
  return `${whole.toString()}.${frac.toString().padStart(8, '0')}`;
}

/**
 * computeWeightUnits — the raw integer weight (1e8 scale) per touch for a model.
 * Returns one bigint per touch (same order as input). Σ == WEIGHT_SCALE EXACTLY
 * (largest-remainder closes any integer-division residual). Empty input → [].
 */
export function computeWeightUnits(model: AttributionModelId, touchCount: number): bigint[] {
  const n = touchCount;
  if (n <= 0) return [];
  if (n === 1) return [WEIGHT_SCALE];

  let base: bigint[];
  switch (model) {
    case 'first_touch':
      base = Array.from({ length: n }, (_, i) => (i === 0 ? WEIGHT_SCALE : 0n));
      return base; // already sums to TOTAL exactly
    case 'last_touch':
      base = Array.from({ length: n }, (_, i) => (i === n - 1 ? WEIGHT_SCALE : 0n));
      return base;
    case 'linear':
      base = Array.from({ length: n }, () => WEIGHT_SCALE / BigInt(n));
      break;
    case 'position_based':
      if (n === 2) {
        base = [WEIGHT_SCALE / 2n, WEIGHT_SCALE / 2n]; // 0.5 / 0.5
      } else {
        // N≥3: first=last=0.40, middle 0.20 split evenly across N−2 middles.
        const middleCount = BigInt(n - 2);
        const perMiddle = POSITION_MIDDLE_MASS / middleCount;
        base = Array.from({ length: n }, (_, i) => {
          if (i === 0 || i === n - 1) return POSITION_ENDPOINT;
          return perMiddle;
        });
      }
      break;
    case 'data_driven':
      // GLOBAL model — per-touch weights come from the corpus-trained channel weights, not a
      // per-journey closed form. The data-driven driver supplies explicit per-touch weight units
      // (computeTouchCreditsExplicit); this per-journey-count path is never valid for it.
      throw new Error(
        '[attribution-models] data_driven is a GLOBAL model — use the data-driven driver ' +
          '(attribution-datadriven.ts) + computeTouchCreditsExplicit; it has no per-journey closed-form weight',
      );
    default: {
      const _exhaustive: never = model;
      throw new Error(`[attribution-models] unknown model: ${String(_exhaustive)}`);
    }
  }

  return distributeRemainder(base, WEIGHT_SCALE);
}

/**
 * normalizeWeightUnits — scale arbitrary NON-NEGATIVE raw weights to sum EXACTLY to WEIGHT_SCALE.
 *
 * raw_i ≥ 0; out_i = floor(raw_i × WEIGHT_SCALE / Σraw), residual handed one-each to the largest
 * fractional parts (deterministic tiebreak: index ascending). If Σraw == 0 (no signal) → UNIFORM
 * (WEIGHT_SCALE/n, remainder distributed). Σ out == WEIGHT_SCALE EXACTLY. Pure integer math.
 * Used by the data-driven model to turn global per-channel weights into per-touch weight units.
 */
export function normalizeWeightUnits(raw: readonly bigint[]): bigint[] {
  const n = raw.length;
  if (n === 0) return [];
  for (const r of raw) if (r < 0n) throw new Error(`[attribution-models] negative raw weight: ${r}`);

  const sum = raw.reduce((a, b) => a + b, 0n);
  if (sum === 0n) {
    // No signal → uniform across the touches.
    const base = Array.from({ length: n }, () => WEIGHT_SCALE / BigInt(n));
    return distributeRemainder(base, WEIGHT_SCALE);
  }

  const out: bigint[] = new Array(n).fill(0n);
  const remainder: bigint[] = new Array(n).fill(0n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const numer = (raw[i] as bigint) * WEIGHT_SCALE;
    out[i] = numer / sum; // floor (non-negative)
    remainder[i] = numer % sum;
    allocated += out[i]!;
  }
  let leftover = WEIGHT_SCALE - allocated; // ≥ 0, < n
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ra = remainder[a] as bigint;
    const rb = remainder[b] as bigint;
    if (ra > rb) return -1;
    if (ra < rb) return 1;
    return a - b;
  });
  let cursor = 0;
  while (leftover > 0n && cursor < order.length) {
    out[order[cursor] as number] = (out[order[cursor] as number] as bigint) + 1n;
    leftover -= 1n;
    cursor += 1;
  }
  return out;
}

/**
 * computeTouchCreditsExplicit — per-touch credit from EXPLICIT weight units (Σ must == WEIGHT_SCALE).
 *
 * The data-driven analogue of computeTouchCredits: the caller supplies the per-touch weight units
 * (derived from the corpus-trained channel weights), this apportions the revenue EXACTLY (closed-sum)
 * and renders the weight_fraction strings. Σ credited == realizedRevenueMinor EXACTLY.
 */
export function computeTouchCreditsExplicit(
  weightUnits: readonly bigint[],
  touches: readonly AttributionTouch[],
  realizedRevenueMinor: bigint,
): TouchCredit[] {
  if (touches.length === 0) return [];
  if (weightUnits.length !== touches.length) {
    throw new Error(
      `[attribution-models] weightUnits/touches length mismatch: ${weightUnits.length} vs ${touches.length}`,
    );
  }
  const credited = apportionMinor([...weightUnits], realizedRevenueMinor);
  return touches.map((t, i) => ({
    touchSeq: t.touchSeq,
    weightUnits: weightUnits[i] as bigint,
    weightFraction: weightFractionString(weightUnits[i] as bigint),
    creditedRevenueMinor: credited[i] as bigint,
  }));
}

/**
 * distributeRemainder — largest-remainder closure so Σ base == target EXACTLY.
 *
 * Given integer-floored `base` weights whose sum is ≤ target, hand the leftover
 * `target − Σ base` units one-each to the entries, in a DETERMINISTIC order:
 * endpoints first (index 0, then last), then middles by ascending index. This is
 * the same deterministic tiebreak the architecture §2 specifies (first, then last,
 * then middles by seq) so replays produce identical weights.
 */
function distributeRemainder(base: bigint[], target: bigint): bigint[] {
  const sum = base.reduce((a, b) => a + b, 0n);
  let remainder = target - sum;
  if (remainder === 0n) return base;
  if (remainder < 0n) {
    // Over-allocated (cannot happen for the integer-floored models above) — guard loudly.
    throw new Error(`[attribution-models] weight over-allocation: Σ=${sum} > target=${target}`);
  }

  const out = [...base];
  const n = out.length;
  // Deterministic order: 0 (first), n-1 (last), then 1..n-2 ascending.
  const order: number[] = [];
  order.push(0);
  if (n > 1) order.push(n - 1);
  for (let i = 1; i < n - 1; i++) order.push(i);

  let cursor = 0;
  while (remainder > 0n) {
    const idx = order[cursor % order.length] as number;
    out[idx] = (out[idx] as bigint) + 1n;
    remainder -= 1n;
    cursor += 1;
  }
  return out;
}

/**
 * apportionMinor — largest-remainder split of `totalMinor` across `weightUnits`.
 *
 * raw_i = floor(|w_i| × |total| / WEIGHT_SCALE); residual handed one-each to the
 * largest fractional parts (tiebreak: touch index ascending). SIGN-PRESERVING:
 * computed on magnitudes, the sign of `totalMinor` is re-applied at the end.
 * Guarantees Σ out == totalMinor EXACTLY (the per-order closed-sum leg).
 *
 * @param weightUnits - Per-touch weight units (1e8 scale); Σ MUST == WEIGHT_SCALE.
 * @param totalMinor  - The signed money to apportion (BIGINT minor units).
 */
export function apportionMinor(weightUnits: bigint[], totalMinor: bigint): bigint[] {
  const n = weightUnits.length;
  if (n === 0) return [];

  const wSum = weightUnits.reduce((a, b) => a + b, 0n);
  if (wSum !== WEIGHT_SCALE) {
    throw new Error(
      `[attribution-models] weight units must sum to ${WEIGHT_SCALE}, got ${wSum}`,
    );
  }

  const sign = totalMinor < 0n ? -1n : 1n;
  const mag = totalMinor < 0n ? -totalMinor : totalMinor;

  const raw: bigint[] = new Array(n).fill(0n);
  const remainder: bigint[] = new Array(n).fill(0n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const w = weightUnits[i] as bigint;
    const numer = w * mag;
    const q = numer / WEIGHT_SCALE; // floor (non-negative operands)
    raw[i] = q;
    remainder[i] = numer % WEIGHT_SCALE;
    allocated += q;
  }

  let leftover = mag - allocated; // ≥ 0, < n (at most one extra minor unit per touch)
  // Hand leftover one-each to the largest remainders; tiebreak by index ascending.
  const idxByRemainder = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ra = remainder[a] as bigint;
    const rb = remainder[b] as bigint;
    if (ra > rb) return -1;
    if (ra < rb) return 1;
    return a - b; // deterministic tiebreak
  });

  let cursor = 0;
  while (leftover > 0n && cursor < idxByRemainder.length) {
    const idx = idxByRemainder[cursor] as number;
    raw[idx] = (raw[idx] as bigint) + 1n;
    leftover -= 1n;
    cursor += 1;
  }
  // If leftover still > 0 (degenerate: all-zero weights but nonzero money — cannot
  // happen because Σw=WEIGHT_SCALE>0), it would be a bug; assert closed-sum below.

  const out = raw.map((q) => sign * q);
  const check = out.reduce((a, b) => a + b, 0n);
  if (check !== totalMinor) {
    throw new Error(
      `[attribution-models] apportionment closed-sum violation: Σ=${check} ≠ ${totalMinor}`,
    );
  }
  return out;
}

/**
 * computeTouchCredits — the full per-touch credit for one journey under a model.
 *
 * Combines computeWeightUnits + apportionMinor and renders weight_fraction strings.
 * The result preserves the input touch order and carries the touchSeq through.
 * Σ weightUnits == WEIGHT_SCALE and Σ creditedRevenueMinor == realizedRevenueMinor,
 * both EXACTLY (the per-order parity-oracle leg). Empty touch list → [] (no credit
 * rows; the order's revenue lands in the unattributed residual — honest, never
 * fabricated).
 *
 * @param model                - The attribution model.
 * @param touches              - Ordered touches (conversion order) for ONE journey.
 * @param realizedRevenueMinor - The order's realized revenue basis (signed BIGINT).
 */
export function computeTouchCredits(
  model: AttributionModelId,
  touches: readonly AttributionTouch[],
  realizedRevenueMinor: bigint,
): TouchCredit[] {
  if (touches.length === 0) return [];
  const weightUnits = computeWeightUnits(model, touches.length);
  const credited = apportionMinor(weightUnits, realizedRevenueMinor);

  return touches.map((t, i) => ({
    touchSeq: t.touchSeq,
    weightUnits: weightUnits[i] as bigint,
    weightFraction: weightFractionString(weightUnits[i] as bigint),
    creditedRevenueMinor: credited[i] as bigint,
  }));
}
