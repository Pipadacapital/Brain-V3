// SPEC: H
/**
 * @brain/decision-policies — POLICY SHAPE VALIDATOR (compiler front-end, SKELETON).
 *
 * Same compiler PATTERN as Wave D's metric compiler, but SKELETON ONLY: it parses/validates the
 * SHAPE of a decision policy and resolves every metric reference against the certified metric set.
 * It does NOT build an evaluation plan, NOT predict expected value, NOT arbitrate (all DEFERRED —
 * PLAN-OF-RECORD §PART 6.H). It is a pure function over an already-parsed document; the YAML
 * text→object parse is a separate deferred seam (../io/load.ts).
 *
 * Returns a discriminated result so callers see EVERY shape error at once (not just the first).
 */

import { isCertifiedMetric } from '../domain/certified-metrics.js';
import type {
  ArbitrationStrategy,
  CompiledPolicy,
  ConstraintOp,
  SubjectType,
} from '../domain/policy-types.js';

const VALID_OPS: readonly ConstraintOp[] = ['gte', 'lte', 'gt', 'lt', 'eq'];
const VALID_SUBJECTS: readonly SubjectType[] = ['customer', 'product', 'campaign', 'order'];
const VALID_STRATEGIES: readonly ArbitrationStrategy[] = [
  'max_expected_value',
  'first_eligible',
  'weighted',
];

export type ValidationResult =
  | { readonly ok: true; readonly policy: CompiledPolicy }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed policy document (from YAML) into a CompiledPolicy shape. Pure, no I/O, no eval.
 * Collects all structural + certified-metric-reference errors.
 */
export function validatePolicy(doc: unknown): ValidationResult {
  const errors: string[] = [];
  const push = (m: string): void => {
    errors.push(m);
  };

  if (!isRecord(doc)) {
    return { ok: false, errors: ['policy: document must be a mapping/object'] };
  }

  if (doc.apiVersion !== 'brain.decision/v1') {
    push('apiVersion: must equal "brain.decision/v1"');
  }
  if (doc.kind !== 'DecisionPolicy') {
    push('kind: must equal "DecisionPolicy"');
  }

  // ── metadata ────────────────────────────────────────────────────────────────
  const meta = doc.metadata;
  if (!isRecord(meta)) {
    push('metadata: required mapping (name, version, owner)');
  } else {
    if (typeof meta.name !== 'string' || meta.name.length === 0) {
      push('metadata.name: required non-empty string');
    }
    if (
      typeof meta.version !== 'number' ||
      !Number.isInteger(meta.version) ||
      meta.version < 1
    ) {
      push('metadata.version: required monotonic positive integer');
    }
    if (typeof meta.owner !== 'string' || meta.owner.length === 0) {
      push('metadata.owner: required non-empty string');
    }
    if (meta.description !== undefined && typeof meta.description !== 'string') {
      push('metadata.description: must be a string when present');
    }
  }

  // ── spec ──────────────────────────────────────────────────────────────────────
  const spec = doc.spec;
  if (!isRecord(spec)) {
    push('spec: required mapping (subject, candidates, constraints, arbitration)');
  } else {
    // subject
    const subject = spec.subject;
    if (!isRecord(subject) || typeof subject.type !== 'string') {
      push('spec.subject.type: required string');
    } else if (!VALID_SUBJECTS.includes(subject.type as SubjectType)) {
      push(`spec.subject.type: must be one of ${VALID_SUBJECTS.join('|')}`);
    }

    // candidates
    if (!Array.isArray(spec.candidates) || spec.candidates.length === 0) {
      push('spec.candidates: required non-empty array');
    } else {
      spec.candidates.forEach((c, i) => {
        if (!isRecord(c)) {
          push(`spec.candidates[${i}]: must be a mapping`);
          return;
        }
        if (typeof c.id !== 'string' || c.id.length === 0) {
          push(`spec.candidates[${i}].id: required non-empty string`);
        }
        if (typeof c.action_type !== 'string' || c.action_type.length === 0) {
          push(`spec.candidates[${i}].action_type: required non-empty string`);
        }
        const ev = c.expected_value;
        if (!isRecord(ev) || typeof ev.metric !== 'string') {
          push(`spec.candidates[${i}].expected_value.metric: required string`);
        } else if (!isCertifiedMetric(ev.metric)) {
          push(
            `spec.candidates[${i}].expected_value.metric: "${ev.metric}" is not a certified metric`,
          );
        }
      });
    }

    // constraints (may be empty — a policy with no guardrails is valid)
    if (!Array.isArray(spec.constraints)) {
      push('spec.constraints: required array (may be empty)');
    } else {
      spec.constraints.forEach((k, i) => {
        if (!isRecord(k)) {
          push(`spec.constraints[${i}]: must be a mapping`);
          return;
        }
        if (typeof k.metric !== 'string') {
          push(`spec.constraints[${i}].metric: required string`);
        } else if (!isCertifiedMetric(k.metric)) {
          push(`spec.constraints[${i}].metric: "${k.metric}" is not a certified metric`);
        }
        if (typeof k.op !== 'string' || !VALID_OPS.includes(k.op as ConstraintOp)) {
          push(`spec.constraints[${i}].op: must be one of ${VALID_OPS.join('|')}`);
        }
        if (typeof k.threshold !== 'number' || Number.isNaN(k.threshold)) {
          push(`spec.constraints[${i}].threshold: required number`);
        }
      });
    }

    // arbitration
    const arb = spec.arbitration;
    if (!isRecord(arb)) {
      push('spec.arbitration: required mapping (strategy)');
    } else {
      if (
        typeof arb.strategy !== 'string' ||
        !VALID_STRATEGIES.includes(arb.strategy as ArbitrationStrategy)
      ) {
        push(`spec.arbitration.strategy: must be one of ${VALID_STRATEGIES.join('|')}`);
      }
      if (arb.tie_breaker !== undefined && typeof arb.tie_breaker !== 'string') {
        push('spec.arbitration.tie_breaker: must be a string when present');
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  // Shape proven — the cast is now sound (every field checked above).
  return { ok: true, policy: doc as unknown as CompiledPolicy };
}
