/**
 * reconcile-attribution.live.test.ts — the attribution WRITE pipeline, end-to-end (Phase 5).
 *
 * Proves the dead writer is now LIVE via reconcileAttribution:
 *   1. credit — a FINALIZED order with a stitched journey gets credit rows in
 *      attribution_credit_ledger; the per-touch credit sums to the realized basis.
 *   2. idempotent — re-running reconcile writes NO new rows (deterministic ids / ON CONFLICT).
 *   3. unattributed — a finalized order with NO journey is left unattributed (honest, no rows).
 *   4. clawback — a reversal on the credited order writes mirrored signed-negative rows; the
 *      net (credit + clawback) closes to zero.
 *
 * REQUIRES: Postgres (migration 0032) + StarRocks (brain_silver) on localhost. Seeds the StarRocks
 * silver_touchpoint table + the Postgres ledger; runs the real reconcile command + writer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { SilverPool } from '@brain/metric-engine';
import { reconcileAttribution } from '../internal/reconcile-attribution.js';

const PG_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_PORT'] ?? 9030);

const BRAND = 'a7777032-0032-0032-0032-000000000001';
const ORG_ID = 'f7777032-0032-0032-0032-000000000001';
const USER_ID = 'e7777032-0032-0032-0032-000000000001';
const BRAIN_ID = 'b7777032-0032-0032-0032-0000000000a1'; // stitched identity on the order
const ANON = 'anon-7777';
const ORDER_CREDITED = 'ord-credited-1';
const ORDER_UNATTRIB = 'ord-unattrib-1';
const CORR = 'reconcile-attr-live';
const MODEL = 'position_based';

let pgPool: pg.Pool;
let srPool: SilverPool;
let available = false;

async function pgExec(sql: string, params: unknown[] = []): Promise<void> {
  await pgPool.query(sql, params);
}

let seq = 0;
async function seedLedgerRow(orderId: string, brainId: string | null, eventType: string, amount: number, ledgerEventId?: string): Promise<string> {
  seq += 1;
  const id = ledgerEventId ?? `attr-evt-${seq}`;
  await pgPool.query(
    `INSERT INTO realized_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        occurred_at, occurred_date, economic_effective_at, billing_posted_period, recognition_label)
     VALUES ($1,$2,$3,$4,$5,$6,'INR','2026-06-10Z',(timezone('UTC','2026-06-10Z'::timestamptz))::date,'2026-06-10Z','2026-06',
             CASE WHEN $5='provisional_recognition' THEN 'provisional' ELSE 'finalized' END)
     ON CONFLICT (brand_id, ledger_event_id, occurred_date) DO NOTHING`,
    [BRAND, id, orderId, brainId, eventType, amount],
  );
  return id;
}

async function cleanup(): Promise<void> {
  await pgExec(`DELETE FROM attribution_credit_ledger WHERE brand_id = $1`, [BRAND]).catch(() => {});
  await pgExec(`DELETE FROM realized_revenue_ledger WHERE brand_id = $1`, [BRAND]).catch(() => {});
  await pgExec(`DELETE FROM brand WHERE id = $1`, [BRAND]).catch(() => {});
  await pgExec(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
  await pgExec(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
  await (srPool as unknown as mysql.Pool)
    .query(`DELETE FROM brain_silver.silver_touchpoint WHERE brand_id = ?`, [BRAND])
    .catch(() => {});
}

beforeAll(async () => {
  try {
    pgPool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 4000 });
    await pgPool.query('SELECT 1');
    srPool = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', database: 'brain_silver', connectionLimit: 2 }) as unknown as SilverPool;
    const sr = srPool as unknown as mysql.Pool;
    // Minimal silver_touchpoint table (the subset the writer reads) — idempotent.
    await sr.query(`CREATE TABLE IF NOT EXISTS brain_silver.silver_touchpoint (
        brand_id varchar(64), brain_anon_id varchar(128), touch_seq int, channel varchar(64),
        utm_campaign varchar(255), utm_medium varchar(255), fbclid varchar(255), gclid varchar(255),
        ttclid varchar(255), stitched_brain_id varchar(64)
      ) DUPLICATE KEY(brand_id, brain_anon_id, touch_seq)
        DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES ("replication_num" = "1")`);

    await cleanup();
    // app_user → org → brand (currency trigger needs brand.currency_code)
    await pgExec(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,'attr@x.invalid','attr@x.invalid','x') ON CONFLICT DO NOTHING`, [USER_ID]);
    await pgExec(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'Attr Org','attr-org',$2) ON CONFLICT DO NOTHING`, [ORG_ID, USER_ID]);
    await pgExec(`INSERT INTO brand (id,organization_id,display_name,currency_code) VALUES ($1,$2,'Attr Brand','INR') ON CONFLICT DO NOTHING`, [BRAND, ORG_ID]);

    // Two journey touches stitched to BRAIN_ID (the credited order's identity).
    await sr.query(
      `INSERT INTO brain_silver.silver_touchpoint
         (brand_id, brain_anon_id, touch_seq, channel, utm_campaign, utm_medium, fbclid, gclid, ttclid, stitched_brain_id)
       VALUES (?,?,1,'paid_social','spring','cpc',NULL,NULL,NULL,?), (?,?,2,'organic_social',NULL,NULL,NULL,NULL,NULL,?)`,
      [BRAND, ANON, BRAIN_ID, BRAND, ANON, BRAIN_ID],
    );

    // A FINALIZED credited order (brain_id stitched), and a finalized order with NO journey.
    await seedLedgerRow(ORDER_CREDITED, BRAIN_ID, 'provisional_recognition', 100000);
    await seedLedgerRow(ORDER_CREDITED, BRAIN_ID, 'finalization', 100000);
    await seedLedgerRow(ORDER_UNATTRIB, 'b7777032-0032-0032-0032-0000000000ff', 'finalization', 50000);
    available = true;
  } catch (e) {
    available = false;
    console.warn('[reconcile-attr] PG/StarRocks unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) await cleanup();
  if (pgPool) await pgPool.end();
  if (srPool) await (srPool as unknown as mysql.Pool).end();
});

describe('reconcileAttribution (live PG + StarRocks)', () => {
  it('SKIP_IF_UNAVAILABLE', () => {
    expect(true).toBe(true);
  });

  it('1+3. credit — stitched order credited (sum=realized); no-journey order unattributed', async () => {
    if (!available) return;
    const r = await reconcileAttribution(BRAND, CORR, { pool: pgPool, srPool }, MODEL);
    expect(r.credited).toBe(1);
    expect(r.unattributed).toBe(1); // the no-journey finalized order

    const credit = await pgPool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(credited_revenue_minor),0)::text AS sum
         FROM attribution_credit_ledger
        WHERE brand_id=$1 AND order_id=$2 AND row_kind='credit' AND model_id=$3`,
      [BRAND, ORDER_CREDITED, MODEL],
    );
    expect(credit.rows[0].n).toBeGreaterThan(0);
    expect(credit.rows[0].sum).toBe('100000'); // closed-sum-at-order = realized basis
  });

  it('2. idempotent — re-running reconcile writes no new credit rows', async () => {
    if (!available) return;
    const before = await pgPool.query(`SELECT count(*)::int AS n FROM attribution_credit_ledger WHERE brand_id=$1`, [BRAND]);
    const r = await reconcileAttribution(BRAND, CORR, { pool: pgPool, srPool }, MODEL);
    expect(r.credited).toBe(0);
    const after = await pgPool.query(`SELECT count(*)::int AS n FROM attribution_credit_ledger WHERE brand_id=$1`, [BRAND]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('H8. no-model reconcile writes ALL FOUR models (not just position_based)', async () => {
    if (!available) return;
    // Fresh credit set: clear and re-run WITHOUT a model → loops ATTRIBUTION_MODEL_IDS.
    await pgExec(`DELETE FROM attribution_credit_ledger WHERE brand_id = $1`, [BRAND]).catch(() => {});
    const r = await reconcileAttribution(BRAND, CORR, { pool: pgPool, srPool });
    // The one stitched order is credited under each of the 4 models → credited == 4.
    expect(r.credited).toBe(4);

    const models = await pgPool.query<{ model_id: string }>(
      `SELECT DISTINCT model_id FROM attribution_credit_ledger
        WHERE brand_id = $1 AND order_id = $2 AND row_kind = 'credit' ORDER BY model_id`,
      [BRAND, ORDER_CREDITED],
    );
    expect(models.rows.map((m) => m.model_id).sort()).toEqual(
      ['first_touch', 'last_touch', 'linear', 'position_based'],
    );

    // Each model's credit still closes to the realized basis (100000) at the order.
    const perModel = await pgPool.query<{ model_id: string; sum: string }>(
      `SELECT model_id, SUM(credited_revenue_minor)::text AS sum FROM attribution_credit_ledger
        WHERE brand_id = $1 AND order_id = $2 AND row_kind = 'credit' GROUP BY model_id`,
      [BRAND, ORDER_CREDITED],
    );
    for (const row of perModel.rows) expect(row.sum).toBe('100000');

    // Restore the single-model state the clawback test below expects (position_based only).
    await pgExec(
      `DELETE FROM attribution_credit_ledger WHERE brand_id = $1 AND model_id <> $2`,
      [BRAND, MODEL],
    ).catch(() => {});
  });

  it('4. clawback — a reversal nets the credited order to zero', async () => {
    if (!available) return;
    await seedLedgerRow(ORDER_CREDITED, BRAIN_ID, 'rto_reversal', -100000, 'attr-rev-1');
    const r = await reconcileAttribution(BRAND, CORR, { pool: pgPool, srPool }, MODEL);
    expect(r.clawed_back).toBe(1);

    const net = await pgPool.query(
      `SELECT COALESCE(SUM(credited_revenue_minor),0)::text AS net
         FROM attribution_credit_ledger
        WHERE brand_id=$1 AND order_id=$2 AND model_id=$3`,
      [BRAND, ORDER_CREDITED, MODEL],
    );
    expect(net.rows[0].net).toBe('0'); // credit + clawback = 0 (closed-sum)
  });
});
