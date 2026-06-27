/**
 * ConfidenceEngine — a PURE domain service that aggregates ENABLED-matcher evidence (+ deterministic
 * strategy hooks) into a versioned `ConfidenceVerdict` (@brain/contracts).
 *
 * It does NOT re-implement matching — it AGGREGATES the existing enabled matcher
 * (`DeterministicUnionFindMatcher`, which wraps `IdentityResolver`) and the deterministic strategy
 * hooks (merge / split / cross-device), then re-bands the resulting integer score against
 * PER-TENANT band boundaries. Layering, deterministic-first (D-5):
 *
 *   • LIVE deterministic path (the only live matcher):
 *       - exact STRONG-identifier hash overlap → score 100, band 'exact'  → MERGE-eligible.
 *       - ≥2 distinct strong brain_ids         → merge hook fires (canonical = lowest UUID).
 *       - MEDIUM-tier (device/anon) resolves to a SINGLE known brain_id → cross-device adoption:
 *         a sub-100 score whose band is NEVER 'exact' → RESOLVE-ONLY, NEVER triggers a merge.
 *       - no match → score 0, band 'none' → mint a fresh identity.
 *   • DISABLED matchers/hooks (probabilistic / ML / household / probabilistic-cross-device) are
 *     registered-DISABLED: the engine NEVER invokes them (it filters to `status === 'enabled'`);
 *     invoking one throws `NotImplementedYet`. No score is ever faked.
 *
 * INVARIANTS (CI-relevant):
 *   - CONFIDENCE IS AN INTEGER 0–100 — never money, never blended with `MinorUnits`.
 *   - HASH-ONLY (I-S02): only identifier_type + 64-hex hash cross this seam; never raw email/phone.
 *   - TENANT (brand_id-first): every identifier is checked against the evidence brand_id; a
 *     cross-tenant identifier is a hard error (defense-in-depth; per-brand salting already isolates).
 *   - ORDER-INDEPENDENCE: brain_ids are sorted-distinct; canonical = lowest UUID — shuffling the
 *     match evidence yields a byte-identical verdict.
 *   - VERSIONED: every verdict carries `rule_version` (lock-step with IDENTITY_RULE_VERSION /
 *     IdentityResolver.RULE_VERSION) so the band boundaries + algorithm it was produced under are pinned.
 *   - NEVER-MERGE GUARANTEE for medium: a tenant cannot misconfigure the medium score above the exact
 *     boundary — it is clamped below it (a `config_guard` reason is recorded), so cross-device evidence
 *     can structurally never reach band 'exact'.
 *
 * Pure domain: imports only @brain/contracts + sibling domain (matcher / strategy hooks). No IO.
 */
import { ConfidenceVerdictSchema } from '@brain/contracts';
import type {
  ConfidenceVerdict,
  ConfidenceBand,
  Identifier,
  IdentifierComboMember,
  Matcher,
  MatcherInput,
} from '@brain/contracts';
import { DeterministicUnionFindMatcher } from '../matchers/DeterministicUnionFindMatcher.js';
import { RULE_VERSION } from '../IdentityResolver.js';
import {
  DeterministicMergeHook,
  DeterministicCrossDeviceHook,
  DeterministicSplitHook,
} from './strategyHooks.js';

// ── Per-tenant configuration ──────────────────────────────────────────────────

/**
 * Band boundaries over the integer score, in DESCENDING order. A score ≥ `exact` → 'exact';
 * ≥ `high` → 'high'; ≥ `medium` → 'medium'; ≥ `low` → 'low'; else 'none'. Per-tenant configurable.
 * Only band 'exact' is MERGE-eligible (see `isMergeEligible`).
 */
export interface ConfidenceBandThresholds {
  exact: number;
  high: number;
  medium: number;
  low: number;
}

/** Per-tenant confidence configuration. */
export interface TenantConfidenceConfig {
  bandThresholds: ConfidenceBandThresholds;
  /**
   * Score assigned to a deterministic cross-device (medium-tier) adoption. MUST be < `exact` so the
   * adoption can never reach band 'exact' (the never-merge guarantee). The engine CLAMPS it below
   * `exact` if a tenant misconfigures it higher.
   */
  mediumAdoptionScore: number;
}

/** A partial per-tenant override (band thresholds may be partially overridden). */
export interface TenantConfidenceOverride {
  bandThresholds?: Partial<ConfidenceBandThresholds>;
  mediumAdoptionScore?: number;
}

/** The conservative defaults. Medium adoption = 60 → band 'medium' (resolve-only, never 'exact'). */
export const DEFAULT_CONFIDENCE_CONFIG: TenantConfidenceConfig = {
  bandThresholds: { exact: 100, high: 80, medium: 50, low: 1 },
  mediumAdoptionScore: 60,
};

