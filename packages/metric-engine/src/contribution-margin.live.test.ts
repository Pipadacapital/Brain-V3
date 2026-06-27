/**
 * contribution-margin.live.test.ts — computeContributionMargin (CM1/CM2), mixed-tier live read.
 *
 * BRAIN V4 re-point: the two MONEY inputs read the LAKEHOUSE via withSilverBrand — which now runs over
 * TRINO (StarRocks removed). Realized from the brain_serving Trino view mv_gold_revenue_ledger (over
 * iceberg.brain_gold.gold_revenue_ledger), marketing spend from mv_silver_marketing_spend (over
 * iceberg.brain_silver.silver_marketing_spend). The cost CONFIG (pct rates + confidence) and the brand
 * currency stay on operational Postgres (RLS). The engine takes mixed deps { pool, srPool } — srPool is
 * now a Trino pool (createTrinoPool); the test seeds the Iceberg Gold/Silver marts THROUGH Trino + PG for costs.
 *
 *   CM-1: revenue − COGS − variable − marketing = CM1/CM2 exactly (integer minor units).
 *   CM-2: cost_confidence = floor of cost_input confidences ('Trusted' when all trusted).
 *   CM-3: NO cogs input → costConfidence 'Insufficient' (the honest 'D' that blocks the billing cap).
 *   CM-4: ISOLATION — brand B sees none of brand A's revenue (Trino seam) or costs (PG RLS).
 *
 * Cost reads run under the brain_app pool (withBrandTxn sets the GUC; seams are SECURITY INVOKER);
 * realized/spend reads run through the serving seam (BRAND_PREDICATE → brand_id = ?). The lakehouse
 * sections cleanly SKIP (guarded PENDING) when Trino is unavailable / the Iceberg marts aren't
 * provisioned (trinoUp=false) — never a hard suite failure on a missing engine.
 *
 * REQUIRES (for the lakehouse assertions): Postgres on :5432 (migrations) + Trino on :8090 with the
 * Iceberg marts iceberg.brain_gold.gold_revenue_ledger + iceberg.brain_silver.silver_marketing_spend
 * (Spark-built) and the brain_serving views (db/trino/views). Absent Trino → the suite PENDINGs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { computeContributionMargin } from './contribution-margin.js';
import { createTrinoPool } from './trino-adapter.js';
import type { TrinoPool } from './trino-deps.js';
import type { SilverPool } from './silver-deps.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const TRINO_URL =
  process.env['TRINO_URL'] ??
  `http://${process.env['TRINO_HOST'] ?? '127.0.0.1'}:${process.env['TRINO_PORT'] ?? '8090'}`;
const TRINO_USER = process.env['TRINO_USER'] ?? 'brain';

const BRAND_A = 'c2c20001-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'c2c20001-0a11-4a11-8a11-00000000bb01';
const ORG = 'c2c20001-0a11-4a11-8a11-00000000ff01';
const ORG_B = 'c2c20001-0a11-4a11-8a11-00000000ff02';
const USER = 'c2c20001-0a11-4a11-8a11-00000000ee01';
const AS_OF = new Date('2026-06-30T00:00:00Z');

let superPool: pg.Pool;
let appPool: pg.Pool;
let trinoPool: TrinoPool;
let pgAvailable = false;
let trinoUp = false;

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

/**
 * Seed a finalized realized row into the Iceberg gold ledger (CM revenue source) THROUGH Trino.
 * Trino+Iceberg INSERT: timestamps need an explicit CAST (varchar→timestamp(6)); money params are
 * passed as bigint (the adapter renders bare numerics); updated_at/ingested_at use localtimestamp
 * (timestamp without zone, to match the Iceberg `timestamp` column).
 */
async function seedRealizedGold(brandId: string, amountMinor: bigint, currency: string, effectiveAt: string) {
  if (!trinoUp) return;
  await trinoPool.query(
    `INSERT INTO iceberg.brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period,
        ingested_at, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'finalization', ?, ?, 0,
        CAST(? AS timestamp(6)), CAST(? AS timestamp(6)), 'finalized', '2026-06',
        localtimestamp, 'live', localtimestamp)`,
    [brandId, `${brandId}:fin:${String(amountMinor)}`, `order-${brandId.slice(-4)}`, amountMinor, currency, effectiveAt, effectiveAt],
  );
}

/** Seed the same logical spend into the Iceberg Silver marketing entity (CM marketing source) THROUGH Trino. */
async function seedSpendSilver(brandId: string, spendMinor: bigint, currency: string, statDate: string) {
  if (!trinoUp) return;
  await trinoPool.query(
    `INSERT INTO iceberg.brain_silver.silver_marketing_spend
       (brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
        stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at)
     VALUES (?, ?, 'meta', 'campaign', ?, NULL, ?, 'Test Campaign',
        CAST(? AS date), ?, ?, 1000, 50, 'Asia/Kolkata', localtimestamp, localtimestamp)`,
    [brandId, `${brandId}:meta:cmp1:${statDate}`, 'cmp1', 'cmp1', statDate, spendMinor, currency],
  );
}

