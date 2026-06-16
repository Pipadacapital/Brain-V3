/**
 * parity-oracle/parity.test.ts — M1 parity gate (EC9, D-2)
 *
 * TWO classes of tests:
 *
 * A. Sprint-0 trivial fixtures (in-memory, no DB) — backward-compat EC9 scaffold.
 * B. M1 live-DB parity tests — the actual CI gate:
 *    For each golden fixture, seed the ledger, run BOTH:
 *      - The engine (computeRealizedRevenue / computeProvisionalRevenue)
 *      - The independent reference SQL (getIndependentReferenceRevenue)
 *    Assert EQUAL per-currency with toleranceMinor=0 (a 1-minor delta FAILS).
 *
 * NON-TAUTOLOGICAL PROOF:
 *   The reference uses recognition_label='finalized' (realized) or IN('provisional','settling')
 *   The engine uses realized_gmv_as_of() which filters event_type<>'provisional_recognition'
 *   These are structurally different predicates. A bug in either path causes a delta.
 *
 * RED PROOF (negative control):
 *   A deliberately perturbed engine value (off by 1 minor unit) causes this test to FAIL.
 *   This proves the gate is real — not tautological.
 *
 * REQUIRES: Postgres on localhost:5432, migrations through 0020 applied.
 * POOLS: superuser (brain) for DDL/seed; brain_app for engine reads + isolation assertions.
 * NEVER run isolation assertions as superuser — superuser bypasses RLS (MEMORY.md).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
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

// ── Config ────────────────────────────────────────────────────────────────────

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

// Deterministic test brand UUIDs (scoped to parity oracle tests, valid UUID v4 format)
const BRAND_PARITY_A = 'a0200020-0020-4020-8020-000000000001'; // INR
const BRAND_PARITY_B = 'b0200020-0020-4020-8020-000000000002'; // AED

let superPool: pg.Pool;
let appPool: pg.Pool;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function clearLedgerRows(...brandIds: string[]): Promise<void> {
  for (const brandId of brandIds) {
    await superPool.query(
      `DELETE FROM realized_revenue_ledger WHERE brand_id = $1`,
      [brandId],
    );
  }
}

async function seedFinalized(
  brandId: string,
  orderId: string,
  amountMinor: bigint,
  currencyCode: string,
  asOf: string,
): Promise<void> {
  await superPool.query(
    `INSERT INTO realized_revenue_ledger (
       brand_id, ledger_event_id, order_id, event_type,
       amount_minor, currency_code, rounding_adjustment_minor,
       occurred_at, economic_effective_at, billing_posted_period,
       recognition_label
     ) VALUES (
       $1, $2, $3, 'finalization',
       $4, $5, 0,
       $6::date, $6::date, to_char($6::date, 'YYYY-MM'),
       'finalized'
     )`,
    [brandId, randomUUID(), orderId, amountMinor.toString(), currencyCode, asOf],
  );
}

async function seedProvisional(
  brandId: string,
  orderId: string,
  amountMinor: bigint,
  currencyCode: string,
  asOf: string,
): Promise<void> {
  await superPool.query(
    `INSERT INTO realized_revenue_ledger (
       brand_id, ledger_event_id, order_id, event_type,
       amount_minor, currency_code, rounding_adjustment_minor,
       occurred_at, economic_effective_at, billing_posted_period,
       recognition_label
     ) VALUES (
       $1, $2, $3, 'provisional_recognition',
       $4, $5, 0,
       $6::date, $6::date, to_char($6::date, 'YYYY-MM'),
       'provisional'
     )`,
    [brandId, randomUUID(), orderId, amountMinor.toString(), currencyCode, asOf],
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });

  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');

  const existingOrg = await superPool.query<{ id: string }>(
    `SELECT id FROM organization LIMIT 1`,
  );
  const useOrgId = existingOrg.rows[0]?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  // Upsert Brand A (INR)
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
     VALUES ($1, $2, 'Parity Test Brand A (INR)', 'INR', 'active')
     ON CONFLICT (id) DO UPDATE SET currency_code = 'INR', status = 'active'`,
    [BRAND_PARITY_A, useOrgId],
  );

  // Upsert Brand B (AED)
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
     VALUES ($1, $2, 'Parity Test Brand B (AED)', 'AED', 'active')
     ON CONFLICT (id) DO UPDATE SET currency_code = 'AED', status = 'active'`,
    [BRAND_PARITY_B, useOrgId],
  );

  await clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B);
});

afterAll(async () => {
  await clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B);
  await superPool.end().catch(() => {});
  await appPool.end().catch(() => {});
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

// ── B. M1 Live-DB parity tests — the CI gate ─────────────────────────────────

describe('B. M1 live-DB parity — engine == independent SQL on all golden fixtures (tolerance 0)', () => {
  const AS_OF = '2026-06-17';

  afterEach(async () => {
    await clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  // ── Fixture 1: clean_finalized ────────────────────────────────────────────

  it('[F1] clean_finalized: 1 finalization row → realized={INR:50000n}; engine==reference', async () => {
    await seedFinalized(BRAND_PARITY_A, `order-f1-${randomUUID()}`, 50000n, 'INR', AS_OF);

    const engineMap = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date(AS_OF), { pool: appPool },
    );

    const client = await appPool.connect();
    let refMap: Map<string, bigint>;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_PARITY_A]);
      refMap = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

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
    const orderId = `order-f2-${randomUUID()}`;
    // finalization: +50000
    await seedFinalized(BRAND_PARITY_A, orderId, 50000n, 'INR', AS_OF);
    // rto_reversal: -50000 (nets to 0)
    await superPool.query(
      `INSERT INTO realized_revenue_ledger (
         brand_id, ledger_event_id, order_id, event_type,
         amount_minor, currency_code, rounding_adjustment_minor,
         occurred_at, economic_effective_at, billing_posted_period,
         recognition_label
       ) VALUES ($1, $2, $3, 'rto_reversal', -50000, 'INR', 0, $4::date, $4::date, to_char($4::date,'YYYY-MM'), 'finalized')`,
      [BRAND_PARITY_A, randomUUID(), orderId, AS_OF],
    );

    const engineMap = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date(AS_OF), { pool: appPool },
    );

    const client = await appPool.connect();
    let refMap: Map<string, bigint>;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_PARITY_A]);
      refMap = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    assertMapsEqual(engineMap, refMap, 'full_rto_to_zero');
    expect(engineMap.get('INR')).toBe(0n);
    expect(refMap.get('INR')).toBe(0n);

    console.info('[parity-oracle] F2 full_rto_to_zero: engine={INR:%s} ref={INR:%s}',
      engineMap.get('INR'), refMap.get('INR'));
  });

  // ── Fixture 3: partial_refund ─────────────────────────────────────────────

  it('[F3] partial_refund: finalization+refund → realized={INR:35000n}; engine==reference', async () => {
    const orderId = `order-f3-${randomUUID()}`;
    await seedFinalized(BRAND_PARITY_A, orderId, 50000n, 'INR', AS_OF);
    // refund: -15000 (partial clawback → 50000 - 15000 = 35000)
    await superPool.query(
      `INSERT INTO realized_revenue_ledger (
         brand_id, ledger_event_id, order_id, event_type,
         amount_minor, currency_code, rounding_adjustment_minor,
         occurred_at, economic_effective_at, billing_posted_period,
         recognition_label
       ) VALUES ($1, $2, $3, 'refund', -15000, 'INR', 0, $4::date, $4::date, to_char($4::date,'YYYY-MM'), 'finalized')`,
      [BRAND_PARITY_A, randomUUID(), orderId, AS_OF],
    );

    const engineMap = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date(AS_OF), { pool: appPool },
    );

    const client = await appPool.connect();
    let refMap: Map<string, bigint>;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_PARITY_A]);
      refMap = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    assertMapsEqual(engineMap, refMap, 'partial_refund');
    expect(engineMap.get('INR')).toBe(35000n);
    expect(refMap.get('INR')).toBe(35000n);

    console.info('[parity-oracle] F3 partial_refund: engine={INR:%s} ref={INR:%s}',
      engineMap.get('INR'), refMap.get('INR'));
  });

  // ── Fixture 4: provisional_plus_finalized (provisional NEVER blended into realized) ──

  it('[F4] provisional_plus_finalized: provisional rows NOT counted in realized; provisional map correct', async () => {
    const orderId = `order-f4-${randomUUID()}`;
    // provisional row: +20000 (must NOT appear in realized)
    await seedProvisional(BRAND_PARITY_A, orderId, 20000n, 'INR', AS_OF);
    // finalization row: +50000 (IS realized)
    await seedFinalized(BRAND_PARITY_A, `${orderId}-final`, 50000n, 'INR', AS_OF);

    const engineRealized = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date(AS_OF), { pool: appPool },
    );
    const engineProvisional = await computeProvisionalRevenue(
      BRAND_PARITY_A, new Date(AS_OF), { pool: appPool },
    );

    const client = await appPool.connect();
    let refRealized: Map<string, bigint>;
    let refProvisional: Map<string, bigint>;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_PARITY_A]);
      refRealized = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, client);
      refProvisional = await getIndependentReferenceProvisional(BRAND_PARITY_A, AS_OF, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

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
    // Brand A (INR): finalization +50000
    await seedFinalized(BRAND_PARITY_A, `order-f5a-${randomUUID()}`, 50000n, 'INR', AS_OF);
    // Brand B (AED): finalization +30000
    await seedFinalized(BRAND_PARITY_B, `order-f5b-${randomUUID()}`, 30000n, 'AED', AS_OF);

    const engineA = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date(AS_OF), { pool: appPool },
    );
    const engineB = await computeRealizedRevenue(
      BRAND_PARITY_B, new Date(AS_OF), { pool: appPool },
    );

    const clientA = await appPool.connect();
    let refA: Map<string, bigint>;
    try {
      await clientA.query('BEGIN');
      await clientA.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_PARITY_A]);
      refA = await getIndependentReferenceRevenue(BRAND_PARITY_A, AS_OF, clientA);
      await clientA.query('COMMIT');
    } catch (e) {
      await clientA.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      clientA.release();
    }

    const clientB = await appPool.connect();
    let refB: Map<string, bigint>;
    try {
      await clientB.query('BEGIN');
      await clientB.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_PARITY_B]);
      refB = await getIndependentReferenceRevenue(BRAND_PARITY_B, AS_OF, clientB);
      await clientB.query('COMMIT');
    } catch (e) {
      await clientB.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      clientB.release();
    }

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

// ── D. Isolation negative-control under brain_app ────────────────────────────

describe('D. Isolation under brain_app (I-S01, F-SEC-02)', () => {

  afterEach(async () => {
    await clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  it('[ISO-1] current_user is brain_app (non-superuser, non-bypassrls)', async () => {
    const r = await appPool.query<{ current_user: string; is_superuser: boolean }>(
      `SELECT current_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
    );
    expect(r.rows[0]?.current_user).toBe('brain_app');
    expect(r.rows[0]?.is_superuser).toBe(false);
  });

  it('[ISO-2] cross-brand RLS actively blocks Brand B from seeing Brand A rows (not just absence-of-data)', async () => {
    // Seed Brand A (INR) rows — these must NOT be visible to Brand B's engine call.
    // This proves RLS actively blocks cross-brand reads, not just that there are no rows.
    await seedFinalized(BRAND_PARITY_A, `order-iso2-a1-${randomUUID()}`, 75000n, 'INR', '2026-06-17');
    await seedFinalized(BRAND_PARITY_A, `order-iso2-a2-${randomUUID()}`, 25000n, 'INR', '2026-06-17');

    // Also seed Brand B (AED) rows — proves Brand B can see its OWN rows (non-degenerate).
    await seedFinalized(BRAND_PARITY_B, `order-iso2-b1-${randomUUID()}`, 30000n, 'AED', '2026-06-17');

    // Run the engine as Brand B: the GUC is set to BRAND_PARITY_B.
    // Brand A has 100000n INR in the ledger. RLS must prevent Brand B from seeing it.
    const engineForB = await computeRealizedRevenue(
      BRAND_PARITY_B, new Date('2026-06-17'), { pool: appPool },
    );

    // Brand B must see 0 INR — RLS blocked Brand A's rows entirely (not absence-of-data:
    // Brand A has 100000n INR seeded above which would appear here if RLS were removed).
    const inrUnderBrandB = engineForB.get('INR') ?? 0n;
    expect(inrUnderBrandB).toBe(0n);

    // Brand B does see its own AED rows (proves the assertion is non-degenerate).
    expect(engineForB.get('AED')).toBe(30000n);

    // Symmetry: run engine as Brand A — must NOT see Brand B's AED rows.
    const engineForA = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date('2026-06-17'), { pool: appPool },
    );
    const aedUnderBrandA = engineForA.get('AED') ?? 0n;
    expect(aedUnderBrandA).toBe(0n);
    // Brand A sees its own INR rows.
    expect(engineForA.get('INR')).toBe(100000n);
  });

  it('[ISO-3] no-GUC → function returns fail-closed (0 rows via RLS)', async () => {
    // Seed a row for Brand A
    await seedFinalized(BRAND_PARITY_A, `order-noguc-${randomUUID()}`, 99999n, 'INR', '2026-06-17');

    // Attempt to read without GUC set → RLS fail-closed → 0 rows
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      // Set GUC to empty string → RLS policy: ''::uuid → error or 0 rows
      await client.query("SELECT set_config('app.current_brand_id', '', true)");

      let cnt = 0n;
      try {
        const r = await client.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM realized_revenue_ledger`,
        );
        cnt = BigInt(r.rows[0]!.cnt);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (!errMsg.includes('invalid input syntax for type uuid')) throw e;
        // Expected: fail-closed behavior (empty GUC → UUID cast error → access denied)
        await client.query('ROLLBACK').catch(() => {});
        return;
      }
      await client.query('COMMIT');
      expect(cnt).toBe(0n); // RLS filtered all rows
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
      await clearLedgerRows(BRAND_PARITY_A);
    }
  });
});

// ── E. Per-currency no-blend ──────────────────────────────────────────────────

describe('E. Per-currency no-blend invariant', () => {

  afterEach(async () => {
    await clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  it('[PER-CURRENCY] engine map keys are currency codes; no cross-currency blend', async () => {
    await seedFinalized(BRAND_PARITY_A, `order-pc-${randomUUID()}`, 50000n, 'INR', '2026-06-17');

    const engineMap = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date('2026-06-17'), { pool: appPool },
    );

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
    await clearLedgerRows(BRAND_PARITY_A, BRAND_PARITY_B);
  });

  it('[NO-BLEND] adding provisional rows does NOT move realized_revenue map', async () => {
    const baseOrderId = `order-noblend-${randomUUID()}`;
    await seedFinalized(BRAND_PARITY_A, baseOrderId, 50000n, 'INR', '2026-06-17');

    // Baseline realized (no provisional rows)
    const realizedBefore = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date('2026-06-17'), { pool: appPool },
    );
    expect(realizedBefore.get('INR')).toBe(50000n);

    // Add provisional rows
    await seedProvisional(BRAND_PARITY_A, `${baseOrderId}-prov1`, 20000n, 'INR', '2026-06-17');
    await seedProvisional(BRAND_PARITY_A, `${baseOrderId}-prov2`, 10000n, 'INR', '2026-06-17');

    // Realized MUST NOT change after provisional rows are added
    const realizedAfter = await computeRealizedRevenue(
      BRAND_PARITY_A, new Date('2026-06-17'), { pool: appPool },
    );
    expect(realizedAfter.get('INR')).toBe(50000n); // unchanged

    // Provisional map shows the provisional rows
    const provisionalMap = await computeProvisionalRevenue(
      BRAND_PARITY_A, new Date('2026-06-17'), { pool: appPool },
    );
    expect(provisionalMap.get('INR')).toBe(30000n); // 20000 + 10000

    // Confirm: realized + provisional are disjoint (no double-count)
    expect(realizedAfter.get('INR')! + provisionalMap.get('INR')!).toBe(80000n); // sum OK
    expect(realizedAfter.get('INR')).not.toBe(80000n); // realized alone is NOT the sum
  });
});
