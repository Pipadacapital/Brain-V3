// SPEC: H
/**
 * @brain/decision-policies — the POLICY AST (domain types, port side).
 *
 * These types are the compiled, validated shape of a versioned YAML decision policy
 * (`packages/decision-policies/policies/<name>.v<n>.yaml`). They are PURE domain types — no infra
 * imports, no Trino/Redis/Kafka (hexagonal, §1). The compiler skeleton (../compiler) validates a
 * parsed YAML document INTO these types; it does NOT evaluate them.
 *
 * DEFERRED (NOT modelled as behavior here): the evaluation engine, EV models, and arbitration
 * (PLAN-OF-RECORD §PART 6.H "Deferred"). The `arbitration` block below is a DECLARATION of intent
 * (which strategy a future engine will apply), not an implementation.
 */

import type { CertifiedMetric } from './certified-metrics.js';

/** Comparison operator a constraint applies to a certified metric. Declarative — never evaluated here. */
export type ConstraintOp = 'gte' | 'lte' | 'gt' | 'lt' | 'eq';

/** Arbitration strategy a FUTURE engine will apply. Enum only — no strategy is implemented (DEFERRED). */
export type ArbitrationStrategy = 'max_expected_value' | 'first_eligible' | 'weighted';

/** Subject the decision is about. Mirrors gold_decisions.subject. */
export type SubjectType = 'customer' | 'product' | 'campaign' | 'order';

/**
 * A hard guardrail: a certified metric compared against a threshold. References a certified metric
 * ONLY BY NAME. The compiler validates the name is certified + the op/threshold shape; it does NOT
 * read the metric or evaluate the comparison (DEFERRED — evaluation engine).
 */
export interface PolicyConstraint {
  readonly metric: CertifiedMetric;
  readonly op: ConstraintOp;
  readonly threshold: number;
}

/**
 * Per-candidate expected-value DECLARATION: which certified metric the candidate's EV is expressed
 * in. The MODEL that predicts the value is DEFERRED (EV models) — this only names the yardstick,
 * persisted per candidate as expected_value_minor + currency_code in gold_decisions.candidates.
 */
export interface CandidateExpectedValue {
  readonly metric: CertifiedMetric;
}

/** One candidate action the policy may select among. All candidates (winners AND losers) are persisted. */
export interface PolicyCandidate {
  readonly id: string;
  /** Maps to a Wave I executor family, e.g. messaging | shopify-discount | meta-audience | webhook. */
  readonly action_type: string;
  readonly expected_value: CandidateExpectedValue;
}

/** Arbitration DECLARATION. Strategy + tie-breaker are enums a future engine reads — none runs now. */
export interface PolicyArbitration {
  readonly strategy: ArbitrationStrategy;
  readonly tie_breaker?: string;
}

/** Policy identity + provenance. `(name, version)` is persisted as gold_decisions.policy_version. */
export interface PolicyMetadata {
  readonly name: string;
  /** Monotonic positive integer. `<name>@<version>` is the certified, human-approved policy identity. */
  readonly version: number;
  readonly owner: string;
  readonly description?: string;
}

/** The subject + candidates + guardrails + arbitration a policy declares. */
export interface PolicySpec {
  readonly subject: { readonly type: SubjectType };
  readonly candidates: readonly PolicyCandidate[];
  readonly constraints: readonly PolicyConstraint[];
  readonly arbitration: PolicyArbitration;
}

/**
 * A fully-validated policy (the compiler output). apiVersion/kind pin the document contract so the
 * shape can evolve additively (like Apicurio BACKWARD compatibility for the YAML contract).
 */
export interface CompiledPolicy {
  readonly apiVersion: 'brain.decision/v1';
  readonly kind: 'DecisionPolicy';
  readonly metadata: PolicyMetadata;
  readonly spec: PolicySpec;
}
