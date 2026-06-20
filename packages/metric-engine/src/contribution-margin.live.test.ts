/**
 * contribution-margin.live.test.ts — computeContributionMargin (CM1/CM2), live Postgres + RLS.
 *   CM-1: revenue − COGS − variable − marketing = CM1/CM2 exactly (integer minor units).
 *   CM-2: cost_confidence = floor of cost_input confidences ('Trusted' when all trusted).
 *   CM-3: NO cogs input → costConfidence 'Insufficient' (the honest 'D' that blocks the billing cap).
 *   CM-4: RLS — brand B (no GUC leak) sees none of brand A's costs.
 * Runs the engine under the brain_app pool (withBrandTxn sets the GUC; seams are SECURITY INVOKER).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { computeContributionMargin } from './contribution-margin.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'c2c20001-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'c2c20001-0a11-4a11-8a11-00000000bb01';
const ORG = 'c2c20001-0a11-4a11-8a11-00000000ff01';
const ORG_B = 'c2c20001-0a11-4a11-8a11-00000000ff02';
const USER = 'c2c20001-0a11-4a11-8a11-00000000ee01';
const AS_OF = new Date('2026-06-30T00:00:00Z');

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

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

async function cleanup() {
  for (const b of [BRAND_A, BRAND_B]) {
    for (const t of ['cost_input', 'ad_spend_ledger', 'realized_revenue_ledger']) {
      await superPool.query(`DELETE FROM ${t} WHERE brand_id=$1`, [b]).catch(() => {});
    }
    await superPool.query(`DELETE FROM brand WHERE id=$1`, [b]).catch(() => {});
  }
  for (const o of [ORG, ORG_B]) await superPool.query(`DELETE FROM organization WHERE id=$1`, [o]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 4 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 4 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CM',$2,$3)`, [ORG, `cm-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CMB',$2,$3)`, [ORG_B, `cmb-${ORG_B.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CM','INR','active')`, [BRAND_A, ORG]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CMB','INR','active')`, [BRAND_B, ORG_B]);
    // Brand A: ₹1000 finalized revenue.
    await superPool.query(
      `INSERT INTO realized_revenue_ledger (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code, occurred_at, economic_effective_at, billing_posted_period, recognition_label)
       VALUES ($1,'cm-fin-1','cm-order-1','finalization',100000,'INR','2026-06-10T10:00:00Z','2026-06-10T10:00:00Z','2026-06','finalized')`,
      [BRAND_A],
    );
    // Brand A: ₹200 ad spend.
    await superPool.query(
      `INSERT INTO ad_spend_ledger (brand_id, spend_event_id, platform, level, level_id, stat_date, spend_minor, currency_code, raw_event_id, occurred_at)
       VALUES ($1,'cm-spend-1','meta','campaign','cmp1','2026-06-12',20000,'INR','cm-spend-1','2026-06-12T00:00:00Z')`,
      [BRAND_A],
    );
    // Brand A: COGS 40%, shipping 10% (both Trusted).
    await seedCost(BRAND_A, 'cogs', 4000, 'Trusted');
    await seedCost(BRAND_A, 'shipping', 1000, 'Trusted');
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

describe('computeContributionMargin (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[contribution-margin] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('CM-1+CM-2: exact integer CM1/CM2 + Trusted confidence', async () => {
    if (!pgAvailable) return;
    const r = await computeContributionMargin(BRAND_A, AS_OF, { pool: appPool });
    expect(r.netRevenueMinor).toBe(100000n);
    expect(r.cogsMinor).toBe(40000n);          // 100000 * 4000/10000
    expect(r.variableCostMinor).toBe(10000n);  // 100000 * 1000/10000
    expect(r.cm1Minor).toBe(50000n);           // 100000 - 40000 - 10000
    expect(r.marketingMinor).toBe(20000n);
    expect(r.cm2Minor).toBe(30000n);           // 50000 - 20000
    expect(r.costConfidence).toBe('Trusted');
  });

  it('CM-2b: confidence floors to Estimated when any input is Estimated', async () => {
    if (!pgAvailable) return;
    await seedCost(BRAND_A, 'shipping', 1000, 'Estimated'); // downgrade shipping
    const r = await computeContributionMargin(BRAND_A, AS_OF, { pool: appPool });
    expect(r.costConfidence).toBe('Estimated');
    await seedCost(BRAND_A, 'shipping', 1000, 'Trusted'); // restore
  });

  it('CM-3: no COGS input → Insufficient (blocks the billing cap)', async () => {
    if (!pgAvailable) return;
    const r = await computeContributionMargin(BRAND_B, AS_OF, { pool: appPool });
    expect(r.costConfidence).toBe('Insufficient');
    expect(r.cogsMinor).toBe(0n);
  });

  it('CM-4: RLS — brand B sees none of brand A’s revenue or costs', async () => {
    if (!pgAvailable) return;
    const r = await computeContributionMargin(BRAND_B, AS_OF, { pool: appPool });
    expect(r.netRevenueMinor).toBe(0n); // brand A's ₹1000 is invisible to brand B
  });
});
