/**
 * strategyHooks.ts — the identity DETECTION strategy hooks the Confidence Engine aggregates.
 *
 * A strategy hook turns the (hash-only, brand-scoped) graph match-evidence for ONE event into a
 * `StrategyDetection` — "does this strategy fire, which brain_ids does it implicate, and is the
 * result MERGE-eligible?". Hooks are the seam where new linkage strategies plug in WITHOUT
 * touching the scoring core.
 *
 * DETERMINISTIC-FIRST (D-5) — exactly the deterministic hooks are LIVE; every probabilistic / ML /
 * household hook is REGISTERED-DISABLED and throws `NotImplementedYet` on invoke (mirrors the
 * Matcher port discipline in @brain/contracts). A disabled hook NEVER fabricates a detection —
 * "confidence before decisions" forbids faking evidence.
 *
 *   merge        (deterministic) → LIVE   : ≥2 strong-matched brain_ids → MERGE-eligible (canonical = lowest UUID).
 *   split        (deterministic) → LIVE   : admin-driven reverse of a committed merge; event-path no-op.
 *   cross_device (deterministic) → LIVE   : a medium-tier device/anon id resolves to a SINGLE known
 *                                           brain_id → RESOLVE-ONLY adoption (NEVER merge).
 *   cross_device (probabilistic) → DISABLED: throws NotImplementedYet.
 *   household    (ml/graph)      → DISABLED: throws NotImplementedYet.
 *
 * Pure domain: imports only @brain/contracts. No Neo4j, no Kafka. Hash-only (I-S02). brand_id-first.
 * Detection carries NO money and NO confidence score — scoring is the ConfidenceEngine's job; a hook
 * only reports structural evidence (which brain_ids, merge-eligible yes/no).
 */
import { NotImplementedYet } from '@brain/contracts';
import type { MatcherStatus, MatcherStrategy } from '@brain/contracts';

/** The detection-strategy family a hook belongs to. */
export type StrategyHookKind = 'merge' | 'split' | 'cross_device' | 'household';

/**
 * The structural evidence a hook reads — brand-scoped, hash-only. `strongBrainIds` /
 * `mediumBrainIds` are the DISTINCT, lexicographically-sorted brain_ids the event's strong /
 * medium identifiers resolved to in the graph (the caller pre-computes them; a hook stays pure).
 */
export interface StrategyEvidence {
  brand_id: string;
  /** Distinct brain_ids matched by STRONG (merge-key) identifiers, sorted ascending. */
  strongBrainIds: readonly string[];
  /** Distinct brain_ids matched by MEDIUM (device/anon, resolve-only) identifiers, sorted ascending. */
  mediumBrainIds: readonly string[];
}

/** A hook's structural verdict. NO score, NO money — purely "which brain_ids + is it a merge". */
export interface StrategyDetection {
  kind: StrategyHookKind;
  /** Did this strategy fire for the event? */
  applies: boolean;
  /** The brain_ids implicated (sorted; brain_ids[0] is the canonical survivor when applies). */
  brain_ids: readonly string[];
  /** True ONLY for a deterministic merge of ≥2 strong brain_ids. Medium/cross-device is ALWAYS false. */
  mergeEligible: boolean;
  /** Reason codes for the audit trail (never raw PII; brain_ids are UUIDs, not PII). */
  reasons: readonly string[];
}

/** The strategy-hook port. `detect` is synchronous + pure; a disabled hook throws on invoke. */
export interface StrategyHook {
  readonly id: string;
  readonly kind: StrategyHookKind;
  readonly strategy: MatcherStrategy;
  readonly status: MatcherStatus;
  detect(evidence: StrategyEvidence): StrategyDetection;
}

