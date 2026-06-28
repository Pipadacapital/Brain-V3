/**
 * customer-scores-batch — deriveLifecycleSegment ladder parity with _segment_rules.py.
 *
 * Proves the TypeScript first-match precedence reproduces the EXACT ladder the Spark mart executes
 * (db/iceberg/spark/gold/_segment_rules.py): churned > at_risk > VIP > loyal > high_value >
 * first_time_buyer > cart_abandoner > window_shopper, including null-recency three-valued logic.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveLifecycleSegment,
  isLifecycleSegment,
  LIFECYCLE_SEGMENTS,
} from './customer-scores-batch.js';

describe('deriveLifecycleSegment — deterministic precedence ladder', () => {
  it('1. churned wins on recency > 180 regardless of value/frequency (a churned VIP is churned)', () => {
    expect(deriveLifecycleSegment(181, 10n, 50_000_000n)).toBe('churned');
  });

  it('2. at_risk on recency in (90, 180]', () => {
    expect(deriveLifecycleSegment(120, 10n, 50_000_000n)).toBe('at_risk');
    expect(deriveLifecycleSegment(91, 1n, 0n)).toBe('at_risk');
  });

  it('3. VIP: ltv >= 1e7 AND orders >= 5 AND recency <= 60', () => {
    expect(deriveLifecycleSegment(30, 5n, 10_000_000n)).toBe('VIP');
    // recency 61 → not VIP, falls to loyal (orders>=5, recency<=90)
    expect(deriveLifecycleSegment(61, 5n, 10_000_000n)).toBe('loyal');
  });

  it('4. loyal: orders >= 5 AND recency <= 90 (below VIP money/recency)', () => {
    expect(deriveLifecycleSegment(80, 6n, 1_000_000n)).toBe('loyal');
  });

  it('5. high_value: ltv >= 5e6 (not frequent/recent enough for VIP/loyal)', () => {
    expect(deriveLifecycleSegment(30, 2n, 6_000_000n)).toBe('high_value');
  });

  it('6. first_time_buyer: exactly one realized order', () => {
    expect(deriveLifecycleSegment(10, 1n, 200_000n)).toBe('first_time_buyer');
  });

  it('7. cart_abandoner: zero realized value', () => {
    expect(deriveLifecycleSegment(10, 3n, 0n)).toBe('cart_abandoner');
  });

  it('8. window_shopper: residual (low recency/frequency/monetary, >1 order, >0 value)', () => {
    expect(deriveLifecycleSegment(10, 2n, 30_000n)).toBe('window_shopper');
  });

  it('null recency follows SQL 3-valued logic — never matches recency rules, falls to value/freq ladder', () => {
    // null recency: not churned/at_risk/VIP/loyal → high_value by money
    expect(deriveLifecycleSegment(null, 9n, 9_000_000n)).toBe('high_value');
    // null recency, one order, some value → first_time_buyer
    expect(deriveLifecycleSegment(null, 1n, 100n)).toBe('first_time_buyer');
    // null recency, zero value → cart_abandoner
    expect(deriveLifecycleSegment(null, 1n, 0n)).toBe('cart_abandoner');
  });

  it('boundary: recency exactly 180 is at_risk, exactly 90 is not at_risk', () => {
    expect(deriveLifecycleSegment(180, 1n, 0n)).toBe('at_risk');
    // recency 90 (not > 90) + 1 order + 0 value → cart_abandoner
    expect(deriveLifecycleSegment(90, 1n, 0n)).toBe('cart_abandoner');
  });

  it('every derived label is a valid lifecycle segment', () => {
    const samples: Array<[number | null, bigint, bigint]> = [
      [181, 1n, 0n],
      [120, 1n, 0n],
      [30, 5n, 10_000_000n],
      [80, 6n, 1_000_000n],
      [30, 2n, 6_000_000n],
      [10, 1n, 200_000n],
      [10, 3n, 0n],
      [10, 2n, 30_000n],
    ];
    for (const [r, o, v] of samples) {
      expect(LIFECYCLE_SEGMENTS).toContain(deriveLifecycleSegment(r, o, v));
    }
  });

  it('isLifecycleSegment guards the filter param', () => {
    expect(isLifecycleSegment('VIP')).toBe(true);
    expect(isLifecycleSegment('loyal')).toBe(true);
    expect(isLifecycleSegment('window_shopper')).toBe(true);
    expect(isLifecycleSegment('not_a_segment')).toBe(false);
    expect(isLifecycleSegment('')).toBe(false);
  });
});
