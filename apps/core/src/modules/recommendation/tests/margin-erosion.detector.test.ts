/**
 * margin-erosion.detector.test.ts — the pure CM2 margin-erosion detector (no DB).
 * Spec-derived literals: every assertion is a concrete value from the signal, not a tautology.
 */
import { describe, it, expect } from 'vitest';
import { marginErosionDetector, type Cm2Signal } from '../internal/domain/detectors/margin-erosion.detector.js';

// Helper: a healthy base signal (40% COGS, 10% variable, low marketing, 100 orders, Trusted).
function sig(over: Partial<Cm2Signal> = {}): Cm2Signal {
  return {
    netRevenueMinor: 100000n,
    marketingMinor: 10000n,
    orderCount: 100,
    cogsPctBps: 4000,    // 40%
    variablePctBps: 1000, // 10%
    hasCogs: true,
    confidenceRank: 2,    // Trusted
    ...over,
  };
}

describe('marginErosionDetector', () => {
  it('suppresses when there is no COGS (margin untrustworthy)', () => {
    expect(marginErosionDetector(sig({ hasCogs: false, cogsPctBps: 0 }))).toBeNull();
    expect(marginErosionDetector(sig({ confidenceRank: 0 }))).toBeNull();
  });

  it('suppresses on too few orders or zero revenue', () => {
    expect(marginErosionDetector(sig({ orderCount: 5 }))).toBeNull();
    expect(marginErosionDetector(sig({ netRevenueMinor: 0n }))).toBeNull();
  });

  it('returns null for a healthy margin (CM2 ≥ 10% of revenue)', () => {
    // rev 100000: cogs 40000 + var 10000 + mktg 10000 = 60000 → cm2 40000 = 40% margin → healthy.
    expect(marginErosionDetector(sig())).toBeNull();
  });

  it('raises a MEDIUM risk for a thin (but positive) margin', () => {
    // cogs 40% + var 10% + marketing 45% → cm2 = 100000 - 40000 - 10000 - 45000 = 5000 = 5% → thin.
    const r = marginErosionDetector(sig({ marketingMinor: 45000n }));
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('risk');
    expect(r!.payload.evidence.cm2_minor).toBe('5000');
    expect(r!.payload.evidence.cm2_margin_pct).toBe('5.00');
    expect(r!.payload.title).toContain('Thin');
    expect(r!.priority).toBeGreaterThan(0);
    expect(r!.priority).toBeLessThan(1000);
  });

  it('raises a TOP-priority risk when CM2 is negative (losing money)', () => {
    // marketing 60000 → cm2 = 100000 - 40000 - 10000 - 60000 = -10000 (negative).
    const r = marginErosionDetector(sig({ marketingMinor: 60000n }));
    expect(r).not.toBeNull();
    expect(r!.payload.evidence.cm2_minor).toBe('-10000');
    expect(r!.priority).toBe(1000);
    expect(r!.payload.title).toContain('Negative');
    expect(r!.payload.summary).toContain('unprofitable');
  });

  it('confidence mirrors the input rank (Trusted vs Estimated)', () => {
    expect(marginErosionDetector(sig({ marketingMinor: 60000n }))!.confidence).toBe('Trusted');
    expect(marginErosionDetector(sig({ marketingMinor: 60000n, confidenceRank: 1 }))!.confidence).toBe('Estimated');
  });
});
