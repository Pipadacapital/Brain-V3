/**
 * attribution-models.test.ts — pure unit tests for the credit-weight policy.
 *
 * SPEC-DERIVED LITERALS (05-architecture.md §2, METRICS.md `attribution_credit`):
 *   • weights sum to EXACTLY 1.00000000 (WEIGHT_SCALE) for every model + N.
 *   • position_based: N=1→1.0; N=2→0.5/0.5; N≥3→0.40/…/0.40 (middle 0.20 split).
 *   • credited_revenue_minor sums to EXACTLY realized_revenue_minor (no penny leak),
 *     SIGN-PRESERVING for negative bases (reversal apportionment).
 *
 * No I/O — the models are pure. No float anywhere.
 */

import { describe, it, expect } from 'vitest';
import {
  computeWeightUnits,
  apportionMinor,
  computeTouchCredits,
  weightFractionString,
  WEIGHT_SCALE,
  ATTRIBUTION_MODEL_IDS,
  type AttributionModelId,
} from './attribution-models.js';

function touches(n: number) {
  return Array.from({ length: n }, (_, i) => ({ touchSeq: i + 1 }));
}

describe('computeWeightUnits — weights sum to exactly 1.0 (WEIGHT_SCALE)', () => {
  for (const model of ATTRIBUTION_MODEL_IDS) {
    for (const n of [1, 2, 3, 4, 5, 7, 13, 100]) {
      it(`${model} N=${n} → Σ weight units = ${WEIGHT_SCALE}`, () => {
        const units = computeWeightUnits(model, n);
        expect(units).toHaveLength(n);
        const sum = units.reduce((a, b) => a + b, 0n);
        expect(sum).toBe(WEIGHT_SCALE);
        for (const u of units) expect(u >= 0n).toBe(true);
      });
    }
  }

  it('N=0 → [] (empty journey: no credit; revenue → unattributed residual)', () => {
    for (const model of ATTRIBUTION_MODEL_IDS) {
      expect(computeWeightUnits(model, 0)).toEqual([]);
    }
  });
});

describe('first_touch / last_touch — single endpoint carries 1.0', () => {
  it('first_touch N=4 → [1.0, 0, 0, 0]', () => {
    expect(computeWeightUnits('first_touch', 4)).toEqual([WEIGHT_SCALE, 0n, 0n, 0n]);
  });
  it('last_touch N=4 → [0, 0, 0, 1.0]', () => {
    expect(computeWeightUnits('last_touch', 4)).toEqual([0n, 0n, 0n, WEIGHT_SCALE]);
  });
});

describe('linear — even split with largest-remainder closure', () => {
  it('N=3 → each 33333333 + remainder closes to TOTAL', () => {
    const units = computeWeightUnits('linear', 3);
    // 100000000 / 3 = 33333333 r1 → first touch absorbs the +1.
    expect(units).toEqual([33333334n, 33333333n, 33333333n]);
    expect(units.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);
  });
  it('N=4 → exactly 0.25 each', () => {
    expect(computeWeightUnits('linear', 4)).toEqual([25_000_000n, 25_000_000n, 25_000_000n, 25_000_000n]);
  });
});

describe('position_based — 40/40/20 default (spec-exact)', () => {
  it('N=1 → 1.0', () => {
    expect(computeWeightUnits('position_based', 1)).toEqual([WEIGHT_SCALE]);
  });
  it('N=2 → 0.5 / 0.5', () => {
    expect(computeWeightUnits('position_based', 2)).toEqual([50_000_000n, 50_000_000n]);
  });
  it('N=3 → 0.40 / 0.20 / 0.40', () => {
    expect(computeWeightUnits('position_based', 3)).toEqual([40_000_000n, 20_000_000n, 40_000_000n]);
  });
  it('N=4 → 0.40 / 0.10 / 0.10 / 0.40', () => {
    expect(computeWeightUnits('position_based', 4)).toEqual([
      40_000_000n, 10_000_000n, 10_000_000n, 40_000_000n,
    ]);
  });
  it('N=5 → endpoints 0.40, three middles share 0.20 (largest-remainder closes)', () => {
    const units = computeWeightUnits('position_based', 5);
    // middle = 20000000 / 3 = 6666666 r2 → +1 to each endpoint first via the remainder order.
    expect(units[0]).toBe(40_000_001n); // first absorbs a remainder unit
    expect(units[4]).toBe(40_000_001n); // last absorbs a remainder unit
    expect(units[1]).toBe(6_666_666n);
    expect(units[2]).toBe(6_666_666n);
    expect(units[3]).toBe(6_666_666n);
    expect(units.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);
  });
});

