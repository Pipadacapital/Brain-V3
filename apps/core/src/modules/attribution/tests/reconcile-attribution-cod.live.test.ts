/**
 * reconcile-attribution-cod.live.test.ts — GAP-3: COD revenue is attributed.
 *
 * Before GAP-3 the credit pass keyed ONLY on event_type='finalization', so COD revenue (recognized
 * via cod_delivery_confirmed) was never attributed — a large gap for COD-heavy (India) brands and a
 * structural parity-oracle shortfall (realized = every non-provisional event, incl. COD). The credit
 * basis is now finalization ∪ cod_delivery_confirmed.
 *
 * Proves a COD order (cod_delivery_confirmed) with a stitched journey gets credit rows summing to the
 * COD realized basis, exactly like a prepaid finalization order. Skips when PG/StarRocks unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { SilverPool } from '@brain/metric-engine';
import { reconcileAttribution } from '../internal/reconcile-attribution.js';

const PG_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_PORT'] ?? 9030);

const BRAND = 'a7777032-0032-0032-0032-0000000c0d01';
const ORG_ID = 'f7777032-0032-0032-0032-0000000c0d01';
const USER_ID = 'e7777032-0032-0032-0032-0000000c0d01';
const BRAIN_COD = 'b7777032-0032-0032-0032-00000000c0d1'; // COD order's stitched identity
const ANON_COD = 'anon-cod-7777';
const ORDER_COD = 'ord-cod-1';
const CORR = 'reconcile-attr-cod-live';
const MODEL = 'position_based';

let pgPool: pg.Pool;
let srPool: SilverPool;
let available = false;

async function pgExec(sql: string, params: unknown[] = []): Promise<void> {
  await pgPool.query(sql, params);
}

async function seedLedgerRow(orderId: string, brainId: string, eventType: string, amount: number): Promise<void> {
  await pgPool.query(
    `INSERT INTO realized_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        occurred_at, occurred_date, economic_effective_at, billing_posted_period, recognition_label)
     VALUES ($1,$2,$3,$4,$5,$6,'INR','2026-06-10Z',(timezone('UTC','2026-06-10Z'::timestamptz))::date,'2026-06-10Z','2026-06',
             CASE WHEN $5='provisional_recognition' THEN 'provisional' ELSE 'finalized' END)
     ON CONFLICT (brand_id, ledger_event_id, occurred_date) DO NOTHING`,
    [BRAND, `cod-evt-${eventType}-${orderId}`, orderId, brainId, eventType, amount],
  );
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
    await sr.query(`CREATE TABLE IF NOT EXISTS brain_silver.silver_touchpoint (
        brand_id varchar(64), brain_anon_id varchar(128), touch_seq int, channel varchar(64),
        utm_campaign varchar(255), utm_medium varchar(255), fbclid varchar(255), gclid varchar(255),
        ttclid varchar(255), stitched_brain_id varchar(64)
      ) DUPLICATE KEY(brand_id, brain_anon_id, touch_seq)
        DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES ("replication_num" = "1")`);

    await cleanup();
    await pgExec(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,'cod@x.invalid','cod@x.invalid','x') ON CONFLICT DO NOTHING`, [USER_ID]);
    await pgExec(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'COD Org','cod-org',$2) ON CONFLICT DO NOTHING`, [ORG_ID, USER_ID]);
    await pgExec(`INSERT INTO brand (id,organization_id,display_name,currency_code) VALUES ($1,$2,'COD Brand','INR') ON CONFLICT DO NOTHING`, [BRAND, ORG_ID]);

    // A journey (2 touches) stitched to the COD order's identity.
    await sr.query(
      `INSERT INTO brain_silver.silver_touchpoint
         (brand_id, brain_anon_id, touch_seq, channel, utm_campaign, utm_medium, fbclid, gclid, ttclid, stitched_brain_id)
       VALUES (?,?,1,'paid_meta','diwali','cpc',NULL,NULL,NULL,?), (?,?,2,'referral',NULL,NULL,NULL,NULL,NULL,?)`,
      [BRAND, ANON_COD, BRAIN_COD, BRAND, ANON_COD, BRAIN_COD],
    );

    // COD order: provisional + cod_delivery_confirmed (recognized on delivery — NO finalization row).
    await seedLedgerRow(ORDER_COD, BRAIN_COD, 'provisional_recognition', 120000);
    await seedLedgerRow(ORDER_COD, BRAIN_COD, 'cod_delivery_confirmed', 120000);
    available = true;
  } catch (e) {
    available = false;
    console.warn('[reconcile-attr-cod] PG/StarRocks unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) await cleanup();
  if (pgPool) await pgPool.end();
  if (srPool) await (srPool as unknown as mysql.Pool).end();
});

describe('reconcileAttribution — COD revenue attributed (GAP-3, live PG + StarRocks)', () => {
  it('credits a cod_delivery_confirmed order to its journey, summing to the COD realized basis', async () => {
    if (!available) { console.warn('[skip] PG/StarRocks unavailable'); return; }
    const r = await reconcileAttribution(BRAND, CORR, { pool: pgPool, srPool }, MODEL);
    expect(r.credited).toBe(1); // the COD order is now credited (was 0 before GAP-3)
    expect(r.unattributed).toBe(0);

    const credit = await pgPool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(credited_revenue_minor),0)::text AS sum
         FROM attribution_credit_ledger
        WHERE brand_id=$1 AND order_id=$2 AND row_kind='credit' AND model_id=$3`,
      [BRAND, ORDER_COD, MODEL],
    );
    expect(credit.rows[0].n).toBeGreaterThan(0); // credit rows exist for the COD order
    expect(credit.rows[0].sum).toBe('120000'); // closed-sum-at-order = COD realized basis
  });
});
