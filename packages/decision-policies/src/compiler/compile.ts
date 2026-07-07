// SPEC: H
/**
 * @brain/decision-policies — POLICY COMPILER (SKELETON).
 *
 * `compilePolicy` runs the shape validator and, on success, returns the typed CompiledPolicy plus the
 * canonical `policy_version` identity string (`<name>@<version>`) that gold_decisions.policy_version
 * persists. That is the WHOLE job of the skeleton — validate + identify.
 *
 * DEFERRED (throws, by construction — see ../domain evaluator port + ../adapters): building an
 * evaluation plan, resolving certified metric VALUES, predicting per-candidate expected value, and
 * arbitrating a winner. None of that exists here (PLAN-OF-RECORD §PART 6.H "Deferred").
 */

import type { CompiledPolicy } from '../domain/policy-types.js';
import { validatePolicy } from './validate.js';

/** Thrown when a policy document fails shape/certified-metric validation. Carries every error. */
export class PolicyValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`decision policy invalid:\n  - ${errors.join('\n  - ')}`);
    this.name = 'PolicyValidationError';
  }
}

export interface CompileResult {
  readonly policy: CompiledPolicy;
  /** `<name>@<version>` — persisted as gold_decisions.policy_version. */
  readonly policyVersion: string;
}

/**
 * Compile a parsed policy document into a validated policy + its version identity.
 * @throws PolicyValidationError when the document is not a well-formed policy.
 */
export function compilePolicy(doc: unknown): CompileResult {
  const result = validatePolicy(doc);
  if (!result.ok) {
    throw new PolicyValidationError(result.errors);
  }
  const { name, version } = result.policy.metadata;
  return { policy: result.policy, policyVersion: `${name}@${version}` };
}
