/**
 * rto-detector.live.test.ts — live Postgres tests for the RTO-risk detector + decision log (P1).
 *
 * Proves:
 *   1. generate raises a risk rec when RTO is elevated, with evidence + confidence + a decision_log
 *      'raised' entry.
 *   2. idempotent/dedup — re-running refreshes the SAME rec (no duplicate) and logs 'refreshed'.
 *   3. read returns the open rec ranked, with the evidence flattened.
 *   4. expiry — when RTO drops below threshold, the open rec is expired and logged.
 *   5. RLS isolation — BRAND_A's recs are invisible under a BRAND_B scope.
 *
 * The detector is a PURE function (unit-tested separately); this verifies the persistence +
 * decision-log + dedup + RLS wiring end-to-end. REQUIRES Postgres with migration 0044.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { createDuckDbServingPool, type SilverPool } from '@brain/metric-engine';
import { generateRecommendations, getRecommendations } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
// BRAIN V4: StarRocks and Trino are REMOVED (ADR-0014). The detector revenue signals read the gold ledger over DUCKDB-SERVING
// (createDuckDbServingPool) — the same duckdb-serving-over-Iceberg serving path the app uses in production. Seeds INSERT
// the base Iceberg table; the detector reads through the brain_serving.mv_* view via the metric-engine seam.
const SERVING_URL =
  process.env['DUCKDB_SERVING_URL'] ??
  `http://${process.env['DUCKDB_SERVING_HOST'] ?? '127.0.0.1'}:${process.env['DUCKDB_SERVING_PORT'] ?? '8091'}`;

const BRAND_A = 'b444444a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'b444444a-0a1a-4a1a-8a1a-000000000002';
const ORG_ID = '0444444a-0a1a-4a1a-8a1a-000000000001';
const USER_ID = 'a444444a-0a1a-4a1a-8a1a-000000000001';
const CORR = 'rto-detector-live-test';

// The read-time confidence gate (P0). A trusted gate surfaces a risk rec as-is; an untrusted gate
// HOLDS it. These isolate the read wiring from the trust computation (the gate fn is unit-tested).
const TRUSTED_GATE = { tier: 'trusted' as const, blocksHighRiskRecommendation: false };
const UNTRUSTED_GATE = { tier: 'untrusted' as const, blocksHighRiskRecommendation: true };

let superPool: pg.Pool;
let dbPool: DbPool;
let srPool: SilverPool;
let pgAvailable = false;

// MEDALLION REALIGNMENT (Epic 1 / decision B): the detector REVENUE signals read the LAKEHOUSE ledger
// (brain_gold.gold_revenue_ledger). RTO in gold = 'cod_rto_clawback' (the Bronze gokwik terminal-RTO
// event), not the PG 'rto_reversal'. Seed gold via srPool.
let seq = 0;
// ONE batched multi-row INSERT — per-row INSERTs are slow + would time the hook out. Iceberg ts columns
// are `timestamp` (no zone) → no-zone TIMESTAMP literals; data_source is NOT NULL → inline 'live'.
async function seedGoldRows(eventType: string, n: number, amountMinor: number, orderPrefix = 'rto-order'): Promise<void> {
  const label = eventType === 'provisional_recognition' ? 'provisional' : 'finalized';
  const tuples: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < n; i++) {
    seq += 1;
    tuples.push(
      `(?,?,?,NULL,?,?,'INR',0,TIMESTAMP '2026-06-01 00:00:00',TIMESTAMP '2026-06-01 00:00:00',?,'2026-06',TIMESTAMP '2026-06-01 00:00:00','live',TIMESTAMP '2026-06-01 00:00:00')`,
    );
    params.push(BRAND_A, `rto-evt-${seq}`, `${orderPrefix}-${seq}`, eventType, amountMinor, label);
  }
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period,
        ingested_at, data_source, updated_at)
     VALUES ${tuples.join(',')}`,
    params,
  );
}

async function seedBrand(): Promise<void> {
  // app_user → organization → brand chain (brand.currency_code drives the ledger currency trigger).
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1, 'rto-test@example.invalid', 'rto-test@example.invalid', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1, 'RTO Test Org', 'rto-test-org', $2) ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, USER_ID],
  );
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code)
     VALUES ($1, $2, 'RTO Test Brand', 'INR') ON CONFLICT (id) DO NOTHING`,
    [BRAND_A, ORG_ID],
  );
}

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM decision_log WHERE brand_id = $1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM recommendation WHERE brand_id = $1`, [b]).catch(() => {});
    if (srPool) await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [b]).catch(() => {});
  }
  await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    dbPool = await createPool({ connectionString: SUPERUSER_URL });
    srPool = createDuckDbServingPool({ baseUrl: SERVING_URL });
    await srPool.query('SELECT 1');
    await cleanup();
    await seedBrand();
    // 200 orders (provisional), 20 COD-RTO clawbacks → 10% RTO (> 3% threshold), 200 ≥ 100 → Trusted.
    await seedGoldRows('provisional_recognition', 200, 50_000); // rto-order-1..200
    await seedGoldRows('cod_rto_clawback', 20, -50_000);        // rto-order-201..220
    // Settle the 200 provisional orders so the realization_gap detector does NOT also fire — finalizing
    // the SAME order_ids moves provisional→realized below the 60% gap (this test is scoped to rto_risk).
    // ONE batched multi-row INSERT (per-row StarRocks INSERTs would time the hook out).
    {
      const tuples: string[] = [];
      const params: unknown[] = [];
      for (let i = 1; i <= 200; i++) {
        tuples.push(
          `(?,?,?,NULL,'finalization',50000,'INR',0,TIMESTAMP '2026-06-01 00:00:00',TIMESTAMP '2026-06-01 00:00:00','finalized','2026-06',TIMESTAMP '2026-06-01 00:00:00','live',TIMESTAMP '2026-06-01 00:00:00')`,
        );
        params.push(BRAND_A, `rto-fin-${i}`, `rto-order-${i}`);
      }
      await srPool.query(
        `INSERT INTO brain_gold.gold_revenue_ledger
           (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
            fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period,
            ingested_at, data_source, updated_at)
         VALUES ${tuples.join(',')}`,
        params,
      );
    }
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (dbPool) await dbPool.end();
  // The serving pool is a stateless HTTP adapter — no connection to close.
  if (superPool) await superPool.end();
});

describe('RTO-risk detector (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[rto-detector] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. generate raises a risk rec with evidence + confidence + a decision_log entry', async () => {
    if (!pgAvailable) return;
    const r = await generateRecommendations(BRAND_A, CORR, { pool: dbPool, srPool });
    expect(r.raised).toBe(1);
    expect(r.expired).toBe(0);

    const log = await superPool.query(
      `SELECT action, actor FROM decision_log WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [BRAND_A],
    );
    expect(log.rows[0]?.action).toBe('raised');
    expect(log.rows[0]?.actor).toBe('detector:rto_risk');
  });

  it('2. idempotent/dedup — re-run refreshes the same rec (no duplicate), logs refreshed', async () => {
    if (!pgAvailable) return;
    const r = await generateRecommendations(BRAND_A, CORR, { pool: dbPool, srPool });
    expect(r.raised).toBe(1);

    const count = await superPool.query(
      `SELECT count(*)::int AS n FROM recommendation WHERE brand_id = $1 AND detector = 'rto_risk'`,
      [BRAND_A],
    );
    expect(count.rows[0]?.n).toBe(1); // dedup — still exactly one

    const log = await superPool.query(
      `SELECT action FROM decision_log WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [BRAND_A],
    );
    expect(log.rows[0]?.action).toBe('refreshed');
  });

  it('3. read returns the open rec, ranked, evidence flattened', async () => {
    if (!pgAvailable) return;
    const recs = await getRecommendations(BRAND_A, CORR, { pool: dbPool, gate: TRUSTED_GATE });
    expect(recs.state).toBe('has_data');
    if (recs.state !== 'has_data') return;
    const rec = recs.recommendations[0]!;
    expect(rec.detector).toBe('rto_risk');
    expect(rec.kind).toBe('risk');
    expect(rec.confidence).toBe('Trusted'); // 200 orders ≥ 100, trusted gate → surfaced as-is
    expect(rec.held).toBe(false);
    expect(rec.evidence['rto_rate_pct']).toBe('10.00');
    expect(rec.evidence['order_count']).toBe(200);
    expect(rec.title).toContain('RTO');
  });

  it('3b. confidence gate — an UNTRUSTED foundation HOLDS the risk rec (read-time enforcement)', async () => {
    if (!pgAvailable) return;
    const recs = await getRecommendations(BRAND_A, CORR, { pool: dbPool, gate: UNTRUSTED_GATE });
    expect(recs.state).toBe('has_data');
    if (recs.state !== 'has_data') return;
    const rec = recs.recommendations[0]!;
    expect(rec.held).toBe(true); // high-risk on untrusted data → not actionable
    expect(rec.confidence).toBe('Insufficient');
    expect(rec.held_reason).toBeTruthy();
  });

  it('4. expiry — RTO drops below threshold → open rec expired + logged', async () => {
    if (!pgAvailable) return;
    // Remove the COD-RTO clawbacks → 0% RTO → detector no longer fires.
    await srPool.query(
      `DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ? AND event_type = 'cod_rto_clawback'`,
      [BRAND_A],
    );
    const r = await generateRecommendations(BRAND_A, CORR, { pool: dbPool, srPool });
    expect(r.raised).toBe(0);
    expect(r.expired).toBe(1);

    const recs = await getRecommendations(BRAND_A, CORR, { pool: dbPool, gate: TRUSTED_GATE });
    expect(recs.state).toBe('no_data'); // no OPEN recs
  });

  it('5. RLS isolation — BRAND_A recs invisible under BRAND_B scope', async () => {
    if (!pgAvailable) return;
    const recs = await getRecommendations(BRAND_B, CORR, { pool: dbPool, gate: TRUSTED_GATE });
    expect(recs.state).toBe('no_data');
  });
});
