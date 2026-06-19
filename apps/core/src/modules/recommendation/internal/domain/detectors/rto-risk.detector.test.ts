/**
 * rto-risk.detector.test.ts — the pure detector logic (no DB, no I/O).
 *
 * Asserts the thresholds, suppression (never overstate), confidence tiers, and evidence shape.
 */
import { describe, it, expect } from 'vitest';
import { rtoRiskDetector } from './rto-risk.detector.js';

describe('rtoRiskDetector', () => {
  it('fires a Trusted risk above the rate threshold on a large sample', () => {
    const rec = rtoRiskDetector({ orderCount: 200, rtoCount: 20, rtoGmvMinor: 1_000_000n });
    expect(rec).not.toBeNull();
    expect(rec!.kind).toBe('risk');
    expect(rec!.detector).toBe('rto_risk');
    expect(rec!.confidence).toBe('Trusted'); // ≥ 100 orders
    expect(rec!.payload.evidence.rto_rate_pct).toBe('10.00');
    expect(rec!.payload.evidence.gmv_at_risk_minor).toBe('1000000');
    expect(rec!.priority).toBeGreaterThan(0);
  });

  it('fires only Estimated on a moderate sample (below the trusted floor)', () => {
    const rec = rtoRiskDetector({ orderCount: 50, rtoCount: 5, rtoGmvMinor: 0n });
    expect(rec).not.toBeNull();
    expect(rec!.confidence).toBe('Estimated'); // 20 ≤ orders < 100
  });

  it('SUPPRESSES (null) below the minimum order count — never overstate', () => {
    expect(rtoRiskDetector({ orderCount: 10, rtoCount: 5, rtoGmvMinor: 0n })).toBeNull();
  });

  it('returns null when the RTO rate is within tolerance', () => {
    expect(rtoRiskDetector({ orderCount: 1000, rtoCount: 10, rtoGmvMinor: 0n })).toBeNull(); // 1%
  });
});
