/**
 * quality-gate.test.ts — CI-BLOCKING gate test (02-architecture.md §2b, §7).
 *
 * THE CONTRACT (the reason this file is CI-blocking):
 *   The quality gate MUST BLOCK high-risk recommendations when the effective_confidence
 *   grade is Estimated (C) or Untrusted (D), AND mark those metrics as NOT billing-capped
 *   and EXCLUDED from MMM. Trusted (A+|A|B) is the inverse (full recs, cap applies, in MMM).
 *
 * If this test ever fails, the gate has regressed and a high-risk recommendation could ship
 * on untrusted data — so this path is wired into CI as a blocking check.
 *
 * Frozen, deterministic; no float, no model.
 */

import { describe, it, expect } from 'vitest';
import { gateMetric, evaluateGate } from './quality-gate.js';
import type { DqLetterGrade } from './cost-confidence.js';

describe('gateMetric — letter grade → trust tier', () => {
  it('A+|A|B → trusted', () => {
    expect(gateMetric('A+')).toBe('trusted');
    expect(gateMetric('A')).toBe('trusted');
    expect(gateMetric('B')).toBe('trusted');
  });
  it('C → estimated', () => {
    expect(gateMetric('C')).toBe('estimated');
  });
  it('D → untrusted', () => {
    expect(gateMetric('D')).toBe('untrusted');
  });
});

describe('evaluateGate — Trusted (A+|A|B) → full recommendations + billing cap + MMM', () => {
  for (const grade of ['A+', 'A', 'B'] as const) {
    it(`${grade} is trusted, cap applies, in MMM, does NOT block high-risk`, () => {
      const d = evaluateGate(grade);
      expect(d.tier).toBe('trusted');
      expect(d.billingCapApplies).toBe(true);
      expect(d.includedInMmm).toBe(true);
      expect(d.blocksHighRiskRecommendation).toBe(false);
    });
  }
});

describe('CI-BLOCKING: the gate BLOCKS high-risk recommendations when Estimated/Untrusted', () => {
  for (const grade of ['C', 'D'] as DqLetterGrade[]) {
    it(`${grade} BLOCKS high-risk recommendations, NO billing cap, EXCLUDED from MMM`, () => {
      const d = evaluateGate(grade);
      // THE blocking assertion — this is the acceptance criterion.
      expect(d.blocksHighRiskRecommendation).toBe(true);
      expect(d.billingCapApplies).toBe(false);
      expect(d.includedInMmm).toBe(false);
      expect(d.tier).not.toBe('trusted');
    });
  }

  it('C is estimated and D is untrusted (distinct tiers, same gate effect)', () => {
    expect(evaluateGate('C').tier).toBe('estimated');
    expect(evaluateGate('D').tier).toBe('untrusted');
  });
});

describe('determinism — a re-run yields the same decision', () => {
  it('evaluateGate is referentially stable', () => {
    expect(evaluateGate('C')).toEqual(evaluateGate('C'));
    expect(evaluateGate('A')).toEqual(evaluateGate('A'));
  });
});
