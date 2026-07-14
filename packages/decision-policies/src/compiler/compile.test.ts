// SPEC: H
import { describe, expect, it } from 'vitest';
import { compilePolicy, PolicyValidationError } from './compile.js';
import { validatePolicy } from './validate.js';

// The parsed form of policies/reactivation-nudge.v1.yaml (YAML text→object parse is a DEFERRED seam;
// the compiler skeleton validates an already-parsed document, so we assert the shape directly).
const SAMPLE = {
  apiVersion: 'brain.decision/v1',
  kind: 'DecisionPolicy',
  metadata: { name: 'reactivation-nudge', version: 1, owner: 'growth-team' },
  spec: {
    subject: { type: 'customer' },
    candidates: [
      { id: 'whatsapp_nudge', action_type: 'messaging', expected_value: { metric: 'ltv_realized' } },
    ],
    constraints: [
      { metric: 'cm2_pct', op: 'gte', threshold: 0.2 },
      { metric: 'rto_rate', op: 'lte', threshold: 0.15 },
    ],
    arbitration: { strategy: 'max_expected_value', tie_breaker: 'lowest_cost' },
  },
};

describe('decision-policies compiler skeleton (SPEC:H)', () => {
  it('compiles a well-formed policy and emits <name>@<version> as policy_version', () => {
    const { policy, policyVersion } = compilePolicy(SAMPLE);
    expect(policyVersion).toBe('reactivation-nudge@1');
    expect(policy.spec.candidates).toHaveLength(1);
  });

  it('rejects a constraint that references a NON-certified metric', () => {
    const bad = {
      ...SAMPLE,
      spec: {
        ...SAMPLE.spec,
        constraints: [{ metric: 'made_up_metric', op: 'gte', threshold: 1 }],
      },
    };
    const result = validatePolicy(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('not a certified metric'))).toBe(true);
    }
    expect(() => compilePolicy(bad)).toThrow(PolicyValidationError);
  });

  it('rejects a non-monotonic version and a bad op', () => {
    const bad = {
      ...SAMPLE,
      metadata: { ...SAMPLE.metadata, version: 0 },
      spec: {
        ...SAMPLE.spec,
        constraints: [{ metric: 'cm2_pct', op: 'approx', threshold: 0.2 }],
      },
    };
    const result = validatePolicy(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});
