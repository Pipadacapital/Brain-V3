/**
 * ProbabilisticMatcher — the RULE-BASED, REVIEW-GATED probabilistic record linkage matcher (PROB).
 *
 * A conservative Fellegi–Sunter-style matcher over the WEAK signals only
 * (device_fingerprint / cookie_id / session_id / ip). It computes a weighted PARTIAL-agreement
 * score from per-signal weights (+ a co-occurrence bonus when ≥2 distinct weak signals agree) and
 * emits an INTEGER confidence in [0, MAX] whose band is STRICTLY SUB-EXACT (high|medium|low|none) —
 * NEVER 'exact', NEVER 100. By construction it can never reach a merge-eligible band.
 *
 * SAFETY (the non-negotiable invariants):
 *   - WEAK-ONLY: it reads ONLY weak-signal identifier types. It NEVER inspects a strong/medium key,
 *     so it can never become a merge key and the deterministic union-find is unaffected by it.
 *   - SUB-EXACT BY CONSTRUCTION: the score is hard-capped at MAX_PROBABILISTIC_SCORE (< 100) and the
 *     band function only ever returns high|medium|low|none. A probabilistic verdict therefore can
 *     NEVER be band 'exact' / merge-eligible → the ConfidenceEngine ROUTES IT TO REVIEW, never merges.
 *   - DETERMINISTIC-FIRST (D-5): the engine consults this matcher ONLY when the deterministic path
 *     finds no strong key. This matcher itself is pure + order-independent.
 *   - INTEGER 0–100 (never money), HASH-ONLY (I-S02), brand_id-first tenant isolation.
 *
 * Pure domain: imports only @brain/contracts types. No IO, no graph access — the candidate
 * graph read-state is passed in via MatcherInput (already brand-scoped, hash-only).
 */
import type {
  Matcher,
  MatcherInput,
  ConfidenceVerdict,
  ConfidenceBand,
  IdentifierComboMember,
  IdentifierType,
} from '@brain/contracts';

/** The matcher id (mirrors IDENTITY_MATCHER_REGISTRY's 'probabilistic-fellegi-sunter' descriptor). */
export const PROBABILISTIC_MATCHER_ID = 'probabilistic-fellegi-sunter';

/** The rule version this matcher stamps on its verdicts (mirrors the descriptor `version`). */
export const PROBABILISTIC_RULE_VERSION = 'v1-fellegi-sunter';

/**
 * The WEAK signal types this matcher links on — and ONLY these. A strong/medium identifier is
 * never inspected here, so a probabilistic match can never act as (or escalate to) a merge key.
 */
export const WEAK_SIGNAL_TYPES = [
  'device_fingerprint',
  'cookie_id',
  'session_id',
  'ip',
] as const satisfies readonly IdentifierType[];

type WeakSignalType = (typeof WEAK_SIGNAL_TYPES)[number];
const WEAK_SET = new Set<string>(WEAK_SIGNAL_TYPES);

/**
 * Per-signal Fellegi–Sunter agreement weights + the co-occurrence bonus. Configurable per
 * deployment (constructor arg). Defaults are CONSERVATIVE and ordered by signal reliability:
 *   device_fingerprint > cookie_id > session_id > ip   (an IP is widely shared → lowest weight).
 *
 * The score is the sum of the weights of the DISTINCT weak signals that exactly agree (hash match),
 * plus `coOccurrenceBonus` when ≥2 distinct signals agree, hard-capped at MAX_PROBABILISTIC_SCORE.
 */
export interface ProbabilisticWeights {
  device_fingerprint: number;
  cookie_id: number;
  session_id: number;
  ip: number;
  /** Added once when ≥2 distinct weak signals agree (independent corroboration). */
  coOccurrenceBonus: number;
}

export const DEFAULT_PROBABILISTIC_WEIGHTS: ProbabilisticWeights = {
  device_fingerprint: 45,
  cookie_id: 35,
  session_id: 30,
  ip: 15,
  coOccurrenceBonus: 15,
};

/**
 * HARD sub-exact cap. The probabilistic score can NEVER reach 100 / band 'exact'; even a fully
 * agreeing, co-occurring signal set is clamped here. This is the structural never-auto-merge floor.
 */
export const MAX_PROBABILISTIC_SCORE = 95;

/** Sub-exact band thresholds over the integer score. NEVER returns 'exact' (that is deterministic-only). */
const SUB_EXACT_BANDS = { high: 80, medium: 45, low: 1 } as const;

