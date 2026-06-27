/**
 * identity/matcher.ts — the Matcher port: a pluggable strategy that turns a set of
 * tenant-scoped identifiers (+ candidate graph state) into a ConfidenceVerdict.
 *
 * Deterministic-first (D-5): exactly ONE matcher is `enabled` — the deterministic
 * union-find strategy implemented by `IdentityResolver` (apps/stream-worker). Every other
 * (probabilistic / ML / fuzzy) strategy is REGISTERED-DISABLED with status
 * `'disabled-not-implemented'`; invoking it throws `NotImplementedYet`. A disabled matcher
 * NEVER fabricates a verdict — "confidence before decisions" forbids faking a score.
 *
 * Pure types only — no IO, no graph access. The graph read-state a matcher needs is passed
 * in via `MatcherInput`; the matcher returns a verdict and never mutates anything.
 */
import { z } from 'zod';
import type { Identifier } from './identifier.js';
import type { ConfidenceVerdict } from './confidence-verdict.js';

/**
 * Matcher lifecycle status.
 *  - `enabled`                    — implemented and live.
 *  - `disabled-not-implemented`   — registered but deferred; `match()` throws NotImplementedYet.
 */
export const MatcherStatusSchema = z.enum(['enabled', 'disabled-not-implemented']);
export type MatcherStatus = z.infer<typeof MatcherStatusSchema>;

/** The matching strategy family a matcher belongs to. */
export const MatcherStrategySchema = z.enum(['deterministic', 'probabilistic', 'ml', 'fuzzy']);
export type MatcherStrategy = z.infer<typeof MatcherStrategySchema>;

/**
 * Input to a matcher. Hash-only (I-S02), brand_id-scoped. `candidates` is the already-fetched
 * graph read-state (existing hashes that overlap the input) so the matcher stays pure/IO-free.
 */
export interface MatcherInput {
  brand_id: string;
  /** The identifiers extracted from the event under resolution. */
  identifiers: Identifier[];
  /** Candidate already-known identifiers that overlap (pre-fetched from the graph). */
  candidates?: Identifier[];
}

/**
 * The Matcher port. `{ id, version, status, match }`.
 *
 * `match` is synchronous and pure: identifiers + candidates in, a ConfidenceVerdict out.
 * A `disabled-not-implemented` matcher MUST throw `NotImplementedYet` from `match` — it may
 * not return a placeholder verdict.
 */
export interface Matcher {
  readonly id: string;
  readonly version: string;
  readonly status: MatcherStatus;
  match(input: MatcherInput): ConfidenceVerdict;
}

/**
 * Thrown when a registered-DISABLED matcher is invoked. Deliberate, explicit, and loud —
 * the deferred strategy is acknowledged in the registry but NOT faked at runtime (D-5).
 */
export class NotImplementedYet extends Error {
  readonly matcher_id: string;
  readonly strategy: MatcherStrategy;
  constructor(matcher_id: string, strategy: MatcherStrategy) {
    super(
      `Matcher "${matcher_id}" (${strategy}) is registered-DISABLED (status='disabled-not-implemented'); ` +
        `no probabilistic/ML matcher is implemented — deterministic-first (D-5). It will not fabricate a ConfidenceVerdict.`,
    );
    this.name = 'NotImplementedYet';
    this.matcher_id = matcher_id;
    this.strategy = strategy;
  }
}

/**
 * Base class for a deferred matcher: implements the port with `status` pinned to
 * `'disabled-not-implemented'` and a `match()` that throws `NotImplementedYet`. Used to
 * register a strategy's existence without faking its behaviour.
 */
export class DisabledMatcher implements Matcher {
  readonly status = 'disabled-not-implemented' as const;
  constructor(
    readonly id: string,
    readonly version: string,
    readonly strategy: MatcherStrategy,
  ) {}
  match(_input: MatcherInput): ConfidenceVerdict {
    throw new NotImplementedYet(this.id, this.strategy);
  }
}

/**
 * A registry descriptor for a matcher — its identity + lifecycle, independent of any
 * implementation instance. The single source of truth for "which matchers exist and which
 * are live". Pure data; no `match` here.
 */
export const MatcherDescriptorSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  status: MatcherStatusSchema,
  strategy: MatcherStrategySchema,
  description: z.string(),
});
export type MatcherDescriptor = z.infer<typeof MatcherDescriptorSchema>;

/**
 * THE identity matcher registry. Exactly one `enabled` deterministic matcher; the rest are
 * registered-DISABLED (deferred, never faked). The enabled matcher's `match` lives in
 * `IdentityResolver` (apps/stream-worker) — this descriptor names + versions it.
 */
export const IDENTITY_MATCHER_REGISTRY: readonly MatcherDescriptor[] = [
  {
    id: 'deterministic-union-find',
    version: 'v1-deterministic',
    status: 'enabled',
    strategy: 'deterministic',
    description:
      'Strong-key union-find. ≥2 distinct strong-matched brain_ids → deterministic merge ' +
      '(canonical = lowest UUID). Implemented by IdentityResolver (apps/stream-worker). Emits ' +
      'exact verdicts (score 100, band "exact").',
  },
  {
    id: 'probabilistic-fellegi-sunter',
    version: 'v0',
    status: 'disabled-not-implemented',
    strategy: 'probabilistic',
    description:
      'DEFERRED (D-5). Fellegi–Sunter probabilistic record linkage over weighted partial ' +
      'matches. Registered-disabled — match() throws NotImplementedYet; no verdict is faked.',
  },
  {
    id: 'ml-embedding-similarity',
    version: 'v0',
    status: 'disabled-not-implemented',
    strategy: 'ml',
    description:
      'DEFERRED (D-5). Learned-embedding similarity over identity features. Registered-disabled ' +
      '— match() throws NotImplementedYet; no verdict is faked.',
  },
] as const;
