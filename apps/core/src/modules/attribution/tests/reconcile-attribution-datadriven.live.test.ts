/**
 * reconcile-attribution-datadriven.live.test.ts — data-driven (Markov) attribution end-to-end.
 *
 * Proves reconcileDataDrivenAttribution: trains channel weights from the corpus (silver_touchpoint),
 * then credits a recognized order's journey under model_id='data_driven' with EXACT closed-sum money.
 * Skips when PG/StarRocks unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { SilverPool } from '@brain/metric-engine';
import { reconcileDataDrivenAttribution } from '../internal/reconcile-attribution.js';

const PG_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_PORT'] ?? 9030);

const BRAND = 'a7777032-0032-0032-0032-0000000dd001';
const ORG_ID = 'f7777032-0032-0032-0032-0000000dd001';
const USER_ID = 'e7777032-0032-0032-0032-0000000dd001';
const BRAIN_ID = 'b7777032-0032-0032-0032-00000000dd01';
const ANON = 'anon-dd-7777';
const ORDER_DD = 'ord-dd-1';
const CORR = 'reconcile-attr-dd-live';

let pgPool: pg.Pool;
let srPool: SilverPool;
let available = false;

async function pgExec(sql: string, params: unknown[] = []): Promise<void> {
  await pgPool.query(sql, params);
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
        ttclid varchar(255), stitched_brain_id varchar(64), stitched_order_id varchar(128)
      ) DUPLICATE KEY(brand_id, brain_anon_id, touch_seq)
        DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES ("replication_num" = "1")`);

    await cleanup();
    await pgExec(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,'dd@x.invalid','dd@x.invalid','x') ON CONFLICT DO NOTHING`, [USER_ID]);
    await pgExec(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'DD Org','dd-org',$2) ON CONFLICT DO NOTHING`, [ORG_ID, USER_ID]);
    await pgExec(`INSERT INTO brand (id,organization_id,display_name,currency_code) VALUES ($1,$2,'DD Brand','INR') ON CONFLICT DO NOTHING`, [BRAND, ORG_ID]);

    // Corpus: a converting journey (paid_meta→referral) stitched to the order, + a non-converting
    // journey through referral only (so the Markov model differentiates the channels).
    await sr.query(
      `INSERT INTO brain_silver.silver_touchpoint
         (brand_id, brain_anon_id, touch_seq, channel, utm_campaign, utm_medium, fbclid, gclid, ttclid, stitched_brain_id, stitched_order_id)
       VALUES (?,?,1,'paid_meta','x','cpc',NULL,NULL,NULL,?,?), (?,?,2,'referral',NULL,NULL,NULL,NULL,NULL,?,?),
              (?,?,1,'referral',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
      [BRAND, ANON, BRAIN_ID, ORDER_DD, BRAND, ANON, BRAIN_ID, ORDER_DD, BRAND, 'anon-dd-nonconv'],
    );

    // A recognized (finalized) order stitched to the journey.
    await pgPool.query(
      `INSERT INTO realized_revenue_ledger
         (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
          occurred_at, occurred_date, economic_effective_at, billing_posted_period, recognition_label)
       VALUES ($1,'dd-fin-1',$2,$3,'finalization',90000,'INR','2026-06-10Z',(timezone('UTC','2026-06-10Z'::timestamptz))::date,'2026-06-10Z','2026-06','finalized')
       ON CONFLICT (brand_id, ledger_event_id, occurred_date) DO NOTHING`,
      [BRAND, ORDER_DD, BRAIN_ID],
    );
    available = true;
  } catch (e) {
    available = false;
    console.warn('[reconcile-attr-dd] PG/StarRocks unavailable — PENDING.', (e as Error).message);
  }
});

afterAll(async () => {
  if (available) await cleanup();
  if (pgPool) await pgPool.end();
  if (srPool) await (srPool as unknown as mysql.Pool).end();
});

describe('reconcileDataDrivenAttribution — Markov model (live PG + StarRocks)', () => {
  it('credits the order under model_id=data_driven, summing to the realized basis', async () => {
    if (!available) { console.warn('[skip] PG/StarRocks unavailable'); return; }
    const r = await reconcileDataDrivenAttribution(BRAND, CORR, { pool: pgPool, srPool });
    expect(r.credited).toBe(1);

    const credit = await pgPool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(credited_revenue_minor),0)::text AS sum
         FROM attribution_credit_ledger
        WHERE brand_id=$1 AND order_id=$2 AND row_kind='credit' AND model_id='data_driven'`,
      [BRAND, ORDER_DD],
    );
    expect(credit.rows[0].n).toBeGreaterThan(0);
    expect(credit.rows[0].sum).toBe('90000'); // exact closed-sum at the order
  });

  it('is idempotent — a re-run writes no new data_driven rows', async () => {
    if (!available) return;
    const before = await pgPool.query(
      `SELECT count(*)::int AS n FROM attribution_credit_ledger WHERE brand_id=$1 AND model_id='data_driven'`,
      [BRAND],
    );
    await reconcileDataDrivenAttribution(BRAND, CORR, { pool: pgPool, srPool });
    const after = await pgPool.query(
      `SELECT count(*)::int AS n FROM attribution_credit_ledger WHERE brand_id=$1 AND model_id='data_driven'`,
      [BRAND],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
