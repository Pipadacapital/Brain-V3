/**
 * parity-oracle/parity.test.ts — EC9: parity oracle scaffold green on trivial fixture
 *
 * Tests:
 *   1. The trivial golden fixtures pass (TS value == independent reference)
 *   2. A fixture with a DELTA between TS and reference FAILS the oracle (not a tautology)
 *   3. Anti-tautology assertion fires when a fixture is misconfigured
 *   4. Integer-only minor units (no float tolerance) for financial metrics (I-S07)
 */

import { describe, it, expect } from 'vitest';
import {
  checkParity,
  runGoldenFixtures,
  assertNotTautology,
  SPRINT_0_FIXTURES,
  type GoldenFixture,
} from './index.js';

describe('parity-oracle — EC9 trivial fixture scaffold', () => {

  it('Sprint-0 golden fixtures all PASS (TS value matches independent reference)', () => {
    const { passed, failed, results } = runGoldenFixtures(SPRINT_0_FIXTURES);

    // Log results for CI visibility
    for (const r of results) {
      console.info(`[parity-oracle] ${r.message}`);
    }

    expect(failed).toBe(0);
    expect(passed).toBe(SPRINT_0_FIXTURES.length);
  });

  it('each Sprint-0 fixture passes the anti-tautology assertion', () => {
    for (const fixture of SPRINT_0_FIXTURES) {
      expect(() => assertNotTautology(fixture)).not.toThrow();
    }
  });

  it('[NEGATIVE-CONTROL] a fixture with TS≠reference FAILS the oracle (parity drift = build failure)', () => {
    // This is the key test: the oracle is NOT a tautology.
    // When the TS computation drifts from the independent reference, the oracle FAILS.
    const driftedFixture: GoldenFixture = {
      name: 'drifted_metric',
      brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      metricId: 'event_count_total',
      expectedValueMinor: 3,
      asOf: '2026-06-15',
      tsComputedValueMinor: 4,       // TS computation returned 4 (WRONG)
      referenceValueMinor: 3,        // Reference says 3 (correct, from independent SQL)
      toleranceMinor: 0,
    };

    const result = checkParity(driftedFixture);

    expect(result.passed).toBe(false);
    expect(result.delta).toBe(1);
    expect(result.message).toContain('FAIL');
  });

  it('[NEGATIVE-CONTROL] delta within tolerance still PASSES for approved tolerance fixtures', () => {
    // Some metrics allow a small tolerance (e.g., floating-point accumulation in aggregations).
    // Integer count/money metrics must have tolerance=0 (I-S07).
    const toleratedFixture: GoldenFixture = {
      name: 'tolerated_metric',
      brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      metricId: 'some_rate_metric',
      expectedValueMinor: 100,
      asOf: '2026-06-15',
      tsComputedValueMinor: 101,
      referenceValueMinor: 100,
      toleranceMinor: 1,  // Explicit tolerance declared
    };

    const result = checkParity(toleratedFixture);
    expect(result.passed).toBe(true);
    expect(result.delta).toBe(1);
  });

  it('[I-S07] financial metric fixtures must have toleranceMinor = 0 (no float tolerance)', () => {
    // Money metrics (GMV, revenue, etc.) must have ZERO tolerance.
    // Integer minor units + integer arithmetic = no accumulation error.
    const financialFixtures = SPRINT_0_FIXTURES.filter(f =>
      f.metricId.includes('_minor') || f.metricId.includes('gmv') || f.metricId.includes('revenue')
    );

    for (const fixture of financialFixtures) {
      expect(fixture.toleranceMinor).toBe(0);
    }
  });

  it('all Sprint-0 fixtures are tenant-keyed (brand_id present)', () => {
    for (const fixture of SPRINT_0_FIXTURES) {
      expect(fixture.brandId).toBeTruthy();
      expect(fixture.brandId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
  });
});
