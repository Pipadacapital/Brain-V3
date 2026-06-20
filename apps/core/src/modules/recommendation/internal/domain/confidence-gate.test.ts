/**
 * confidence-gate.test.ts — "confidence before decisions" enforcement (P0, doc 09 Part 7).
 *
 * Pins the two rules: (1) a rec can never surface above the brand's effective data trust (ceiling),
 * and (2) a high-risk rec on a non-Trusted foundation is HELD. These close the audit gap where
 * recommendations surfaced ungated regardless of measured confidence.
 */
import { describe, it, expect } from 'vitest';
import {
  applyConfidenceGate,
  minConfidence,
  tierToConfidence,
  type ConfidenceGateInputs,
} from './confidence-gate.js';

const trusted: ConfidenceGateInputs = { tier: 'trusted', blocksHighRiskRecommendation: false };
const estimated: ConfidenceGateInputs = { tier: 'estimated', blocksHighRiskRecommendation: true };
const untrusted: ConfidenceGateInputs = { tier: 'untrusted', blocksHighRiskRecommendation: true };

describe('tierToConfidence / minConfidence', () => {
  it('maps tiers to confidence ceilings', () => {
    expect(tierToConfidence('trusted')).toBe('Trusted');
    expect(tierToConfidence('estimated')).toBe('Estimated');
    expect(tierToConfidence('untrusted')).toBe('Insufficient');
  });
  it('takes the weaker confidence', () => {
    expect(minConfidence('Trusted', 'Estimated')).toBe('Estimated');
    expect(minConfidence('Estimated', 'Insufficient')).toBe('Insufficient');
    expect(minConfidence('Trusted', 'Trusted')).toBe('Trusted');
  });
});

describe('applyConfidenceGate — trusted foundation', () => {
  it('passes a trusted-detector risk rec straight through (actionable)', () => {
    expect(applyConfidenceGate('risk', 'Trusted', trusted)).toEqual({
      confidence: 'Trusted',
      held: false,
      heldReason: null,
    });
  });
  it('caps an over-confident detector to the brand ceiling (no laundering stale data)', () => {
    // Detector claims Trusted, but the brand is only Estimated (e.g. stale Silver) → capped.
    const g = applyConfidenceGate('opportunity', 'Trusted', {
      tier: 'estimated',
      blocksHighRiskRecommendation: true,
    });
    expect(g.confidence).toBe('Estimated');
    expect(g.held).toBe(false);
  });
});

describe('applyConfidenceGate — high-risk hold (the core rule)', () => {
  it('HOLDS a risk rec on an Estimated foundation', () => {
    const g = applyConfidenceGate('risk', 'Trusted', estimated);
    expect(g.held).toBe(true);
    expect(g.confidence).toBe('Insufficient');
    expect(g.heldReason).toMatch(/Trusted/);
  });
  it('HOLDS a risk rec on an Untrusted foundation', () => {
    expect(applyConfidenceGate('risk', 'Estimated', untrusted).held).toBe(true);
  });
  it('allows an OPPORTUNITY on an Estimated foundation (only high-risk is held)', () => {
    const g = applyConfidenceGate('opportunity', 'Estimated', estimated);
    expect(g.held).toBe(false);
    expect(g.confidence).toBe('Estimated');
  });
});

describe('applyConfidenceGate — untrusted floor', () => {
  it('holds EVERY rec when the foundation is Untrusted (ceiling = Insufficient)', () => {
    expect(applyConfidenceGate('opportunity', 'Trusted', untrusted)).toEqual({
      confidence: 'Insufficient',
      held: true,
      heldReason: expect.stringMatching(/insufficient/i),
    });
  });
});
