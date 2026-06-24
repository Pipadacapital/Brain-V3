/**
 * @brain/metric-engine — data-driven (Markov removal-effect) attribution (Tier-0).
 *
 * The 4 deterministic models (first/last/linear/position) weight a SINGLE journey by a closed form of
 * its touch count. The data-driven model is GLOBAL: it learns each channel's importance from the WHOLE
 * journey corpus (converting + non-converting) via the removal-effect of a first-order absorbing Markov
 * chain, then distributes each order's revenue across its journey's touches in proportion to those
 * learned channel weights.
 *
 * ── THE MODEL (Anderl/​Markov removal-effect) ─────────────────────────────────
 *   States: START, one per channel, CONVERSION + NULL (both absorbing).
 *   Each journey [c1..cn] contributes edges START→c1→…→cn→(CONVERSION | NULL).
 *   baseline P(conv)         = absorbed mass into CONVERSION from START.
 *   removal_effect(channel c) = (baseline − P(conv | c removed)) / baseline, clamped ≥ 0,
 *                               where "c removed" routes c to NULL (paths through c can't convert).
 *   channel weight           = removal_effect(c) / Σ removal_effect — the channel's data-driven share.
 *
 * ── FLOAT IS CONFINED TO THE WEIGHT VECTOR, NEVER MONEY ───────────────────────
 * The Markov solve (probabilities, removal effects) is float — unavoidable for a statistical model —
 * but its OUTPUT is QUANTIZED to integer 1e8 weight units (normalizeWeightUnits) and money is
 * apportioned with the exact-integer apportionMinor. So no float ever touches a money value (I-S07),
 * exactly like linear/position derive a rational then close with largest-remainder.
 *
 * ── DETERMINISTIC (replay-safe) ───────────────────────────────────────────────
 * Channels are sorted; the power-iteration order is fixed (maxIter + tolerance). Same corpus →
 * byte-identical weights → idempotent credit rows.
 *
 * @see attribution-models.ts (computeTouchCreditsExplicit, normalizeWeightUnits, WEIGHT_SCALE)
 */

import { WEIGHT_SCALE, weightFractionString } from './attribution-models.js';

/** One journey in the training corpus: ordered channels + whether it converted. */
export interface DataDrivenJourney {
  /** Channels in conversion order (e.g. ['paid_meta','referral']). Empty journeys are ignored. */
  channels: readonly string[];
  /** Did this journey convert (stitched to an order)? */
  converted: boolean;
}

export interface MarkovResult {
  /** Per-channel weight units (1e8 scale); Σ over channels == WEIGHT_SCALE EXACTLY. */
  channelWeightUnits: Map<string, bigint>;
  /** Baseline conversion probability from START, rendered D.DDDDDDDD (diagnostic). */
  baselineConversion: string;
  /** Per-channel removal effect (clamped ≥0, pre-normalization), rendered D.DDDDDDDD (diagnostic). */
  removalEffects: Map<string, string>;
  /** Distinct channels seen (sorted) — the model's channel space. */
  channels: string[];
}

const POWER_ITER_MAX = 1000;
const POWER_ITER_TOL = 1e-12;

/** Absorbed CONVERSION mass from START for a transition matrix (power iteration; deterministic). */
function conversionProbability(P: number[][], startIdx: number, convIdx: number, transient: number[]): number {
  const n = P.length;
  let v = new Array<number>(n).fill(0);
  v[startIdx] = 1;
  for (let iter = 0; iter < POWER_ITER_MAX; iter++) {
    const v2 = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const vi = v[i]!;
      if (vi === 0) continue;
      const row = P[i]!;
      for (let j = 0; j < n; j++) {
        const p = row[j]!;
        if (p !== 0) v2[j]! += vi * p;
      }
    }
    let transientMass = 0;
    for (const t of transient) transientMass += v2[t]!;
    v = v2;
    if (transientMass < POWER_ITER_TOL) break;
  }
  return v[convIdx]!;
}

/** Render a float fraction in [0, ~10) as a DECIMAL(9,8) string via the integer formatter. */
function fracString(x: number): string {
  const clamped = x < 0 ? 0 : x;
  const units = BigInt(Math.round(clamped * Number(WEIGHT_SCALE)));
  return weightFractionString(units > 9n * WEIGHT_SCALE ? 9n * WEIGHT_SCALE : units);
}

/**
 * computeMarkovChannelWeights — learn per-channel data-driven weights from the journey corpus.
 *
 * Returns channel weight UNITS (1e8) summing to WEIGHT_SCALE. Degenerate corpora are handled
 * honestly: no channels → empty; zero conversions (or all removal effects zero) → UNIFORM weights
 * across the channels seen (no signal to differentiate). Pure + deterministic.
 */
