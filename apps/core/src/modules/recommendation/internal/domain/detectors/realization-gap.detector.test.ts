/**
 * realization-gap.detector.test.ts — the pure detector logic (no DB, no I/O).
 *
 * Asserts the unsettled-share threshold, suppression (never overstate on thin/settled data),
 * confidence tiers, and the bigint-minor evidence shape.
 */
import { describe, it, expect } from 'vitest';
import { realizationGapDetector } from './realization-gap.detector.js';

describe('realizationGapDetector', () => {
  it('fires a Trusted risk when most recognized GMV is unsettled on a large sample', () => {
    // 1,000,000 recognized; only 200,000 realized ⇒ 80% unsettled.
    const rec = realizationGapDetector({
      provisionalMinor: 1_000_000n,
      realizedMinor: 200_000n,
      orderCount: 150,
    });
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe('risk');
    expect(rec!.detector).toBe('realization_gap');
    expect(rec!.confidence).toBe('Trusted'); // ≥ 100 orders
    expect(rec!.payload.evidence.unsettled_minor).toBe('800000');
    expect(rec!.payload.evidence.unsettled_share_pct).toBe('80.00');
    expect(rec!.payload.evidence.order_count).toBe(150);
    expect(rec!.priority).toBeGreaterThan(0);
  });

  it('fires only Estimated on a moderate sample (below the trusted floor)', () => {
    const rec = realizationGapDetector({
      provisionalMinor: 1_000_000n,
      realizedMinor: 100_000n,
      orderCount: 40,
    });
    expect(rec).not.toBeNull();
    expect(rec!.confidence).toBe('Estimated'); // 20 ≤ orders < 100
  });

  it('SUPPRESSES (null) below the minimum order count — never overstate', () => {
    expect(
      realizationGapDetector({ provisionalMinor: 1_000_000n, realizedMinor: 0n, orderCount: 10 }),
    ).toBeNull();
  });

  it('returns null when the unsettled share is within tolerance', () => {
    // 50% unsettled — below the 60% threshold.
    expect(
      realizationGapDetector({ provisionalMinor: 1_000_000n, realizedMinor: 500_000n, orderCount: 200 }),
    ).toBeNull();
  });

  it('returns null when fully settled (no gap) even on a large sample', () => {
    expect(
      realizationGapDetector({ provisionalMinor: 1_000_000n, realizedMinor: 1_000_000n, orderCount: 200 }),
    ).toBeNull();
  });

  it('returns null when nothing is recognized yet', () => {
    expect(
      realizationGapDetector({ provisionalMinor: 0n, realizedMinor: 0n, orderCount: 200 }),
    ).toBeNull();
  });
});