describe('weightFractionString — DECIMAL(9,8) rendering (no float)', () => {
  it('renders endpoints + middles exactly', () => {
    expect(weightFractionString(40_000_000n)).toBe('0.40000000');
    expect(weightFractionString(WEIGHT_SCALE)).toBe('1.00000000');
    expect(weightFractionString(33_333_334n)).toBe('0.33333334');
    expect(weightFractionString(0n)).toBe('0.00000000');
  });
});

describe('apportionMinor — Σ credited = realized exactly (per-order closed-sum)', () => {
  it('apportions a non-divisible amount with no penny leak (position N=3)', () => {
    // realized = 10001 minor; weights 0.40/0.20/0.40.
    const units = computeWeightUnits('position_based', 3);
    const out = apportionMinor(units, 10001n);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(10001n);
    // raw: 4000, 2000, 4000 → Σ=10000, leftover 1 → largest remainder.
    // remainders: 40000000*10001 % 1e8 = 40000000... all equal-ish; first index wins tiebreak.
    expect((out[0] as bigint) + (out[1] as bigint) + (out[2] as bigint)).toBe(10001n);
  });

  it('sign-preserving: negative basis apportions to negative credited, Σ exact', () => {
    const units = computeWeightUnits('position_based', 3);
    const out = apportionMinor(units, -10001n);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(-10001n);
    for (const v of out) expect(v <= 0n).toBe(true);
  });

  it('mirror property: clawback of full basis exactly negates the credit (closed-sum=0)', () => {
    const units = computeWeightUnits('position_based', 4);
    const credit = apportionMinor(units, 99997n);
    const clawback = apportionMinor(units, -99997n); // full RTO basis = −realized
    for (let i = 0; i < credit.length; i++) {
      expect((credit[i] as bigint) + (clawback[i] as bigint)).toBe(0n);
    }
  });

  it('throws if weights do not sum to WEIGHT_SCALE (guard)', () => {
    expect(() => apportionMinor([1n, 1n], 100n)).toThrow(/sum to/);
  });

  it('zero realized → all-zero credited (Σ=0)', () => {
    const units = computeWeightUnits('linear', 5);
    const out = apportionMinor(units, 0n);
    expect(out.reduce((a, b) => a + b, 0n)).toBe(0n);
    expect(out.every((v) => v === 0n)).toBe(true);
  });
});

describe('computeTouchCredits — full per-touch credit, carries touchSeq', () => {
  it('returns weight + apportioned money per touch, closed-sum exact', () => {
    const credits = computeTouchCredits('position_based', touches(3), 100000n);
    expect(credits).toHaveLength(3);
    expect(credits.map((c) => c.touchSeq)).toEqual([1, 2, 3]);
    expect(credits.map((c) => c.weightFraction)).toEqual([
      '0.40000000', '0.20000000', '0.40000000',
    ]);
    const sumCredited = credits.reduce((a, c) => a + c.creditedRevenueMinor, 0n);
    expect(sumCredited).toBe(100000n);
    expect(credits.map((c) => c.creditedRevenueMinor)).toEqual([40000n, 20000n, 40000n]);
  });

  it('empty touch list → [] (no credit rows; honest unattributed)', () => {
    expect(computeTouchCredits('position_based', [], 5000n)).toEqual([]);
  });

  it('every model keeps Σ credited = realized for a random-ish amount', () => {
    const realized = 1234567n;
    for (const model of ATTRIBUTION_MODEL_IDS as AttributionModelId[]) {
      for (const n of [1, 2, 3, 6]) {
        const credits = computeTouchCredits(model, touches(n), realized);
        const sum = credits.reduce((a, c) => a + c.creditedRevenueMinor, 0n);
        expect(sum).toBe(realized);
        const wsum = credits.reduce((a, c) => a + c.weightUnits, 0n);
        expect(wsum).toBe(WEIGHT_SCALE);
      }
    }
  });
});
