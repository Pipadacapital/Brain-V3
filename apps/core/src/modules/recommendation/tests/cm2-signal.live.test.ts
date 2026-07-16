/**
 * cm2-signal.live.test.ts — the CM2 detector signal returns the right raw aggregates.
 *
 * MEDALLION REALIGNMENT (Epic 1 / decision B + Phase G): the PG cm2_signal_for_brand() function was
 * dropped with realized_revenue_ledger. The CM2 signal is now assembled in the registry from three
 * lakehouse/operational sources, exactly mirrored here:
 *   - REVENUE half (net_revenue, order_count) ← brain_gold.gold_revenue_ledger via the metric-engine
 *     seam computeCm2RevenueSignal (Bronze-sourced lakehouse).
 *   - MARKETING half (spend) ← brain_silver.silver_marketing_spend (Bronze-sourced) via the seam
 *     computeCm2MarketingSignal — NOT the PG ad_spend_as_of() function. PG ad_spend_ledger stays the
 *     operational WRITE SoR (billing); it is no longer a CM2 READ source. (Was: this test seeded PG
 *     ad_spend_ledger and read ad_spend_as_of(); repointed to Silver to match the registry — the
 *     deferred follow-up from the architecture-compliance refactor.)
 *   - COST half (cogs/variable pct + confidence) ← PostgreSQL cost_input (operational, SECURITY
 *     INVOKER read under brain_app + GUC). Cost stays PG by design.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  computeCm2RevenueSignal,
  computeCm2MarketingSignal,
  createDuckDbServingPool,
  type SilverPool,
} from '@brain/metric-engine';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
// BRAIN V4: StarRocks and Trino are REMOVED (ADR-0014). The Gold/Silver seam runs over DUCKDB-SERVING (createDuckDbServingPool) — the same
// duckdb-serving-over-Iceberg serving path the app uses in production. Seeds INSERT the base Iceberg tables;
// reads go through the brain_serving.mv_* views via the metric-engine seam.
const SERVING_URL =
  process.env['DUCKDB_SERVING_URL'] ??
  `http://${process.env['DUCKDB_SERVING_HOST'] ?? '127.0.0.1'}:${process.env['DUCKDB_SERVING_PORT'] ?? '8091'}`;

const BRAND = 'd1517a01-0a11-4a11-8a11-00000000aa01';
const ORG = 'd1517a01-0a11-4a11-8a11-00000000ff01';
const USER = 'd1517a01-0a11-4a11-8a11-00000000ee01';
const NIL = '00000000-0000-0000-0000-000000000000';

let superPool: pg.Pool;
let appPool: pg.Pool;
let srPool: SilverPool;
let pgAvailable = false;

async function cleanup() {
  await superPool.query(`DELETE FROM cost_input WHERE brand_id=$1`, [BRAND]).catch(() => {});
  if (srPool) {
    await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id=?`, [BRAND]).catch(() => {});
    await srPool.query(`DELETE FROM brain_silver.silver_marketing_spend WHERE brand_id=?`, [BRAND]).catch(() => {});
  }
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 3 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 3 });
    srPool = createDuckDbServingPool({ baseUrl: SERVING_URL });
    await srPool.query('SELECT 1');
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CS',$2,$3)`, [ORG, `cs-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CS','INR','active')`, [BRAND, ORG]);
    // REVENUE half → lakehouse gold ledger (one finalized order @ 1,000.00 INR). Iceberg ts columns are
    // `timestamp` (no zone) → TYPED `TIMESTAMP '...'` literals (the engine will not coerce a bare varchar).
    await srPool.query(
      `INSERT INTO brain_gold.gold_revenue_ledger
         (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
          fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, ingested_at, data_source, updated_at)
       VALUES (?,'cs-fin-1','cs-order-1',NULL,'finalization',100000,'INR',0,TIMESTAMP '2026-06-10 10:00:00',TIMESTAMP '2026-06-10 10:00:00','finalized','2026-06',TIMESTAMP '2026-06-10 10:00:00','live',TIMESTAMP '2026-06-10 10:00:00')`,
      [BRAND],
    );
    // MARKETING half → lakehouse Silver entity silver_marketing_spend (2,000.00 INR), Bronze-sourced
    // shape. This is the read source the registry's computeCm2MarketingSignal consumes (Phase G).
    // stat_date is `date`; occurred_at/updated_at are `timestamp` (no zone) → typed literals + localtimestamp.
    await srPool.query(
      `INSERT INTO brain_silver.silver_marketing_spend
         (brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
          stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at)
       VALUES (?, 'cs-spend-1', 'meta', 'campaign', 'c1', NULL, 'c1', 'CS Campaign',
               DATE '2026-06-12', 20000, 'INR', 1000, 50, 'Asia/Kolkata', TIMESTAMP '2026-06-12 00:00:00', localtimestamp)`,
      [BRAND],
    );
    // COST half → PG cost_input. COGS 40% (Trusted) + shipping 10% (Estimated) → floor Estimated (rank 1).
    const c = await superPool.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_brand_id',$1,true)`, [BRAND]);
    await c.query(`INSERT INTO cost_input (brand_id,cost_input_id,scope,scope_ref,cost_type,pct_bps,currency_code,cost_confidence) VALUES ($1,'cs-cogs','global','','cogs',4000,'INR','Trusted')`, [BRAND]);
    await c.query(`INSERT INTO cost_input (brand_id,cost_input_id,scope,scope_ref,cost_type,pct_bps,currency_code,cost_confidence) VALUES ($1,'cs-ship','global','','shipping',1000,'INR','Estimated')`, [BRAND]);
    await c.query('COMMIT');
    c.release();
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end?.().catch(() => {});
  // The serving pool is a stateless HTTP adapter — no connection to close.
  await superPool?.end?.().catch(() => {});
});

describe('CM2 detector signal (gold revenue + Silver marketing + PG cost)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[cm2-signal] Postgres/StarRocks unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('REVENUE half — net_revenue_minor + order_count from the lakehouse gold ledger', async () => {
    if (!pgAvailable) return;
    const rev = await computeCm2RevenueSignal(BRAND, { srPool });
    expect(String(rev.netRevenueMinor)).toBe('100000');
    expect(rev.orderCount).toBe(1);
  });

  it('MARKETING half — marketing_minor from the lakehouse Silver entity (the seam the registry reads)', async () => {
    if (!pgAvailable) return;
    const mkt = await computeCm2MarketingSignal(BRAND, 'INR', { srPool });
    expect(String(mkt.marketingMinor)).toBe('20000');
  });

  it('MARKETING half — NEGATIVE CONTROL: a foreign-currency brand sees 0 (currency-scoped, no mix)', async () => {
    if (!pgAvailable) return;
    // The seeded spend is INR; a USD read must NOT sum it into a USD margin (the dropped PG
    // cm2_signal_for_brand applied the same JOIN brand ON currency_code filter).
    const mkt = await computeCm2MarketingSignal(BRAND, 'USD', { srPool });
    expect(String(mkt.marketingMinor)).toBe('0');
  });

  it('COST half — the PG cost aggregates the registry reads (brain_app + GUC / RLS)', async () => {
    if (!pgAvailable) return;
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_brand_id',$1,true), set_config('app.current_user_id',$2,true), set_config('app.current_workspace_id',$2,true)`, [BRAND, NIL]);
      const cost = await c.query(
        `SELECT
           COALESCE(SUM(pct_bps) FILTER (WHERE cost_type = 'cogs' AND pct_bps IS NOT NULL), 0)::bigint AS cogs_pct_bps,
           COALESCE(SUM(pct_bps) FILTER (WHERE cost_type IN ('shipping','packaging','payment_fee','marketplace_fee') AND pct_bps IS NOT NULL), 0)::bigint AS variable_pct_bps,
           BOOL_OR(cost_type = 'cogs') AS has_cogs,
           MIN(CASE cost_confidence WHEN 'Trusted' THEN 2 WHEN 'Estimated' THEN 1 ELSE 0 END) AS confidence_rank
           FROM cost_inputs_as_of($1::uuid, CURRENT_DATE)
          WHERE scope = 'global'`,
        [BRAND],
      );
      await c.query('COMMIT');
      const ct = cost.rows[0] as Record<string, unknown>;
      expect(Number(ct['cogs_pct_bps'])).toBe(4000);
      expect(Number(ct['variable_pct_bps'])).toBe(1000);
      expect(ct['has_cogs']).toBe(true);
      expect(Number(ct['confidence_rank'])).toBe(1); // floor of Trusted(2) + Estimated(1)
    } finally {
      c.release();
    }
  });
});
