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
  integerNthRoot,
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

describe('time_decay — recency-weighted, exact-sum, no float', () => {
  it('weights sum to exactly WEIGHT_SCALE for every N (default half-life)', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 13, 100]) {
      const units = computeWeightUnits('time_decay', n);
      expect(units).toHaveLength(n);
      expect(units.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);
      for (const u of units) expect(u >= 0n).toBe(true);
    }
  });

  it('N=1 → 1.0 (single touch carries all)', () => {
    expect(computeWeightUnits('time_decay', 1)).toEqual([WEIGHT_SCALE]);
  });

  it('recency ordering: weights STRICTLY increase toward the conversion (last touch)', () => {
    for (const n of [2, 3, 4, 5, 8]) {
      const units = computeWeightUnits('time_decay', n);
      for (let i = 1; i < n; i++) {
        expect(units[i]! > units[i - 1]!).toBe(true); // more recent ⇒ more credit
      }
    }
  });

  it('default half-life=1 halves credit per step back (~[1/3, 2/3] for N=2)', () => {
    const [w0, w1] = computeWeightUnits('time_decay', 2) as [bigint, bigint];
    expect(w0 + w1).toBe(WEIGHT_SCALE);
    // last touch ≈ 2× the first (ratio 2^(1/1)); first ≈ 1/3, last ≈ 2/3.
    expect(w1 - 2n * w0 <= 1n && 2n * w0 - w1 <= 1n).toBe(true);
    expect(w0).toBe(33_333_333n);
    expect(w1).toBe(66_666_667n);
  });

  it('configurable half-life: a LONGER half-life gives a GENTLER decay (first touch keeps more)', () => {
    const steep = computeWeightUnits('time_decay', 4, 1); // halves every step
    const gentle = computeWeightUnits('time_decay', 4, 3); // halves every 3 steps
    // first touch (oldest) retains strictly more credit under the longer half-life.
    expect(gentle[0]! > steep[0]!).toBe(true);
    // last touch (most recent) dominates strictly less under the longer half-life.
    expect(gentle[3]! < steep[3]!).toBe(true);
    expect(steep.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);
    expect(gentle.reduce((a, b) => a + b, 0n)).toBe(WEIGHT_SCALE);
  });

  it('exact-parent reconciliation: Σ credited == realized (no penny leak), incl. negative basis', () => {
    for (const n of [1, 2, 3, 4, 7]) {
      for (const realized of [100000n, 10001n, 1234567n, -98765n]) {
        const credits = computeTouchCredits('time_decay', touches(n), realized);
        const sum = credits.reduce((a, c) => a + c.creditedRevenueMinor, 0n);
        expect(sum).toBe(realized);
        const wsum = credits.reduce((a, c) => a + c.weightUnits, 0n);
        expect(wsum).toBe(WEIGHT_SCALE);
      }
    }
  });

  it('rejects a non-positive / non-integer half-life (no silent fallback)', () => {
    expect(() => computeWeightUnits('time_decay', 3, 0)).toThrow(/half-life/);
    expect(() => computeWeightUnits('time_decay', 3, -2)).toThrow(/half-life/);
    expect(() => computeWeightUnits('time_decay', 3, 1.5)).toThrow(/half-life/);
  });
});

describe('integerNthRoot — ⌊value^(1/k)⌋ over BigInt (no float)', () => {
  it('exact roots', () => {
    expect(integerNthRoot(0n, 3)).toBe(0n);
    expect(integerNthRoot(1n, 5)).toBe(1n);
    expect(integerNthRoot(8n, 3)).toBe(2n);
    expect(integerNthRoot(1_000_000n, 2)).toBe(1000n);
    expect(integerNthRoot(1_000_000_000n, 3)).toBe(1000n);
  });
  it('floors non-perfect roots', () => {
    expect(integerNthRoot(10n, 2)).toBe(3n); // √10 ≈ 3.16
    expect(integerNthRoot(26n, 3)).toBe(2n); // 26^(1/3) ≈ 2.96
    expect(integerNthRoot(9n, 1)).toBe(9n); // k=1 identity
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