function subExactBand(score: number): ConfidenceBand {
  if (score >= SUB_EXACT_BANDS.high) return 'high';
  if (score >= SUB_EXACT_BANDS.medium) return 'medium';
  if (score >= SUB_EXACT_BANDS.low) return 'low';
  return 'none';
}

/** The hash-only composite key used for exact weak-signal agreement (I-S02). */
function keyOf(id: { identifier_type: string; identifier_hash: string }): string {
  return `${id.identifier_type}:${id.identifier_hash}`;
}

export class ProbabilisticMatcher implements Matcher {
  readonly id = PROBABILISTIC_MATCHER_ID;
  readonly version = PROBABILISTIC_RULE_VERSION;
  readonly status = 'enabled' as const;

  private readonly weights: ProbabilisticWeights;

  /** @param weights per-signal FS weights (+ co-occurrence bonus). Defaults to the conservative set. */
  constructor(weights: Partial<ProbabilisticWeights> = {}) {
    this.weights = { ...DEFAULT_PROBABILISTIC_WEIGHTS, ...weights };
  }

  /**
   * Rule-based partial-agreement match over the WEAK signals.
   *
   * @returns a SUB-EXACT verdict (band high|medium|low) when ≥1 weak signal exactly agrees with a
   *          candidate; otherwise score 0 / band 'none'. The score is hard-capped below 'exact', so
   *          the verdict is NEVER merge-eligible — a positive match must be ROUTED TO REVIEW.
   */
  match(input: MatcherInput): ConfidenceVerdict {
    const { brand_id, identifiers, candidates = [] } = input;

    // ── Tenant isolation (brand_id-first) + WEAK-ONLY projection. Strong/medium keys are never read. ──
    const eventWeak = identifiers.filter((i) => i.brand_id === brand_id && WEAK_SET.has(i.identifier_type));
    const candidateWeakKeys = new Set(
      candidates.filter((c) => c.brand_id === brand_id && WEAK_SET.has(c.identifier_type)).map(keyOf),
    );

    // Exact hash agreement on a weak signal (partial agreement across the available weak fields).
    const agreements = eventWeak.filter((i) => candidateWeakKeys.has(keyOf(i)));

    if (agreements.length === 0) {
      return this.verdict(0, ['no_weak_signal_agreement'], []);
    }

    // Distinct agreeing weak-signal types → sum of their FS weights (one weight per type).
    const distinctTypes = [...new Set(agreements.map((a) => a.identifier_type as WeakSignalType))].sort();
    const reasons: string[] = [];
    let raw = 0;
    for (const t of distinctTypes) {
      raw += this.weights[t];
      reasons.push(`weak_agree:${t}`);
    }
    // Co-occurrence: independent corroboration from ≥2 distinct weak signals.
    if (distinctTypes.length >= 2) {
      raw += this.weights.coOccurrenceBonus;
      reasons.push(`co_occurrence:${distinctTypes.length}`);
    }

    // HARD sub-exact cap — can never reach 100 / band 'exact' / merge-eligible.
    const score = Math.min(Math.max(0, Math.round(raw)), MAX_PROBABILISTIC_SCORE);
    reasons.push('probabilistic:rule_based_fellegi_sunter');
    // Make the never-auto-merge contract explicit in the audit trail.
    reasons.push('never_merge:route_to_review');

    // Hash-only combo (deduped on type+hash, ORDER-INDEPENDENT) — the exact weak signals that
    // produced the score. Sorted on the composite key so shuffling the input yields an identical verdict.
    const seen = new Set<string>();
    const combo: IdentifierComboMember[] = [];
    for (const a of [...agreements].sort((x, y) => keyOf(x).localeCompare(keyOf(y)))) {
      const k = keyOf(a);
      if (seen.has(k)) continue;
      seen.add(k);
      combo.push({ identifier_type: a.identifier_type, identifier_hash: a.identifier_hash });
    }

    return this.verdict(score, reasons, combo);
  }

  /** Assemble a verdict, asserting the SUB-EXACT band invariant (never 'exact'). */
  private verdict(score: number, reasons: string[], combo: IdentifierComboMember[]): ConfidenceVerdict {
    const band = subExactBand(score);
    // Defense-in-depth: the band function never returns 'exact', but assert it so a future edit can't regress.
    if ((band as string) === 'exact') {
      throw new Error('[ProbabilisticMatcher] invariant breach: a probabilistic verdict may never be band "exact"');
    }
    return {
      score,
      band,
      reasons,
      matcher_id: this.id,
      rule_version: this.version,
      identifier_combo: combo,
    };
  }
}
