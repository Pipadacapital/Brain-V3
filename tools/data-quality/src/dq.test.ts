/**
 * data-quality/dq.test.ts — CI invocation stub (Sprint-0, ruling 7)
 *
 * Purpose: proves the DQ framework structure is valid at CI compile time.
 * Returns GREEN on an empty model (no live data needed in Sprint-0).
 *
 * Real DQ assertions (freshness/completeness/schema/reconciliation) are
 * added in M1 when Silver/Gold marts have real data.
 */

import { describe, it, expect } from 'vitest';
import {
  DQ_CHECKS,
  DQCheckSchema,
  evaluateDQGate,
  SPRINT_0_NOTE,
  type DQCheck,
} from './index.js';

describe('data-quality framework — Sprint-0 CI stub (ruling 7)', () => {

  it('DQ_CHECKS array is non-empty (framework has declarations)', () => {
    expect(DQ_CHECKS.length).toBeGreaterThan(0);
  });

  it('all DQ checks are valid against Zod schema', () => {
    for (const check of DQ_CHECKS) {
      const result = DQCheckSchema.safeParse(check);
      expect(result.success).toBe(true);
    }
  });

  it('all DQ checks cover the 4 required categories', () => {
    const categories = new Set(DQ_CHECKS.map((c: DQCheck) => c.category));
    expect(categories.has('freshness')).toBe(true);
    expect(categories.has('completeness')).toBe(true);
    expect(categories.has('schema_validity')).toBe(true);
    expect(categories.has('reconciliation')).toBe(true);
  });

  it('DQ gate: all checks passing → metric is authoritative', () => {
    const allPassed = DQ_CHECKS.map((_, i) => ({ checkId: `check_${i}`, passed: true }));
    const gate = evaluateDQGate(allPassed);

    expect(gate.passed).toBe(true);
    expect(gate.metricStatus).toBe('authoritative');
    expect(gate.failedChecks.length).toBe(0);
  });

  it('[NEGATIVE-CONTROL] DQ gate: any failed check → metric is estimated (Iron Law)', () => {
    // This is the Iron Law: a metric is authoritative ONLY after DQ gate passes.
    // A failed check must flip the metric status to 'estimated'.
    const oneFailedCheck = [
      { checkId: 'freshness_0', passed: true },
      { checkId: 'completeness_1', passed: false },  // One failure
      { checkId: 'schema_validity_2', passed: true },
    ];

    const gate = evaluateDQGate(oneFailedCheck);

    expect(gate.passed).toBe(false);
    expect(gate.metricStatus).toBe('estimated');
    expect(gate.failedChecks).toContain('completeness_1');
  });

  it('Sprint-0 note is defined (documentation)', () => {
    expect(SPRINT_0_NOTE).toBeTruthy();
    expect(SPRINT_0_NOTE).toContain('Sprint-0');
  });

  it('freshness checks have positive maxAgeHours', () => {
    const freshnessChecks = DQ_CHECKS.filter(c => c.category === 'freshness');
    for (const check of freshnessChecks) {
      if (check.category === 'freshness') {
        expect(check.maxAgeHours).toBeGreaterThan(0);
      }
    }
  });

  it('completeness checks on tenant-key (brand_id) have zero null tolerance', () => {
    const brandIdChecks = DQ_CHECKS.filter(
      c => c.category === 'completeness' && (c as { columnName: string }).columnName === 'brand_id'
    );

    for (const check of brandIdChecks) {
      if (check.category === 'completeness') {
        expect(check.maxNullRatePct).toBe(0);
        expect(check.severity).toBe('error');
      }
    }
  });
});
