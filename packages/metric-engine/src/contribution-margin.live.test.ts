/**
 * contribution-margin.live.test.ts — computeContributionMargin (CM1/CM2), mixed-tier live read.
 *
 * PHASE G re-point: the two MONEY inputs now read the LAKEHOUSE via withSilverBrand — realized from
 * brain_gold.gold_revenue_ledger, marketing spend from brain_silver.silver_marketing_spend. The cost
 * CONFIG (pct rates + confidence) and the brand currency stay on operational Postgres (RLS). So the
 * engine takes mixed deps { pool, srPool }; the test seeds StarRocks for revenue/spend + PG for costs.
 *
 *   CM-1: revenue − COGS − variable − marketing = CM1/CM2 exactly (integer minor units).
 *   CM-2: cost_confidence = floor of cost_input confidences ('Trusted' when all trusted).
 *   CM-3: NO cogs input → costConfidence 'Insufficient' (the honest 'D' that blocks the billing cap).
 *   CM-4: ISOLATION — brand B sees none of brand A's revenue (lakehouse seam) or costs (PG RLS).
 *
 * Cost reads run under the brain_app pool (withBrandTxn sets the GUC; seams are SECURITY INVOKER);
 * realized/spend reads run through the Silver seam (BRAND_PREDICATE → brand_id = ?). The lakehouse
 * sections SKIP if StarRocks is down (srUp=false).
 *
 * REQUIRES: Postgres on :5432 (migrations) + StarRocks on :9030 with brain_gold.gold_revenue_ledger
 * and brain_silver.silver_marketing_spend (dbt-built).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { computeContributionMargin } from './contribution-margin.js';
import type { SilverPool } from './silver-deps.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);

const BRAND_A = 'c2c20001-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'c2c20001-0a11-4a11-8a11-00000000bb01';
const ORG = 'c2c20001-0a11-4a11-8a11-00000000ff01';
const ORG_B = 'c2c20001-0a11-4a11-8a11-00000000ff02';
const USER = 'c2c20001-0a11-4a11-8a11-00000000ee01';
const AS_OF = new Date('2026-06-30T00:00:00Z');

let superPool: pg.Pool;
let appPool: pg.Pool;
let srPool: mysql.Pool;
let pgAvailable = false;
let srUp = false;

async function setConfig(client: pg.PoolClient, brandId: string) {
  await client.query(`SELECT set_config('app.current_brand_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.current_workspace_id', $2, true)`, [brandId, '00000000-0000-0000-0000-000000000000']);
}

async function seedCost(brandId: string, costType: string, pctBps: number, confidence = 'Trusted') {
  const c = await superPool.connect();
  try {
    await c.query('BEGIN');
    await setConfig(c, brandId);
    await c.query(
      `INSERT INTO cost_input (brand_id, cost_input_id, scope, scope_ref, cost_type, pct_bps, currency_code, cost_confidence)
       VALUES ($1,$2,'global','',$3,$4,'INR',$5)
       ON CONFLICT (brand_id, cost_input_id) DO UPDATE SET pct_bps=EXCLUDED.pct_bps, cost_confidence=EXCLUDED.cost_confidence, updated_at=now()`,
      [brandId, `${brandId}-${costType}`, costType, pctBps, confidence],
    );
    await c.query('COMMIT');
  } finally { c.release(); }
}

/** Seed a finalized realized row into the lakehouse gold ledger (CM revenue source). */
async function seedRealizedGold(brandId: string, amountMinor: bigint, currency: string, effectiveAt: string) {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, updated_at)
     VALUES (?, ?, ?, NULL, 'finalization', ?, ?, 0, ?, ?, 'finalized', '2026-06', NOW())`,
    [brandId, `${brandId}:fin:${String(amountMinor)}`, `order-${brandId.slice(-4)}`, String(amountMinor), currency, effectiveAt, effectiveAt],
  );
}

/** Seed the same logical spend into the lakehouse Silver marketing entity (CM marketing source). */
async function seedSpendSilver(brandId: string, spendMinor: bigint, currency: string, statDate: string) {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_silver.silver_marketing_spend
       (brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
        stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at)
     VALUES (?, ?, 'meta', 'campaign', ?, NULL, ?, 'Test Campaign', ?, ?, ?, 1000, 50, 'Asia/Kolkata', NOW(), NOW())`,
    [brandId, `${brandId}:meta:cmp1:${statDate}`, 'cmp1', 'cmp1', statDate, String(spendMinor), currency],
  );
}

