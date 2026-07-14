// SPEC: I
/**
 * Wave-I governance gate (PLAN-OF-RECORD §I) — recorded as a pure, fail-closed predicate.
 *
 * NO business logic / scoring / execution here: this only enforces the three-part precondition
 * that must ALL hold before an executor may run autonomously (execution_mode 'auto'):
 *   (a) a human-approved policy version authorizes the action,
 *   (b) holdout support is present in the envelope, and
 *   (c) the target executor implements a working rollback (supportsRollback=true).
 *
 * Any mode other than 'auto' bypasses the gate (suggest/approve are always permitted to be
 * *represented*; they do not execute in scaffold). For 'auto', all three must be true — and since
 * every scaffold adapter has supportsRollback=false, 'auto' is structurally unreachable today.
 */
import type { ActionEnvelope, ExecutorPort } from './ExecutorPort.js';

export interface AutoGateResult {
  readonly allowed: boolean;
  /** Precondition codes that FAILED (empty when allowed). Stable → action.failed.v1.error_message. */
  readonly missing: ReadonlyArray<'policy_version' | 'holdout_group' | 'executor_rollback'>;
}

/**
 * Fail-closed evaluation of the Wave-I autonomous-execution gate. Pure; deterministic.
 * Returns { allowed:false, missing:[...] } listing every unmet precondition.
 */
export function evaluateAutoGate(action: ActionEnvelope, executor: ExecutorPort): AutoGateResult {
  if (action.execution_mode !== 'auto') {
    return { allowed: true, missing: [] };
  }
  const missing: Array<'policy_version' | 'holdout_group' | 'executor_rollback'> = [];
  if (!action.policy_version) missing.push('policy_version');
  if (!action.holdout_group) missing.push('holdout_group');
  if (!executor.supportsRollback) missing.push('executor_rollback');
  return { allowed: missing.length === 0, missing };
}
