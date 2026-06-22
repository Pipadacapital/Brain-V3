/**
 * scale-opportunity.detector.test.ts — the pure CM2 scale-opportunity detector (no DB).
 * Spec-derived literals: every assertion is a concrete value from the signal, not a tautology.
 * The deterministic OPPORTUNITY counterpart to marginErosion (H1/M5/M6).
 */
import { describe, it, expect } from 'vitest';
import { scaleOpportunityDetector } from '../internal/domain/detectors/scale-opportunity.detector.js';
import type { Cm2Signal } from '../internal/domain/detectors/margin-erosion.detector.js';

// Base: 40% COGS, 10% variable, 10% marketing, 100 orders, Trusted → cm2 = 40% (healthy).
function sig(over: Partial<Cm2Signal> = {}): Cm2Signal {
  return {
    netRevenueMinor: 100000n,
    marketingMinor: 10000n,
    orderCount: 100,
    cogsPctBps: 4000,
    variablePctBps: 1000,
    hasCogs: true,
    confidenceRank: 2,
    ...over,
  };
}

describe('scaleOpportunityDetector', () => {
  it('suppresses when there is no COGS / no confidence (margin untrustworthy)', () => {
    expect(scaleOpportunityDetector(sig({ hasCogs: false, cogsPctBps: 0 }))).toBeNull();
    expect(scaleOpportunityDetector(sig({ confidenceRank: 0 }))).toBeNull();
  });

  it('suppresses on too few orders or zero revenue', () => {
    expect(scaleOpportunityDetector(sig({ orderCount: 5 }))).toBeNull();
    expect(scaleOpportunityDetector(sig({ netRevenueMinor: 0n }))).toBeNull();
  });

  it('fires an OPPORTUNITY for a healthy margin (CM2 ≥ 20% of revenue)', () => {
    // cm2 = 100000 - 40000 - 10000 - 10000 = 40000 = 40% → healthy → opportunity.
    const r = scaleOpportunityDetector(sig());
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('opportunity');
    expect(r!.payload.evidence.cm2_minor).toBe('40000');
    expect(r!.payload.evidence.cm2_margin_pct).toBe('40.00');
    expect(r!.payload.title).toContain('room to scale');
    expect(r!.priority).toBeGreaterThan(0);
  });

  it('does NOT fire for a thin margin (margin-erosion territory, never both at once)', () => {
    // marketing 45000 → cm2 5000 = 5% < 20% threshold → no opportunity.
    expect(scaleOpportunityDetector(sig({ marketingMinor: 45000n }))).toBeNull();
  });

  it('does NOT fire when CM2 is negative', () => {
    expect(scaleOpportunityDetector(sig({ marketingMinor: 60000n }))).toBeNull();
  });

  it('confidence mirrors the input rank (Trusted vs Estimated)', () => {
    expect(scaleOpportunityDetector(sig())!.confidence).toBe('Trusted');
    expect(scaleOpportunityDetector(sig({ confidenceRank: 1 }))!.confidence).toBe('Estimated');
  });
});
