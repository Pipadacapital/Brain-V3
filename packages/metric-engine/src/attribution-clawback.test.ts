/**
 * attribution-clawback.test.ts — the cumulative-clawback clamp (audit R-11).
 *
 * Guarantee: Σ|clawback| for an order can never exceed Σ credit, so net attributed revenue
 * (credit + clawback) can never go negative — even under duplicate or over-sized reversals.
 */
import { describe, it, expect } from 'vitest';
import { clampReversalBasis } from './attribution-clawback.js';

describe('clampReversalBasis (R-11 cumulative clamp)', () => {
  const CREDIT = 1000n; // the order's total credit (positive magnitude)

  it('passes a reversal through unchanged when it fits within the un-reversed credit', () => {
    // First partial refund of 300 on a 1000 credit, nothing clawed yet → full -300.
    expect(clampReversalBasis(-300n, CREDIT, 0n)).toBe(-300n);
  });

  it('CLAMPS an over-sized single reversal to the credit total (never over-claws)', () => {
    // A reversal of 1500 on a 1000 credit (e.g. a bad/duplicate event) → clamp to -1000.
    expect(clampReversalBasis(-1500n, CREDIT, 0n)).toBe(-1000n);
  });

  it('CLAMPS cumulatively across reversals — the 2nd reversal only claws the remainder', () => {
    // 700 already clawed; a second reversal of 600 would total 1300 > 1000 → clamp to the remaining 300.
    expect(clampReversalBasis(-600n, CREDIT, 700n)).toBe(-300n);
  });

  it('returns 0n when the order is already fully reversed (nothing left to claw)', () => {
    expect(clampReversalBasis(-200n, CREDIT, 1000n)).toBe(0n);
    expect(clampReversalBasis(-200n, CREDIT, 1200n)).toBe(0n); // defensive: over-clawed already
  });

  it('passes through an exact-remainder reversal', () => {
    expect(clampReversalBasis(-300n, CREDIT, 700n)).toBe(-300n); // 700 + 300 == 1000 exactly
  });

  it('claws nothing for a non-negative (non-reversal) basis — defensive', () => {
    expect(clampReversalBasis(0n, CREDIT, 0n)).toBe(0n);
    expect(clampReversalBasis(500n, CREDIT, 0n)).toBe(0n);
  });

  it('full RTO of an un-reversed order claws back exactly the credit (Σ credit+clawback = 0)', () => {
    expect(clampReversalBasis(-1000n, CREDIT, 0n)).toBe(-1000n);
  });
});
