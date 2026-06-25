/**
 * parity-oracle/parity.test.ts — M1 parity gate (EC9, D-2) — MEDALLION re-pointed.
 *
 * ── MEDALLION RE-POINT (Phase G) ─────────────────────────────────────────────
 * The realized/provisional revenue READ path moved off the PG
 * `realized_revenue_ledger` (dropped as a dashboard source by the medallion
 * realignment) onto the lakehouse gold ledger `brain_gold.gold_revenue_ledger`,
 * reached over the StarRocks MySQL wire (mysql2). The engine now takes
 * { srPool } and reads gold via withSilverBrand. So this gate seeds the GOLD
 * ledger and passes a real StarRocks pool — exactly like the analytics live
 * suites (apps/core/.../revenue-metrics.live.test.ts). The independent
 * reference (reference.ts) reads the SAME gold table via a STRUCTURALLY
 * DIFFERENT predicate — keeping the gate non-tautological.
 *
 * TWO classes of tests:
 *
 * A. Sprint-0 trivial fixtures (in-memory, no DB) — backward-compat EC9 scaffold.
 *    (These never touched a store and are unchanged.)
 * B. Live parity tests — the actual CI gate:
 *    For each golden fixture, seed the gold ledger, run BOTH:
 *      - The engine (computeRealizedRevenue / computeProvisionalRevenue)
 *      - The independent reference SQL (getIndependentReferenceRevenue)
 *    Assert EQUAL per-currency with toleranceMinor=0 (a 1-minor delta FAILS).
 *
 * NON-TAUTOLOGICAL PROOF:
 *   The reference (realized) uses recognition_label='finalized'; the engine uses
 *   event_type <> 'provisional_recognition'. The reference (provisional) uses
 *   event_type='provisional_recognition'; the engine uses recognition_label IN
 *   ('provisional','settling'). These are structurally different predicates over
 *   the same gold table. A bug in either path causes a delta.
 *
 * RED PROOF (negative control):
 *   A deliberately perturbed engine value (off by 1 minor unit) causes the gate
 *   to FAIL (see describe C — checkParity on a synthetic 1-minor delta).
 *
 * ISOLATION:
 *   The Silver seam injects `brand_id = ?` at withSilverBrand → the engine never
 *   sees another brand's rows. Proven in describe D against seeded cross-brand
 *   gold rows (active blocking, not absence-of-data).
 *
 * REQUIRES: StarRocks on :9030 with brain_gold.gold_revenue_ledger. The live
 *   sections SKIP (no-op) when StarRocks is unreachable, like the sibling
 *   analytics live suites — so the package typechecks/builds with no infra.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  checkParity,
  runGoldenFixtures,
  assertNotTautology,
  SPRINT_0_FIXTURES,
  type GoldenFixture,
} from './index.js';
import {
  getIndependentReferenceRevenue,
  getIndependentReferenceProvisional,
} from './reference.js';
import { computeRealizedRevenue, computeProvisionalRevenue } from '@brain/metric-engine';
import type { SilverPool } from '@brain/metric-engine';

// ── Config ────────────────────────────────────────────────────────────────────

const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);

// Deterministic test brand UUIDs (scoped to parity oracle tests, valid UUID v4 format)
const BRAND_PARITY_A = 'a0200020-0020-4020-8020-000000000001'; // INR
const BRAND_PARITY_B = 'b0200020-0020-4020-8020-000000000002'; // AED

let srPool: mysql.Pool;
let srUp = false;

// The engine takes { srPool }; mysql2's Pool satisfies the SilverPool shape.
const deps = () => ({ srPool: srPool as unknown as SilverPool });

// ── Helpers — seed the lakehouse gold ledger directly ───────────────────────────

async function clearGold(...brandIds: string[]): Promise<void> {
  if (!srUp) return;
  for (const brandId of brandIds) {
    await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [brandId]);
  }
}

/**
 * Seed a finalized (realized) row into the gold ledger.
 * recognition_label='finalized' so BOTH the engine (event_type<>'provisional_recognition')
 * and the reference (recognition_label='finalized') count it.
 */
