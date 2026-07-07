// SPEC: H
/**
 * @brain/decision-policies — POLICY EVALUATOR PORT (domain, DEFERRED behavior).
 *
 * The hexagonal PORT the Wave-H decision engine will drive: given a compiled policy and a resolved
 * subject, evaluate each candidate's constraints, score its expected value, arbitrate, and emit the
 * gold_decisions record (candidates WITH scores). NO implementation ships now — this is the seam so
 * the DEFERRAL is concrete and typed, not vapor.
 *
 * INVARIANT: an evaluator NEVER runs unless the per-brand flag `decision.engine`
 * (packages/platform-flags) is ON — DEFAULT OFF. The only adapter provided today
 * (../adapters/not-implemented-evaluator.ts) throws, fail-closed.
 */

import type { CompiledPolicy } from './policy-types.js';

/** The resolved subject a decision is made about (opaque to the port; the engine hydrates it). */
export interface DecisionSubject {
  readonly brand_id: string;
  readonly type: string;
  readonly id: string;
}

/** Per-candidate evaluation output — mirrors one element of gold_decisions.candidates. */
export interface CandidateEvaluation {
  readonly candidate_id: string;
  readonly action_type: string;
  /** bigint minor units (I-S07) — NEVER a float. */
  readonly expected_value_minor: bigint;
  readonly currency_code: string;
  readonly constraint_evaluations: ReadonlyArray<{
    readonly metric: string;
    readonly op: string;
    readonly threshold: number;
    readonly observed: number;
    readonly passed: boolean;
  }>;
  readonly eligible: boolean;
  readonly rank: number;
}

/** The full decision record the engine persists into gold_decisions. */
export interface DecisionRecord {
  readonly brand_id: string;
  readonly decision_id: string;
  readonly subject: DecisionSubject;
  readonly candidates: readonly CandidateEvaluation[];
  readonly selected: string | null;
  readonly policy_version: string;
  readonly rationale: Record<string, unknown>;
  readonly decided_at: string;
}

/**
 * PORT: evaluate a compiled policy against a subject and produce the decision record.
 * DEFERRED — no in-repo implementation computes this (evaluation engine + EV models + arbitration).
 */
export interface PolicyEvaluatorPort {
  evaluate(policy: CompiledPolicy, subject: DecisionSubject): Promise<DecisionRecord>;
}
