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
import { generateRecommendations, getRecommendations } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

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
let pgAvailable = false;

let seq = 0;
async function seedRows(eventType: string, n: number, amountMinor: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    seq += 1;
    await superPool.query(
      `INSERT INTO realized_revenue_ledger
         (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
          occurred_at, economic_effective_at, billing_posted_period, recognition_label)
       VALUES ($1, $2, $3, $4, $5, 'INR', '2026-06-01Z', '2026-06-01Z', '2026-06',
               CASE WHEN $4 = 'provisional_recognition' THEN 'provisional' ELSE 'finalized' END)
       ON CONFLICT (brand_id, ledger_event_id) DO NOTHING`,
      [BRAND_A, `rto-evt-${seq}`, `rto-order-${seq}`, eventType, amountMinor],
    );
  }
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
    await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id = $1`, [b]).catch(() => {});
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
    await cleanup();
    await seedBrand();
    // 200 orders, 20 RTO reversals → 10% RTO (> 3% threshold), 200 ≥ 100 → Trusted.
    await seedRows('provisional_recognition', 200, 50_000);
    await seedRows('rto_reversal', 20, -50_000);
    // Settle the 200 provisional orders so the realization_gap detector (added after this test) does
    // NOT also fire — this test is scoped to rto_risk. Finalizing the SAME order_ids adds no distinct
    // orders, so the RTO rate is unchanged; it just moves provisional→realized below the 60% gap.
    for (let i = 1; i <= 200; i++) {
      await superPool.query(
        `INSERT INTO realized_revenue_ledger
           (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
            occurred_at, economic_effective_at, billing_posted_period, recognition_label)
         VALUES ($1, $2, $3, 'finalization', 50000, 'INR', '2026-06-01Z', '2026-06-01Z', '2026-06', 'finalized')
         ON CONFLICT (brand_id, ledger_event_id) DO NOTHING`,
        [BRAND_A, `rto-fin-${i}`, `rto-order-${i}`],
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
  if (superPool) await superPool.end();
});

describe('RTO-risk detector (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[rto-detector] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. generate raises a risk rec with evidence + confidence + a decision_log entry', async () => {
    if (!pgAvailable) return;
    const r = await generateRecommendations(BRAND_A, CORR, { pool: dbPool });
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
    const r = await generateRecommendations(BRAND_A, CORR, { pool: dbPool });
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
    // Remove the RTO reversals → 0% RTO → detector no longer fires.
    await superPool.query(
      `DELETE FROM realized_revenue_ledger WHERE brand_id = $1 AND event_type = 'rto_reversal'`,
      [BRAND_A],
    );
    const r = await generateRecommendations(BRAND_A, CORR, { pool: dbPool });
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