async function seedFinalized(
  brandId: string,
  orderId: string,
  amountMinor: bigint,
  currencyCode: string,
  asOf: string,
): Promise<void> {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'finalization', ?, ?, 0, ?, ?, 'finalized', ?, 'live', NOW())`,
    [
      brandId,
      randomUUID(),
      orderId,
      String(amountMinor),
      currencyCode,
      asOf,
      asOf,
      asOf.slice(0, 7), // billing_posted_period = 'YYYY-MM'
    ],
  );
}

/**
 * Seed a reversal/refund row (event_type given) that is still recognition_label='finalized'
 * (a clawback against a finalized sale). Both engine and reference net it in.
 */
async function seedFinalizedAdjustment(
  brandId: string,
  orderId: string,
  eventType: string,
  amountMinor: bigint,
  currencyCode: string,
  asOf: string,
): Promise<void> {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, 'finalized', ?, 'live', NOW())`,
    [
      brandId,
      randomUUID(),
      orderId,
      eventType,
      String(amountMinor),
      currencyCode,
      asOf,
      asOf,
      asOf.slice(0, 7),
    ],
  );
}

/**
 * Seed a provisional row into the gold ledger.
 * event_type='provisional_recognition' (reference) AND recognition_label='provisional' (engine).
 */
async function seedProvisional(
  brandId: string,
  orderId: string,
  amountMinor: bigint,
  currencyCode: string,
  asOf: string,
): Promise<void> {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'provisional_recognition', ?, ?, 0, ?, ?, 'provisional', ?, 'live', NOW())`,
    [
      brandId,
      randomUUID(),
      orderId,
      String(amountMinor),
      currencyCode,
      asOf,
      asOf,
      asOf.slice(0, 7),
    ],
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    srPool = mysql.createPool({
      host: SR_HOST,
      port: SR_PORT,
      user: 'root',
      password: '',
      connectionLimit: 4,
    });
    await srPool.query('SELECT 1');
    srUp = true;
  } catch {
    srUp = false;
  }
  await clearGold(BRAND_PARITY_A, BRAND_PARITY_B);
});

afterAll(async () => {
  await clearGold(BRAND_PARITY_A, BRAND_PARITY_B);
  if (srPool) await srPool.end().catch(() => {});
});

// ── Helper: compare engine Map vs reference Map ───────────────────────────────

function assertMapsEqual(
  engineMap: Map<string, bigint>,
  referenceMap: Map<string, bigint>,
  label: string,
): void {
  const engineKeys = [...engineMap.keys()].sort();
  const refKeys = [...referenceMap.keys()].sort();
  expect(engineKeys, `${label}: currency keys mismatch`).toEqual(refKeys);
  for (const key of engineKeys) {
    const eng = engineMap.get(key)!;
    const ref = referenceMap.get(key)!;
    const delta = eng >= ref ? eng - ref : ref - eng;
    expect(delta, `${label}: delta for ${key} must be 0 (got engine=${eng}, ref=${ref})`).toBe(0n);
  }
}

// ── A. Sprint-0 trivial fixtures (no DB) ─────────────────────────────────────

describe('A. Sprint-0 trivial fixtures (in-memory scaffold, EC9)', () => {

  it('Sprint-0 golden fixtures all PASS (TS value matches independent reference)', () => {
    const { passed, failed, results } = runGoldenFixtures(SPRINT_0_FIXTURES);
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
    const driftedFixture: GoldenFixture = {
      name: 'drifted_metric',
      brandId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      metricId: 'event_count_total',
      expectedValueMinor: 3n,
      asOf: '2026-06-15',
      tsComputedValueMinor: 4n,    // TS returned 4 (WRONG — off by 1)
      referenceValueMinor: 3n,     // Reference says 3 (correct)
      toleranceMinor: 0n,
    };
    const result = checkParity(driftedFixture);
    expect(result.passed).toBe(false);
    expect(result.delta).toBe(1n);
    expect(result.message).toContain('FAIL');
  });

  it('[I-S07] financial metric fixtures must have toleranceMinor = 0n (no float tolerance)', () => {
    const financialFixtures = SPRINT_0_FIXTURES.filter(f =>
      f.metricId.includes('_minor') || f.metricId.includes('gmv') || f.metricId.includes('revenue')
    );
    for (const fixture of financialFixtures) {
      expect(fixture.toleranceMinor).toBe(0n);
    }
  });

  it('all Sprint-0 fixtures are tenant-keyed (brand_id present)', () => {
    for (const fixture of SPRINT_0_FIXTURES) {
      expect(fixture.brandId).toBeTruthy();
      expect(fixture.brandId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});

// ── B. Live parity tests — the CI gate (engine == independent SQL on gold) ───

describe('B. Live parity — engine == independent SQL on all golden fixtures (gold ledger, tolerance 0)', () => {
  const AS_OF = '2026-06-17';

  afterEach(async () => {
    await clearGold(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  // ── Fixture 1: clean_finalized ────────────────────────────────────────────

  it('[F1] clean_finalized: 1 finalization row → realized={INR:50000n}; engine==reference', async () => {
    if (!srUp) return;
    await seedFinalized(BRAND_PARITY_A, `order-f1-${randomUUID()}`, 50000n, 'INR', AS_OF);

    const engineMap = await computeRealizedRevenue(BRAND_PARITY_A, new Date(AS_OF), deps());
    const refMap = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, srPool);

    // Parity assertion: per-currency equality, tolerance 0
    assertMapsEqual(engineMap, refMap, 'clean_finalized');

    // Explicit value assertions
    expect(engineMap.get('INR')).toBe(50000n);
    expect(refMap.get('INR')).toBe(50000n);

    console.info('[parity-oracle] F1 clean_finalized: engine={INR:%s} ref={INR:%s}',
      engineMap.get('INR'), refMap.get('INR'));
  });

  // ── Fixture 2: full_rto_to_zero ───────────────────────────────────────────

  it('[F2] full_rto_to_zero: finalization+rto_reversal → realized={INR:0n}; engine==reference', async () => {
    if (!srUp) return;
    const orderId = `order-f2-${randomUUID()}`;
    // finalization: +50000
    await seedFinalized(BRAND_PARITY_A, orderId, 50000n, 'INR', AS_OF);
    // rto_reversal: -50000 (nets to 0) — still recognition_label='finalized'
    await seedFinalizedAdjustment(BRAND_PARITY_A, orderId, 'rto_reversal', -50000n, 'INR', AS_OF);

    const engineMap = await computeRealizedRevenue(BRAND_PARITY_A, new Date(AS_OF), deps());
    const refMap = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, srPool);

    assertMapsEqual(engineMap, refMap, 'full_rto_to_zero');
    expect(engineMap.get('INR')).toBe(0n);
    expect(refMap.get('INR')).toBe(0n);

    console.info('[parity-oracle] F2 full_rto_to_zero: engine={INR:%s} ref={INR:%s}',
      engineMap.get('INR'), refMap.get('INR'));
  });

  // ── Fixture 3: partial_refund ─────────────────────────────────────────────

  it('[F3] partial_refund: finalization+refund → realized={INR:35000n}; engine==reference', async () => {
    if (!srUp) return;
    const orderId = `order-f3-${randomUUID()}`;
    await seedFinalized(BRAND_PARITY_A, orderId, 50000n, 'INR', AS_OF);
    // refund: -15000 (partial clawback → 50000 - 15000 = 35000)
    await seedFinalizedAdjustment(BRAND_PARITY_A, orderId, 'refund', -15000n, 'INR', AS_OF);

    const engineMap = await computeRealizedRevenue(BRAND_PARITY_A, new Date(AS_OF), deps());
    const refMap = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, srPool);

    assertMapsEqual(engineMap, refMap, 'partial_refund');
    expect(engineMap.get('INR')).toBe(35000n);
    expect(refMap.get('INR')).toBe(35000n);

    console.info('[parity-oracle] F3 partial_refund: engine={INR:%s} ref={INR:%s}',
      engineMap.get('INR'), refMap.get('INR'));
  });

  // ── Fixture 4: provisional_plus_finalized (provisional NEVER blended into realized) ──

  it('[F4] provisional_plus_finalized: provisional rows NOT counted in realized; provisional map correct', async () => {
    if (!srUp) return;
    const orderId = `order-f4-${randomUUID()}`;
    // provisional row: +20000 (must NOT appear in realized)
    await seedProvisional(BRAND_PARITY_A, orderId, 20000n, 'INR', AS_OF);
    // finalization row: +50000 (IS realized)
    await seedFinalized(BRAND_PARITY_A, `${orderId}-final`, 50000n, 'INR', AS_OF);

    const engineRealized = await computeRealizedRevenue(BRAND_PARITY_A, new Date(AS_OF), deps());
    const engineProvisional = await computeProvisionalRevenue(BRAND_PARITY_A, new Date(AS_OF), deps());

    const refRealized = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, srPool);
    const refProvisional = await getIndependentReferenceProvisional(BRAND_PARITY_A, AS_OF, srPool);

    // Realized: only finalized row counted (provisional NOT counted)
    assertMapsEqual(engineRealized, refRealized, 'provisional_plus_finalized/realized');
    expect(engineRealized.get('INR')).toBe(50000n);  // only finalization
    expect(refRealized.get('INR')).toBe(50000n);     // only finalization

    // Provisional: only provisional row
    assertMapsEqual(engineProvisional, refProvisional, 'provisional_plus_finalized/provisional');
    expect(engineProvisional.get('INR')).toBe(20000n);
    expect(refProvisional.get('INR')).toBe(20000n);

    // INVARIANT: adding provisional rows does NOT move the realized number
    expect(engineRealized.get('INR')).not.toBe(70000n); // 50000+20000 would be blend VIOLATION

    console.info('[parity-oracle] F4 provisional_plus_finalized: realized={INR:%s} prov={INR:%s}',
      engineRealized.get('INR'), engineProvisional.get('INR'));
  });

  // ── Fixture 5: two_brand_two_currency (per-currency, no blend) ───────────

  it('[F5] two_brand_two_currency: Brand A=INR, Brand B=AED → separate maps, no cross-brand blend', async () => {
    if (!srUp) return;
    // Brand A (INR): finalization +50000
    await seedFinalized(BRAND_PARITY_A, `order-f5a-${randomUUID()}`, 50000n, 'INR', AS_OF);
    // Brand B (AED): finalization +30000
    await seedFinalized(BRAND_PARITY_B, `order-f5b-${randomUUID()}`, 30000n, 'AED', AS_OF);

    const engineA = await computeRealizedRevenue(BRAND_PARITY_A, new Date(AS_OF), deps());
    const engineB = await computeRealizedRevenue(BRAND_PARITY_B, new Date(AS_OF), deps());

    const refA = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, srPool);
    const refB = await getIndependentReferenceRevenue(BRAND_PARITY_B, AS_OF, srPool);

    // Per-currency parity for each brand
    assertMapsEqual(engineA, refA, 'two_brand_two_currency/BrandA');
    assertMapsEqual(engineB, refB, 'two_brand_two_currency/BrandB');

    // Brand A only has INR; Brand B only has AED — no cross-brand blend
    expect(engineA.get('INR')).toBe(50000n);
    expect(engineA.has('AED')).toBe(false);  // Brand A has no AED
    expect(engineB.get('AED')).toBe(30000n);
    expect(engineB.has('INR')).toBe(false);  // Brand B has no INR

    // Cross-brand check: Brand B rows not visible to Brand A engine
    expect([...engineA.values()].reduce((a, b) => a + b, 0n)).toBe(50000n); // only INR
    expect([...engineB.values()].reduce((a, b) => a + b, 0n)).toBe(30000n); // only AED

    console.info('[parity-oracle] F5 two_brand_two_currency: A={INR:%s} B={AED:%s}',
      engineA.get('INR'), engineB.get('AED'));
  });

});

// ── C. RED PROOF — 1-minor perturbation FAILS the parity gate ────────────────

describe('C. RED PROOF — 1-minor perturbation fails the parity gate (non-tautological)', () => {

  it('[RED-PROOF] engine off by +1 minor unit → parity FAILS (gate is real, not tautological)', () => {
    // This test simulates what would happen if the engine returned a value
    // that is 1 minor unit off from the independent reference.
    //
    // We do NOT call the real engine here — we construct the drift directly.
    // The RED PROOF is: the checkParity function (with tolerance 0) FAILS on
    // any 1-minor-unit delta. The live-DB tests above already use the real engine
    // and real reference to prove GREEN — this test proves the gate would go RED.

    const referenceValue = 50000n; // what the independent SQL says
    const engineValueDrifted = 50001n; // engine off by +1 minor unit (simulated bug)

    const driftedFixture: GoldenFixture = {
      name: 'red_proof_1_minor_delta',
      brandId: BRAND_PARITY_A,
      metricId: 'realized_revenue',
      expectedValueMinor: referenceValue,
      asOf: '2026-06-17',
      tsComputedValueMinor: engineValueDrifted,
      referenceValueMinor: referenceValue,
      toleranceMinor: 0n, // tolerance=0 → any delta FAILS
    };

    const result = checkParity(driftedFixture);

    // MUST FAIL: any delta ≥ 1 minor unit with tolerance=0 is a parity failure
    expect(result.passed).toBe(false);
    expect(result.delta).toBe(1n);
    expect(result.message).toContain('FAIL');
    console.info('[parity-oracle] RED PROOF captured:', result.message);

    // Confirm that reverting to the correct value → PASS
    const correctFixture: GoldenFixture = {
      ...driftedFixture,
      name: 'red_proof_reverted_green',
      tsComputedValueMinor: referenceValue, // correct value restored
    };
    const revertedResult = checkParity(correctFixture);
    expect(revertedResult.passed).toBe(true);
    expect(revertedResult.delta).toBe(0n);
    console.info('[parity-oracle] RED PROOF reverted to GREEN:', revertedResult.message);
  });
});

// ── D. Isolation — cross-brand invisible at the Silver seam ──────────────────

describe('D. Isolation at the Silver seam (BRAND_PREDICATE, I-S01)', () => {

  afterEach(async () => {
    await clearGold(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  it('[ISO-1] cross-brand seam blocks Brand B from seeing Brand A rows (active block, not absence-of-data)', async () => {
    if (!srUp) return;
    // Seed Brand A (INR) rows — these must NOT be visible to Brand B's engine call.
    // This proves the seam BRAND_PREDICATE actively blocks cross-brand reads, not
    // just that there are no rows.
    await seedFinalized(BRAND_PARITY_A, `order-iso1-a1-${randomUUID()}`, 75000n, 'INR', '2026-06-17');
    await seedFinalized(BRAND_PARITY_A, `order-iso1-a2-${randomUUID()}`, 25000n, 'INR', '2026-06-17');

    // Also seed Brand B (AED) rows — proves Brand B can see its OWN rows (non-degenerate).
    await seedFinalized(BRAND_PARITY_B, `order-iso1-b1-${randomUUID()}`, 30000n, 'AED', '2026-06-17');

    // Run the engine as Brand B: the Silver seam injects brand_id = BRAND_PARITY_B.
    // Brand A has 100000n INR in the gold ledger. The seam must prevent Brand B from seeing it.
    const engineForB = await computeRealizedRevenue(BRAND_PARITY_B, new Date('2026-06-17'), deps());

    // Brand B must NOT see Brand A's INR (100000n seeded above would appear if the
    // seam predicate were removed). The engine map carries only Brand B's own currency.
    expect(engineForB.get('INR') ?? 0n).toBe(0n);
    expect(engineForB.get('AED')).toBe(30000n);

    // Symmetry: run engine as Brand A — must NOT see Brand B's AED rows.
    const engineForA = await computeRealizedRevenue(BRAND_PARITY_A, new Date('2026-06-17'), deps());
    expect(engineForA.get('AED') ?? 0n).toBe(0n);
    // Brand A sees its own INR rows (75000 + 25000).
    expect(engineForA.get('INR')).toBe(100000n);
  });
});

// ── E. Per-currency no-blend ──────────────────────────────────────────────────

describe('E. Per-currency no-blend invariant', () => {

  afterEach(async () => {
    await clearGold(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  it('[PER-CURRENCY] engine map keys are currency codes; no cross-currency blend', async () => {
    if (!srUp) return;
    await seedFinalized(BRAND_PARITY_A, `order-pc-${randomUUID()}`, 50000n, 'INR', '2026-06-17');

    const engineMap = await computeRealizedRevenue(BRAND_PARITY_A, new Date('2026-06-17'), deps());

    // Map has exactly 1 key (INR); no AED/SAR blended in
    expect(engineMap.size).toBe(1);
    expect(engineMap.has('INR')).toBe(true);
    expect(engineMap.has('AED')).toBe(false);
    expect(engineMap.has('SAR')).toBe(false);

    // The value is exact bigint — no float accumulation
    const val = engineMap.get('INR')!;
    expect(typeof val).toBe('bigint');
    expect(val).toBe(50000n);
  });
});

// ── F. Provisional never blended into realized ───────────────────────────────

describe('F. Provisional NEVER blended into realized (D-4)', () => {

  afterEach(async () => {
    await clearGold(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  it('[NO-BLEND] adding provisional rows does NOT move realized_revenue map', async () => {
    if (!srUp) return;
    const baseOrderId = `order-noblend-${randomUUID()}`;
    await seedFinalized(BRAND_PARITY_A, baseOrderId, 50000n, 'INR', '2026-06-17');

    // Baseline realized (no provisional rows)
    const realizedBefore = await computeRealizedRevenue(BRAND_PARITY_A, new Date('2026-06-17'), deps());
    expect(realizedBefore.get('INR')).toBe(50000n);

    // Add provisional rows
    await seedProvisional(BRAND_PARITY_A, `${baseOrderId}-prov1`, 20000n, 'INR', '2026-06-17');
    await seedProvisional(BRAND_PARITY_A, `${baseOrderId}-prov2`, 10000n, 'INR', '2026-06-17');

    // Realized MUST NOT change after provisional rows are added
    const realizedAfter = await computeRealizedRevenue(BRAND_PARITY_A, new Date('2026-06-17'), deps());
    expect(realizedAfter.get('INR')).toBe(50000n); // unchanged

    // Provisional map shows the provisional rows
    const provisionalMap = await computeProvisionalRevenue(BRAND_PARITY_A, new Date('2026-06-17'), deps());
    expect(provisionalMap.get('INR')).toBe(30000n); // 20000 + 10000

    // Confirm: realized + provisional are disjoint (no double-count)
    expect(realizedAfter.get('INR')! + provisionalMap.get('INR')!).toBe(80000n); // sum OK
    expect(realizedAfter.get('INR')).not.toBe(80000n); // realized alone is NOT the sum
  });
});
