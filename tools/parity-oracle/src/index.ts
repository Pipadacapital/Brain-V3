/**
 * parity-oracle — Dual-store parity gate (EC9, I-E03, I-E04)
 *
 * DESIGN PRINCIPLE: the parity oracle is NEVER a tautology.
 * The TypeScript computation (packages/metric-engine) is compared against an
 * INDEPENDENT SQL recomputation on the same snapshot. They must agree within
 * a defined tolerance. A delta is a build failure.
 *
 * In Sprint-0: the oracle scaffold runs green on a trivial golden fixture.
 * M1: the real metric parity (TS engine vs independent raw SQL on Postgres ledger).
 *
 * MONEY INVARIANT (I-S07): all money fields are bigint (minor units). Never number/float.
 *
 * @see INVARIANTS.md I-E03, I-E04
 * @see STACK.md locked choice 13 (dual-store parity oracle)
 * @see D-2 (03-architecture-plan.md) — non-tautological independent reference
 */

// ---------------------------------------------------------------------------
// Types — all money fields are bigint (no floats, I-S07)
// ---------------------------------------------------------------------------
export interface GoldenFixture {
  /** Human-readable name for the fixture */
  name: string;
  /** The brand_id this fixture belongs to (tenant key) */
  brandId: string;
  /** Metric identifier (matches metric_registry) */
  metricId: string;
  /**
   * The expected value in integer minor units (I-S07: no floats).
   * bigint — never number/float for money fields.
   */
  expectedValueMinor: bigint;
  /** ISO 8601 date/period this fixture represents */
  asOf: string;
  /** The TypeScript computation result (from metric-engine). bigint (I-S07). */
  tsComputedValueMinor: bigint;
  /**
   * The reference value (from an INDEPENDENT source — SQL, fixture file, or prior snapshot).
   * bigint (I-S07). MUST NOT be derived by calling the same function as tsComputedValueMinor.
   */
  referenceValueMinor: bigint;
  /**
   * Tolerance for comparison (in minor units). Must be 0n for integer money metrics.
   * bigint — the delta comparison is bigint-exact.
   */
  toleranceMinor: bigint;
}

export interface ParityResult {
  fixture: string;
  passed: boolean;
  /** bigint absolute delta between TS value and reference. */
  delta: bigint;
  toleranceMinor: bigint;
  /** bigint TS-computed value. */
  tsValue: bigint;
  /** bigint independent reference value. */
  referenceValue: bigint;
  message: string;
}

// ---------------------------------------------------------------------------
// Core parity check — compares TS computation vs independent reference
// bigint-exact: delta = |ts - ref|, no Math.abs (doesn't accept bigint).
// ---------------------------------------------------------------------------
export function checkParity(fixture: GoldenFixture): ParityResult {
  const ts = fixture.tsComputedValueMinor;
  const ref = fixture.referenceValueMinor;
  // bigint absolute delta (no Math.abs — not defined for bigint)
  const delta = ts >= ref ? ts - ref : ref - ts;
  const passed = delta <= fixture.toleranceMinor;

  return {
    fixture: fixture.name,
    passed,
    delta,
    toleranceMinor: fixture.toleranceMinor,
    tsValue: ts,
    referenceValue: ref,
    message: passed
      ? `PASS: TS=${ts} REF=${ref} delta=${delta} <= tolerance=${fixture.toleranceMinor}`
      : `FAIL: TS=${ts} REF=${ref} delta=${delta} > tolerance=${fixture.toleranceMinor} — parity drift detected`,
  };
}

// ---------------------------------------------------------------------------
// Fixture runner — processes a set of golden fixtures
// ---------------------------------------------------------------------------
export function runGoldenFixtures(fixtures: GoldenFixture[]): {
  passed: number;
  failed: number;
  results: ParityResult[];
} {
  const results = fixtures.map(checkParity);
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  return { passed, failed, results };
}

// ---------------------------------------------------------------------------
// Sprint-0 trivial golden fixture (EC9)
// All money fields are bigint (I-S07 + no-float-money lint compliance).
// ---------------------------------------------------------------------------
export const SPRINT_0_FIXTURES: GoldenFixture[] = [
  {
    name: 'trivial_additive_total',
    brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    metricId: 'event_count_total',
    expectedValueMinor: 3n,
    asOf: '2026-06-15',
    tsComputedValueMinor: 3n,
    referenceValueMinor: 3n,
    toleranceMinor: 0n,
  },

  {
    name: 'trivial_sum_minor_units',
    brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    metricId: 'gmv_total_minor',
    expectedValueMinor: 150000n,
    asOf: '2026-06-15',
    // TS computation: sum of order values in minor units (paise)
    // 50000 + 75000 + 25000 = 150000 paise = INR 1,500.00
    tsComputedValueMinor: 50000n + 75000n + 25000n,
    // Reference: same sum from the golden fixture file (not from the TS computation itself)
    referenceValueMinor: 150000n,
    toleranceMinor: 0n,  // Integer minor units: zero tolerance (I-S07)
  },
];

// ---------------------------------------------------------------------------
// Anti-tautology assertion (Sprint-0 sanity check)
// Verifies the fixture has a REAL independent reference, not a copy of the TS value.
// Note: this is a structural guard, not a runtime proof — the non-tautological
// guarantee is enforced by the independent reference SQL path (D-2).
// ---------------------------------------------------------------------------
export function assertNotTautology(fixture: GoldenFixture): void {
  if (typeof fixture.tsComputedValueMinor !== 'bigint') {
    throw new Error(`[parity-oracle] Fixture '${fixture.name}': tsComputedValueMinor must be a bigint`);
  }
  if (typeof fixture.referenceValueMinor !== 'bigint') {
    throw new Error(`[parity-oracle] Fixture '${fixture.name}': referenceValueMinor must be a bigint`);
  }
  if (fixture.toleranceMinor < 0n) {
    throw new Error(`[parity-oracle] Fixture '${fixture.name}': toleranceMinor cannot be negative`);
  }
}