/** Distinct + lexicographically sorted (order-independence: shuffle in → identical out). */
function sortedDistinct(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * merge (deterministic) — LIVE. Fires when ≥2 DISTINCT strong-matched brain_ids exist: the
 * deterministic union-find merge. Canonical = lowest-sorted UUID (order-independent). MERGE-eligible.
 */
export class DeterministicMergeHook implements StrategyHook {
  readonly id = 'merge-deterministic';
  readonly kind = 'merge' as const;
  readonly strategy = 'deterministic' as const;
  readonly status = 'enabled' as const;

  detect(evidence: StrategyEvidence): StrategyDetection {
    const strong = sortedDistinct(evidence.strongBrainIds);
    const applies = strong.length >= 2;
    return {
      kind: 'merge',
      applies,
      brain_ids: applies ? strong : [],
      mergeEligible: applies,
      reasons: applies
        ? ['merge:deterministic_union_find', `merge:canonical=${strong[0]}`]
        : [],
    };
  }
}

/**
 * split (deterministic) — LIVE but ADMIN-DRIVEN. A split (unmerge) reverses a committed merge by
 * `merge_id`; it is never inferred from an inbound event's identifiers. On the event path this hook
 * is a deterministic no-op — present so the strategy is registered/enabled, not faked.
 */
export class DeterministicSplitHook implements StrategyHook {
  readonly id = 'split-deterministic';
  readonly kind = 'split' as const;
  readonly strategy = 'deterministic' as const;
  readonly status = 'enabled' as const;

  detect(_evidence: StrategyEvidence): StrategyDetection {
    // Split is an explicit admin Unmerge command, not an event-time inference.
    return { kind: 'split', applies: false, brain_ids: [], mergeEligible: false, reasons: ['split:admin_only'] };
  }
}

/**
 * cross_device (deterministic) — LIVE. Fires when there is NO strong match and the medium-tier
 * (device/anon) identifiers resolve to EXACTLY ONE known brain_id: an anonymous session ADOPTS that
 * brain_id. RESOLVE-ONLY — `mergeEligible` is ALWAYS false (a shared device can never fold two people
 * together). Two-or-more distinct medium brain_ids = ambiguous → does NOT fire (caller mints).
 */
export class DeterministicCrossDeviceHook implements StrategyHook {
  readonly id = 'cross-device-deterministic';
  readonly kind = 'cross_device' as const;
  readonly strategy = 'deterministic' as const;
  readonly status = 'enabled' as const;

  detect(evidence: StrategyEvidence): StrategyDetection {
    const strong = sortedDistinct(evidence.strongBrainIds);
    const medium = sortedDistinct(evidence.mediumBrainIds);
    // Only consulted when strong evidence did NOT already pin a brain_id.
    const applies = strong.length === 0 && medium.length === 1;
    if (applies) {
      return {
        kind: 'cross_device',
        applies: true,
        brain_ids: medium,
        mergeEligible: false, // resolve-only — NEVER triggers a merge
        reasons: ['cross_device:deterministic_adopt'],
      };
    }
    return {
      kind: 'cross_device',
      applies: false,
      brain_ids: [],
      mergeEligible: false,
      reasons: strong.length === 0 && medium.length >= 2 ? ['cross_device:ambiguous'] : [],
    };
  }
}

/**
 * A registered-DISABLED strategy hook (deferred probabilistic / ML / household). `detect` throws
 * `NotImplementedYet` — the strategy's existence is acknowledged in the registry but NEVER faked at
 * runtime (D-5). The Confidence Engine MUST NOT invoke a disabled hook; this is the loud guard if it does.
 */
export class DisabledStrategyHook implements StrategyHook {
  readonly status = 'disabled-not-implemented' as const;
  constructor(
    readonly id: string,
    readonly kind: StrategyHookKind,
    readonly strategy: MatcherStrategy,
  ) {}

  detect(_evidence: StrategyEvidence): StrategyDetection {
    throw new NotImplementedYet(this.id, this.strategy);
  }
}

/** A pure-data descriptor of a strategy hook — the single source of truth for "which hooks exist". */
export interface StrategyHookDescriptor {
  id: string;
  kind: StrategyHookKind;
  strategy: MatcherStrategy;
  status: MatcherStatus;
  description: string;
}

/**
 * THE identity strategy-hook registry. Exactly the DETERMINISTIC hooks are `enabled`; the
 * probabilistic cross-device + the household hook are registered-DISABLED (deferred, never faked).
 */
export const IDENTITY_STRATEGY_HOOK_REGISTRY: readonly StrategyHookDescriptor[] = [
  {
    id: 'merge-deterministic',
    kind: 'merge',
    strategy: 'deterministic',
    status: 'enabled',
    description:
      'Deterministic union-find merge: ≥2 strong-matched brain_ids → merge (canonical = lowest UUID). LIVE.',
  },
  {
    id: 'split-deterministic',
    kind: 'split',
    strategy: 'deterministic',
    status: 'enabled',
    description:
      'Deterministic admin split/unmerge: reverses a committed merge by merge_id. Event-path no-op. LIVE.',
  },
  {
    id: 'cross-device-deterministic',
    kind: 'cross_device',
    strategy: 'deterministic',
    status: 'enabled',
    description:
      'Deterministic cross-device adoption: a medium-tier device/anon id resolves to a SINGLE known ' +
      'brain_id (resolve-only, NEVER merge). LIVE.',
  },
  {
    id: 'cross-device-probabilistic',
    kind: 'cross_device',
    strategy: 'probabilistic',
    status: 'disabled-not-implemented',
    description:
      'DEFERRED (D-5). Probabilistic cross-device stitching over weighted device/behaviour signals. ' +
      'Registered-disabled — detect() throws NotImplementedYet; no detection is faked.',
  },
  {
    id: 'household-graph',
    kind: 'household',
    strategy: 'ml',
    status: 'disabled-not-implemented',
    description:
      'DEFERRED (D-5). Household / co-residence inference (learned graph). Registered-disabled — ' +
      'detect() throws NotImplementedYet; no detection is faked.',
  },
] as const;

/**
 * Build the default strategy-hook set: the three LIVE deterministic hooks plus the two
 * registered-DISABLED hooks (which throw on invoke). The Confidence Engine uses the enabled ones and
 * never invokes the disabled ones.
 */
export function createDefaultStrategyHooks(): {
  merge: DeterministicMergeHook;
  split: DeterministicSplitHook;
  crossDevice: DeterministicCrossDeviceHook;
  disabled: DisabledStrategyHook[];
} {
  return {
    merge: new DeterministicMergeHook(),
    split: new DeterministicSplitHook(),
    crossDevice: new DeterministicCrossDeviceHook(),
    disabled: [
      new DisabledStrategyHook('cross-device-probabilistic', 'cross_device', 'probabilistic'),
      new DisabledStrategyHook('household-graph', 'household', 'ml'),
    ],
  };
}