export function computeMarkovChannelWeights(journeys: readonly DataDrivenJourney[]): MarkovResult {
  // Distinct channels, sorted (deterministic state ordering).
  const channelSet = new Set<string>();
  for (const j of journeys) for (const c of j.channels) if (c) channelSet.add(c);
  const channels = [...channelSet].sort();
  const K = channels.length;
  if (K === 0) {
    return { channelWeightUnits: new Map(), baselineConversion: '0.00000000', removalEffects: new Map(), channels: [] };
  }

  // State indices: 0=START, 1..K=channels, K+1=CONV, K+2=NULL.
  const START = 0;
  const chIdx = new Map<string, number>();
  channels.forEach((c, i) => chIdx.set(c, i + 1));
  const CONV = K + 1;
  const NUL = K + 2;
  const nStates = K + 3;
  const transient = [START, ...channels.map((_, i) => i + 1)];

  // Transition counts.
  const counts: number[][] = Array.from({ length: nStates }, () => new Array<number>(nStates).fill(0));
  for (const j of journeys) {
    const chans = j.channels.filter((c) => c);
    if (chans.length === 0) continue;
    let prev = START;
    for (const c of chans) {
      const idx = chIdx.get(c)!;
      counts[prev]![idx]! += 1;
      prev = idx;
    }
    counts[prev]![j.converted ? CONV : NUL]! += 1;
  }

  // Base transition matrix P (row-stochastic). Absorbing CONV/NULL self-loop.
  const buildP = (): number[][] => {
    const P: number[][] = Array.from({ length: nStates }, () => new Array<number>(nStates).fill(0));
    for (const i of transient) {
      let rowSum = 0;
      for (let j = 0; j < nStates; j++) rowSum += counts[i]![j]!;
      if (rowSum === 0) {
        P[i]![NUL] = 1; // a dead transient → no conversion
      } else {
        for (let j = 0; j < nStates; j++) {
          const c = counts[i]![j]!;
          if (c !== 0) P[i]![j] = c / rowSum;
        }
      }
    }
    P[CONV]![CONV] = 1;
    P[NUL]![NUL] = 1;
    return P;
  };

  const P = buildP();
  const baseline = conversionProbability(P, START, CONV, transient);

  // Removal effect per channel: route the channel to NULL (removed) and recompute conversion.
  const removalEffects = new Map<string, string>();
  const rawRE: number[] = [];
  for (let ci = 0; ci < K; ci++) {
    const stateIdx = ci + 1;
    const Pc = P.map((row) => row.slice());
    for (let j = 0; j < nStates; j++) Pc[stateIdx]![j] = 0;
    Pc[stateIdx]![NUL] = 1; // channel removed → absorbing NULL (paths through it don't convert)
    const convC = conversionProbability(Pc, START, CONV, transient);
    const re = baseline > 0 ? Math.max(0, (baseline - convC) / baseline) : 0;
    rawRE.push(re);
    removalEffects.set(channels[ci]!, fracString(re));
  }

  // Normalize removal effects → channel weight units (Σ == WEIGHT_SCALE). Zero signal → uniform.
  // Scale RE to integers (preserve precision) then largest-remainder to WEIGHT_SCALE.
  const rawUnits = rawRE.map((re) => BigInt(Math.round(re * 1e12)));
  const weightUnits = normalizeToScale(rawUnits);
  const channelWeightUnits = new Map<string, bigint>();
  channels.forEach((c, i) => channelWeightUnits.set(c, weightUnits[i]!));

  return { channelWeightUnits, baselineConversion: fracString(baseline), removalEffects, channels };
}

/**
 * dataDrivenTouchWeightUnits — per-touch weight units for ONE journey from the global channel weights.
 *
 * Each touch's raw weight is the global weight of its channel; the journey's touches are then
 * renormalized to Σ == WEIGHT_SCALE (a channel appearing K times in the journey gets K shares). When
 * none of the journey's channels carry global weight, falls back to uniform (handled by the
 * normalizer). Feed the result to computeTouchCreditsExplicit for exact closed-sum money.
 */
export function dataDrivenTouchWeightUnits(
  touchChannels: readonly string[],
  channelWeightUnits: Map<string, bigint>,
): bigint[] {
  if (touchChannels.length === 0) return [];
  const raw = touchChannels.map((c) => channelWeightUnits.get(c) ?? 0n);
  return normalizeToScale(raw);
}

// Local copy of the WEIGHT_SCALE largest-remainder normalizer to keep this module self-contained for
// the corpus weights (the per-touch path reuses the exported normalizeWeightUnits via the same logic).
function normalizeToScale(raw: readonly bigint[]): bigint[] {
  const n = raw.length;
  if (n === 0) return [];
  let sum = 0n;
  for (const r of raw) sum += r < 0n ? 0n : r;
  if (sum === 0n) {
    const base = Array.from({ length: n }, () => WEIGHT_SCALE / BigInt(n));
    let rem = WEIGHT_SCALE - base.reduce((a, b) => a + b, 0n);
    for (let i = 0; rem > 0n; i = (i + 1) % n, rem -= 1n) base[i]! += 1n;
    return base;
  }
  const out = new Array<bigint>(n).fill(0n);
  const remainder = new Array<bigint>(n).fill(0n);
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const r = raw[i]! < 0n ? 0n : raw[i]!;
    const numer = r * WEIGHT_SCALE;
    out[i] = numer / sum;
    remainder[i] = numer % sum;
    allocated += out[i]!;
  }
  let leftover = WEIGHT_SCALE - allocated;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ra = remainder[a]!;
    const rb = remainder[b]!;
    if (ra > rb) return -1;
    if (ra < rb) return 1;
    return a - b;
  });
  for (let k = 0; leftover > 0n && k < order.length; k++, leftover -= 1n) out[order[k]!] = out[order[k]!]! + 1n;
  return out;
}