async function clearLakehouse(brandId: string) {
  if (!trinoUp) return;
  await trinoPool.query(`DELETE FROM iceberg.brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [brandId]).catch(() => {});
  await trinoPool.query(`DELETE FROM iceberg.brain_silver.silver_marketing_spend WHERE brand_id = ?`, [brandId]).catch(() => {});
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
    // Brain V4 serving: a Trino pool (createTrinoPool) over the iceberg catalog. A bare SELECT 1 proves
    // the coordinator is reachable; if it isn't, the lakehouse assertions PENDING (trinoUp=false).
    trinoPool = createTrinoPool({ baseUrl: TRINO_URL, user: TRINO_USER, catalog: 'iceberg' });
    await trinoPool.query('SELECT 1');
    trinoUp = true;
  } catch {
    trinoUp = false;
  }

  if (!pgAvailable) return;
  await cleanup();
  // Idempotent fixtures (ON CONFLICT DO NOTHING): a prior crashed run can leave these fixed-id rows
  // behind (cleanup may be blocked by an FK), which previously made beforeAll throw a duplicate-key.
  await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x') ON CONFLICT (id) DO NOTHING`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
  await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CM',$2,$3) ON CONFLICT (id) DO NOTHING`, [ORG, `cm-${ORG.slice(-6)}`, USER]);
  await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CMB',$2,$3) ON CONFLICT (id) DO NOTHING`, [ORG_B, `cmb-${ORG_B.slice(-6)}`, USER]);
  await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CM','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND_A, ORG]);
  await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CMB','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND_B, ORG_B]);
  // Brand A: ₹1000 finalized revenue (lakehouse) + ₹200 ad spend (lakehouse), both ≤ AS_OF.
  // Guarded: if Trino is up but the Iceberg marts/views aren't provisioned (fresh env), seeding throws —
  // degrade to PENDING (trinoUp=false) instead of failing beforeAll. The PG cost config still seeds.
  if (trinoUp) {
    try {
      await seedRealizedGold(BRAND_A, 100000n, 'INR', '2026-06-10');
      await seedSpendSilver(BRAND_A, 20000n, 'INR', '2026-06-12');
    } catch (err) {
      console.warn(
        `[contribution-margin] Iceberg Gold/Silver seed via Trino failed — serving tier not provisioned; lakehouse assertions PENDING: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      trinoUp = false;
    }
  }
  // Brand A: COGS 40%, shipping 10% (both Trusted) — config on PG.
  await seedCost(BRAND_A, 'cogs', 4000, 'Trusted');
  await seedCost(BRAND_A, 'shipping', 1000, 'Trusted');
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
  // The Trino pool is a stateless HTTP adapter — no connection to close.
});

describe('computeContributionMargin (mixed-tier: lakehouse revenue/spend + PG cost config)', () => {
  it('SKIP_IF_UNAVAILABLE', () => {
    if (!pgAvailable) console.warn('[contribution-margin] Postgres unavailable — PENDING.');
    if (!trinoUp) console.warn('[contribution-margin] Trino serving tier unavailable — lakehouse assertions PENDING (skipped).');
    expect(true).toBe(true);
  });

  it('CM-1+CM-2: exact integer CM1/CM2 + Trusted confidence', async () => {
    if (!pgAvailable || !trinoUp) return;
    const r = await computeContributionMargin(BRAND_A, AS_OF, { pool: appPool, srPool: trinoPool as SilverPool });
    expect(r.netRevenueMinor).toBe(100000n);
    expect(r.cogsMinor).toBe(40000n);          // 100000 * 4000/10000
    expect(r.variableCostMinor).toBe(10000n);  // 100000 * 1000/10000
    expect(r.cm1Minor).toBe(50000n);           // 100000 - 40000 - 10000
    expect(r.marketingMinor).toBe(20000n);
    expect(r.cm2Minor).toBe(30000n);           // 50000 - 20000
    expect(r.costConfidence).toBe('Trusted');
  });

  it('CM-2b: confidence floors to Estimated when any input is Estimated', async () => {
    if (!pgAvailable || !trinoUp) return;
    await seedCost(BRAND_A, 'shipping', 1000, 'Estimated'); // downgrade shipping
    const r = await computeContributionMargin(BRAND_A, AS_OF, { pool: appPool, srPool: trinoPool as SilverPool });
    expect(r.costConfidence).toBe('Estimated');
    await seedCost(BRAND_A, 'shipping', 1000, 'Trusted'); // restore
  });

  it('CM-3: no COGS input → Insufficient (blocks the billing cap)', async () => {
    if (!pgAvailable || !trinoUp) return;
    const r = await computeContributionMargin(BRAND_B, AS_OF, { pool: appPool, srPool: trinoPool as SilverPool });
    expect(r.costConfidence).toBe('Insufficient');
    expect(r.cogsMinor).toBe(0n);
  });

  it('CM-4: isolation — brand B sees none of brand A’s revenue (lakehouse seam) or costs', async () => {
    if (!pgAvailable || !trinoUp) return;
    const r = await computeContributionMargin(BRAND_B, AS_OF, { pool: appPool, srPool: trinoPool as SilverPool });
    expect(r.netRevenueMinor).toBe(0n); // brand A's ₹1000 is scoped out by BRAND_PREDICATE
    expect(r.marketingMinor).toBe(0n);
  });
});
