/**
 * grade.test.ts — the FROZEN DQ grader (Tier-0, deterministic, no model).
 * Proves: frozen band boundaries, determinism (same input → same grade), and the
 * honest-failure posture (NaN/negative → D, never a false A+).
 */
import { describe, it, expect } from 'vitest';
import {
  gradeFromFraction,
  gradeFreshness,
  gradeBadnessRatio,
  gradeReconciliation,
} from './grade.js';

describe('gradeFromFraction — frozen bands', () => {
  it('maps the band edges exactly', () => {
    expect(gradeFromFraction(0)).toBe('A+');
    expect(gradeFromFraction(0.25)).toBe('A');
    expect(gradeFromFraction(0.2500001)).toBe('B');
    expect(gradeFromFraction(0.5)).toBe('B');
    expect(gradeFromFraction(0.5000001)).toBe('C');
    expect(gradeFromFraction(1.0)).toBe('C');
    expect(gradeFromFraction(1.0000001)).toBe('D');
    expect(gradeFromFraction(10)).toBe('D');
  });

  it('fails closed on NaN / negative (never a false A+)', () => {
    expect(gradeFromFraction(Number.NaN)).toBe('D');
    expect(gradeFromFraction(-1)).toBe('D');
    expect(gradeFromFraction(Number.POSITIVE_INFINITY)).toBe('D');
  });

  it('is deterministic — same input → same grade across re-runs', () => {
    const inputs = [0, 0.1, 0.3, 0.7, 1.5];
    const first = inputs.map(gradeFromFraction);
    const second = inputs.map(gradeFromFraction);
    expect(second).toEqual(first);
  });
});

describe('gradeFreshness', () => {
  it('fresh row → A+, at-SLA → C, breached → D', () => {
    expect(gradeFreshness(0, 60).grade).toBe('A+');
    expect(gradeFreshness(15, 60).grade).toBe('A'); // 0.25
    expect(gradeFreshness(60, 60).grade).toBe('C'); // exactly at SLA
    expect(gradeFreshness(120, 60).grade).toBe('D'); // 2x breached
    expect(gradeFreshness(60, 60).passing).toBe(true);
    expect(gradeFreshness(61, 60).passing).toBe(false);
  });

  it('invalid SLA fails closed to D', () => {
    expect(gradeFreshness(10, 0).grade).toBe('D');
  });
});

describe('gradeBadnessRatio — zero-tolerance null/validity rate', () => {
  it('perfect (0 null) → A+, any null with zero-tolerance → D', () => {
    expect(gradeBadnessRatio(0, 0).grade).toBe('A+');
    expect(gradeBadnessRatio(0.0001, 0).grade).toBe('D');
    expect(gradeBadnessRatio(0, 0).passing).toBe(true);
    expect(gradeBadnessRatio(0.01, 0).passing).toBe(false);
  });

  it('non-zero tolerance grades by fraction', () => {
    expect(gradeBadnessRatio(0.0005, 0.001).grade).toBe('B'); // 0.5
    expect(gradeBadnessRatio(0.002, 0.001).grade).toBe('D'); // 2x
  });
});

describe('gradeReconciliation', () => {
  it('exact match → A+, within tolerance graded, beyond → D', () => {
    expect(gradeReconciliation(0, 100).grade).toBe('A+');
    expect(gradeReconciliation(25, 100).grade).toBe('A');
    expect(gradeReconciliation(100, 100).grade).toBe('C');
    expect(gradeReconciliation(101, 100).grade).toBe('D');
    expect(gradeReconciliation(-50, 100).grade).toBe('B'); // abs(delta)
  });

  it('exact-match-required (tolerance 0): any delta → D', () => {
    expect(gradeReconciliation(0, 0).grade).toBe('A+');
    expect(gradeReconciliation(1, 0).grade).toBe('D');
  });
});
