// SPEC: H
/**
 * @brain/decision-policies — NotImplemented evaluator adapter (failing-by-design, behind flag).
 *
 * The ONLY PolicyEvaluatorPort implementation that ships in the Wave-H scaffold. It throws on every
 * call: the evaluation engine, EV models, and arbitration are DEFERRED (PLAN-OF-RECORD §PART 6.H).
 * This makes the deferral fail-CLOSED and explicit — a caller that reaches an evaluator before Wave H
 * logic lands gets a loud, typed error, never a silent wrong decision.
 *
 * Wiring rule: a real evaluator replaces this ONLY behind the `decision.engine` flag (DEFAULT OFF).
 */

import type {
  DecisionRecord,
  DecisionSubject,
  PolicyEvaluatorPort,
} from '../domain/evaluator-port.js';
import type { CompiledPolicy } from '../domain/policy-types.js';

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented (Wave H scaffold — DEFERRED)`);
    this.name = 'NotImplementedError';
  }
}

export class NotImplementedPolicyEvaluator implements PolicyEvaluatorPort {
  // Params are `_`-prefixed (unused-by-design): the evaluation engine is DEFERRED (§PART 6.H).
  async evaluate(_policy: CompiledPolicy, _subject: DecisionSubject): Promise<DecisionRecord> {
    throw new NotImplementedError('decision-policies policy evaluation engine');
  }
}