// ── Evidence input ──────────────────────────────────────────────────────────--

/** A single identifier→brain_id match drawn from the graph read-state (hash-only). */
export interface IdentifierMatch {
  identifier: Identifier;
  brain_id: string;
}

/**
 * The structural evidence the engine grades — brand-scoped, hash-only. `strongMatches` /
 * `mediumMatches` are the graph hits for the event's strong / medium identifiers (the caller
 * pre-fetches them so the engine stays pure/IO-free).
 */
export interface ConfidenceEvidence {
  brand_id: string;
  /** All identifiers extracted from the event (hash-only, tiered). */
  identifiers: readonly Identifier[];
  /** STRONG-tier identifiers that exactly matched an existing active link → which brain_id. */
  strongMatches: readonly IdentifierMatch[];
  /** MEDIUM-tier (device/anon) identifiers that matched an existing active link → which brain_id. */
  mediumMatches: readonly IdentifierMatch[];
  /** Set when the resolver flagged this for human review (cycle-guard / conflict) → caps below 'exact'. */
  routeToReview?: boolean;
  /** Audit reason for the review route. */
  routeReason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortedDistinct(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** The hash-only combo members (deduped on type+hash). Never raw PII (I-S02). */
function toCombo(identifiers: readonly Identifier[]): IdentifierComboMember[] {
  const seen = new Set<string>();
  const out: IdentifierComboMember[] = [];
  for (const id of identifiers) {
    const key = `${id.identifier_type}:${id.identifier_hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ identifier_type: id.identifier_type, identifier_hash: id.identifier_hash });
  }
  return out;
}

function bandFromScore(score: number, t: ConfidenceBandThresholds): ConfidenceBand {
  if (score >= t.exact) return 'exact';
  if (score >= t.high) return 'high';
  if (score >= t.medium) return 'medium';
  if (score >= t.low) return 'low';
  return 'none';
}

// ── The engine ─────────────────────────────────────────────────────────────---

export interface ConfidenceEngineOptions {
  /** Per-tenant defaults (falls back to DEFAULT_CONFIDENCE_CONFIG). */
  defaults?: TenantConfidenceConfig;
  /** Per-brand overrides (partial, deep-merged onto defaults). */
  perTenant?: ReadonlyMap<string, TenantConfidenceOverride>;
  /**
   * The matchers whose evidence is aggregated. Only `status === 'enabled'` matchers are ever
   * invoked; disabled matchers in this list are SKIPPED (never throw). Defaults to the single
   * enabled `DeterministicUnionFindMatcher`.
   */
  matchers?: readonly Matcher[];
}

export class ConfidenceEngine {
  /** Pinned in lock-step with IdentityResolver.RULE_VERSION — the version every verdict is stamped with. */
  readonly ruleVersion = RULE_VERSION;

  private readonly defaults: TenantConfidenceConfig;
  private readonly perTenant: ReadonlyMap<string, TenantConfidenceOverride>;
  private readonly matchers: readonly Matcher[];

  private readonly mergeHook = new DeterministicMergeHook();
  private readonly crossDeviceHook = new DeterministicCrossDeviceHook();
  private readonly splitHook = new DeterministicSplitHook();

  constructor(opts: ConfidenceEngineOptions = {}) {
    this.defaults = opts.defaults ?? DEFAULT_CONFIDENCE_CONFIG;
    this.perTenant = opts.perTenant ?? new Map();
    this.matchers = opts.matchers ?? [new DeterministicUnionFindMatcher()];
  }

  /** The effective per-tenant config (defaults deep-merged with any brand override). */
  configFor(brandId: string): TenantConfidenceConfig {
    const override = this.perTenant.get(brandId);
    if (!override) return this.defaults;
    return {
      bandThresholds: { ...this.defaults.bandThresholds, ...override.bandThresholds },
      mediumAdoptionScore: override.mediumAdoptionScore ?? this.defaults.mediumAdoptionScore,
    };
  }

  /** A verdict is MERGE-eligible ONLY when its band is the deterministic 'exact'. */
  isMergeEligible(verdict: ConfidenceVerdict): boolean {
    return verdict.band === 'exact';
  }

  /**
   * Aggregate the evidence into a ConfidenceVerdict.
   *
   * Deterministic precedence: STRONG exact (100/'exact') ▸ MEDIUM cross-device adoption (sub-'exact')
   * ▸ mint (0/'none'). Disabled matchers are filtered out (never invoked). The result is validated
   * against ConfidenceVerdictSchema before return (a malformed verdict is a hard error).
   */
  assess(evidence: ConfidenceEvidence): ConfidenceVerdict {
    const cfg = this.configFor(evidence.brand_id);

    // ── Tenant isolation (brand_id-first): a cross-tenant identifier must never be graded here.
    for (const id of evidence.identifiers) {
      if (id.brand_id !== evidence.brand_id) {
        throw new Error(
          `ConfidenceEngine tenant breach: identifier brand_id ${id.brand_id} != evidence brand_id ${evidence.brand_id}`,
        );
      }
    }

    const strongBrainIds = sortedDistinct(evidence.strongMatches.map((m) => m.brain_id));
    const mediumBrainIds = sortedDistinct(evidence.mediumMatches.map((m) => m.brain_id));

    // ── Aggregate ENABLED matchers (disabled are skipped, never invoked → never throw). ──
    const candidates: Identifier[] = [
      ...evidence.strongMatches.map((m) => m.identifier),
      ...evidence.mediumMatches.map((m) => m.identifier),
    ];
    const matcherInput: MatcherInput = {
      brand_id: evidence.brand_id,
      identifiers: [...evidence.identifiers],
      candidates,
    };
    const enabledVerdicts = this.matchers
      .filter((m) => m.status === 'enabled')
      .map((m) => m.match(matcherInput));
    // Highest score wins (the deterministic strong matcher emits 100 on overlap, else 0).
    const bestStrong = enabledVerdicts.reduce<ConfidenceVerdict | undefined>(
      (acc, v) => (acc === undefined || v.score > acc.score ? v : acc),
      undefined,
    );
    const strongScore = bestStrong?.score ?? 0;
    const matcherId = bestStrong?.matcher_id ?? this.matchers[0]?.id ?? 'deterministic-union-find';

    // ── Deterministic strategy hooks over the structural evidence. ──
    const mergeDetection = this.mergeHook.detect({ brand_id: evidence.brand_id, strongBrainIds, mediumBrainIds });
    const crossDetection = this.crossDeviceHook.detect({ brand_id: evidence.brand_id, strongBrainIds, mediumBrainIds });

    const reasons: string[] = [];
    let score: number;
    let combo: IdentifierComboMember[];

    if (strongScore >= cfg.bandThresholds.exact) {
      // ── STRONG exact match → deterministic certainty. ──
      score = cfg.bandThresholds.exact;
      reasons.push(...(bestStrong?.reasons ?? []));
      combo = bestStrong && bestStrong.identifier_combo.length > 0
        ? [...bestStrong.identifier_combo]
        : toCombo(evidence.strongMatches.map((m) => m.identifier));
      if (mergeDetection.applies) reasons.push(...mergeDetection.reasons);
      // Cycle-guard / conflict → cap below 'exact' so it cannot auto-merge; route to human review.
      if (evidence.routeToReview) {
        score = Math.min(score, cfg.bandThresholds.exact - 1);
        reasons.push(`route_to_review:${evidence.routeReason ?? 'conflict'}`);
      }
    } else if (crossDetection.applies) {
      // ── MEDIUM-tier cross-device adoption → sub-'exact', RESOLVE-ONLY (never merge). ──
      let s = cfg.mediumAdoptionScore;
      if (s >= cfg.bandThresholds.exact) {
        // Never-merge guarantee: a misconfigured medium score is clamped strictly below 'exact'.
        s = cfg.bandThresholds.exact - 1;
        reasons.push('config_guard:medium_capped_below_exact');
      }
      score = s;
      reasons.push(...crossDetection.reasons);
      for (const t of sortedDistinct(evidence.mediumMatches.map((m) => m.identifier.identifier_type))) {
        reasons.push(`cross_device:adopt:${t}`);
      }
      combo = toCombo(evidence.mediumMatches.map((m) => m.identifier));
    } else {
      // ── No actionable match → mint a fresh identity. ──
      score = 0;
      if (crossDetection.reasons.length > 0) reasons.push(...crossDetection.reasons); // e.g. cross_device:ambiguous
      reasons.push(...(bestStrong?.reasons ?? []));
      reasons.push('no_match:mint');
      combo = toCombo(evidence.identifiers);
    }

    const band = bandFromScore(score, cfg.bandThresholds);

    // Dedup reasons, preserve order. Never raw PII (brain_ids are UUIDs, hashes are hash-only).
    const dedupReasons = [...new Set(reasons)];

    return ConfidenceVerdictSchema.parse({
      score,
      band,
      reasons: dedupReasons,
      matcher_id: matcherId,
      rule_version: this.ruleVersion,
      identifier_combo: combo,
    } satisfies ConfidenceVerdict);
  }
}
