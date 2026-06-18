/**
 * cost-confidence.test.ts — pure unit tests for the deterministic cost/effective confidence.
 *
 * SPEC (02-architecture.md §2a, METRICS.md `effective_confidence`):
 *   • minGrade = ordinal min (A+ > A > B > C > D).
 *   • cost_confidence = FLOOR over the cost-relevant grades; empty → 'D' (honest, no data).
 *   • effective_confidence = min(cost_confidence, attribution_confidence).
 *   • Deterministic: a re-run on the same inputs yields the same grade (frozen, no float, no model).
 */

import { describe, it, expect } from 'vitest';
import {
  GRADE_ORDINAL,
  minGrade,
  computeCostConfidence,
  computeEffectiveConfidence,
  type DqLetterGrade,
} from './cost-confidence.js';

const ALL: readonly DqLetterGrade[] = ['A+', 'A', 'B', 'C', 'D'] as const;

describe('GRADE_ORDINAL', () => {
  it('is strictly descending A+ > A > B > C > D', () => {
    expect(GRADE_ORDINAL['A+']).toBeGreaterThan(GRADE_ORDINAL.A);
    expect(GRADE_ORDINAL.A).toBeGreaterThan(GRADE_ORDINAL.B);
    expect(GRADE_ORDINAL.B).toBeGreaterThan(GRADE_ORDINAL.C);
    expect(GRADE_ORDINAL.C).toBeGreaterThan(GRADE_ORDINAL.D);
  });
});

describe('minGrade', () => {
  it('returns the worse (lower-ordinal) grade', () => {
    expect(minGrade('A+', 'D')).toBe('D');
    expect(minGrade('B', 'A')).toBe('B');
    expect(minGrade('C', 'D')).toBe('D');
    expect(minGrade('A', 'A+')).toBe('A');
  });

  it('is commutative for every pair', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(minGrade(a, b)).toBe(minGrade(b, a));
      }
    }
  });

  it('returns the grade itself on equality', () => {
    for (const g of ALL) expect(minGrade(g, g)).toBe(g);
  });
});

describe('computeCostConfidence', () => {
  it('returns D for an empty set (honest — no data is the lowest confidence)', () => {
    expect(computeCostConfidence([])).toBe('D');
  });

  it('returns the floor (minimum) grade across the cost-relevant checks', () => {
    expect(computeCostConfidence(['A+', 'A', 'B'])).toBe('B');
    expect(computeCostConfidence(['A+', 'C', 'A'])).toBe('C');
    expect(computeCostConfidence(['A+', 'A+', 'A+'])).toBe('A+');
    expect(computeCostConfidence(['D', 'A+'])).toBe('D');
  });

  it('is order-independent (set floor)', () => {
    expect(computeCostConfidence(['A', 'C', 'B'])).toBe(
      computeCostConfidence(['C', 'B', 'A']),
    );
  });
});

describe('computeEffectiveConfidence', () => {
  it('is the min of cost and attribution', () => {
    expect(computeEffectiveConfidence('A+', 'A')).toBe('A');
    expect(computeEffectiveConfidence('A', 'D')).toBe('D'); // weak attribution floors it
    expect(computeEffectiveConfidence('C', 'A+')).toBe('C'); // weak cost floors it
    expect(computeEffectiveConfidence('B', 'B')).toBe('B');
  });
});

describe('determinism (frozen grade — re-run yields the same grade)', () => {
  it('computeCostConfidence is referentially stable across re-runs', () => {
    const grades: DqLetterGrade[] = ['A+', 'B', 'A', 'C'];
    expect(computeCostConfidence(grades)).toBe(computeCostConfidence([...grades]));
  });

  it('computeEffectiveConfidence is referentially stable across re-runs', () => {
    expect(computeEffectiveConfidence('B', 'C')).toBe(computeEffectiveConfidence('B', 'C'));
  });
});