async function clearLakehouse(brandId: string) {
  if (!srUp) return;
  await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [brandId]).catch(() => {});
  await srPool.query(`DELETE FROM brain_silver.silver_marketing_spend WHERE brand_id = ?`, [brandId]).catch(() => {});
}

async function cleanup() {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM cost_input WHERE brand_id=$1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM brand WHERE id=$1`, [b]).catch(() => {});
    await clearLakehouse(b);
  }
  for (const o of [ORG, ORG_B]) await superPool.query(`DELETE FROM organization WHERE id=$1`, [o]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 4 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 4 });
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }

  try {
    srPool = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', connectionLimit: 2 });
    await srPool.query('SELECT 1');
    srUp = true;
  } catch {
    srUp = false;
  }

  if (!pgAvailable) return;
  await cleanup();
  await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
  await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CM',$2,$3)`, [ORG, `cm-${ORG.slice(-6)}`, USER]);
  await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CMB',$2,$3)`, [ORG_B, `cmb-${ORG_B.slice(-6)}`, USER]);
  await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CM','INR','active')`, [BRAND_A, ORG]);
  await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CMB','INR','active')`, [BRAND_B, ORG_B]);
  // Brand A: ₹1000 finalized revenue (lakehouse) + ₹200 ad spend (lakehouse), both ≤ AS_OF.
  await seedRealizedGold(BRAND_A, 100000n, 'INR', '2026-06-10');
  await seedSpendSilver(BRAND_A, 20000n, 'INR', '2026-06-12');
  // Brand A: COGS 40%, shipping 10% (both Trusted) — config on PG.
  await seedCost(BRAND_A, 'cogs', 4000, 'Trusted');
  await seedCost(BRAND_A, 'shipping', 1000, 'Trusted');
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
  if (srPool) await srPool.end().catch(() => {});
});

describe('computeContributionMargin (mixed-tier: lakehouse revenue/spend + PG cost config)', () => {
  it('SKIP_IF_UNAVAILABLE', () => {
    if (!pgAvailable) console.warn('[contribution-margin] Postgres unavailable — PENDING.');
    if (!srUp) console.warn('[contribution-margin] StarRocks unavailable — lakehouse assertions skipped.');
    expect(true).toBe(true);
  });

  it('CM-1+CM-2: exact integer CM1/CM2 + Trusted confidence', async () => {
    if (!pgAvailable || !srUp) return;
    const r = await computeContributionMargin(BRAND_A, AS_OF, { pool: appPool, srPool: srPool as unknown as SilverPool });
    expect(r.netRevenueMinor).toBe(100000n);
    expect(r.cogsMinor).toBe(40000n);          // 100000 * 4000/10000
    expect(r.variableCostMinor).toBe(10000n);  // 100000 * 1000/10000
    expect(r.cm1Minor).toBe(50000n);           // 100000 - 40000 - 10000
    expect(r.marketingMinor).toBe(20000n);
    expect(r.cm2Minor).toBe(30000n);           // 50000 - 20000
    expect(r.costConfidence).toBe('Trusted');
  });

  it('CM-2b: confidence floors to Estimated when any input is Estimated', async () => {
    if (!pgAvailable || !srUp) return;
    await seedCost(BRAND_A, 'shipping', 1000, 'Estimated'); // downgrade shipping
    const r = await computeContributionMargin(BRAND_A, AS_OF, { pool: appPool, srPool: srPool as unknown as SilverPool });
    expect(r.costConfidence).toBe('Estimated');
    await seedCost(BRAND_A, 'shipping', 1000, 'Trusted'); // restore
  });

  it('CM-3: no COGS input → Insufficient (blocks the billing cap)', async () => {
    if (!pgAvailable || !srUp) return;
    const r = await computeContributionMargin(BRAND_B, AS_OF, { pool: appPool, srPool: srPool as unknown as SilverPool });
    expect(r.costConfidence).toBe('Insufficient');
    expect(r.cogsMinor).toBe(0n);
  });

  it('CM-4: isolation — brand B sees none of brand A’s revenue (lakehouse seam) or costs', async () => {
    if (!pgAvailable || !srUp) return;
    const r = await computeContributionMargin(BRAND_B, AS_OF, { pool: appPool, srPool: srPool as unknown as SilverPool });
    expect(r.netRevenueMinor).toBe(0n); // brand A's ₹1000 is scoped out by BRAND_PREDICATE
    expect(r.marketingMinor).toBe(0n);
  });
});
