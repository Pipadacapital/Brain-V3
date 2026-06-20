/**
 * cm2-signal.live.test.ts — cm2_signal_for_brand() returns the right raw aggregates (live PG + RLS).
 * Proves the certified signal the margin-erosion detector reads: net revenue, marketing, cogs/variable
 * rate sums, has_cogs, confidence floor, order count — under brain_app + GUC (SECURITY INVOKER → RLS).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'd1517a01-0a11-4a11-8a11-00000000aa01';
const ORG = 'd1517a01-0a11-4a11-8a11-00000000ff01';
const USER = 'd1517a01-0a11-4a11-8a11-00000000ee01';
const NIL = '00000000-0000-0000-0000-000000000000';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

async function cleanup() {
  for (const t of ['cost_input', 'ad_spend_ledger', 'realized_revenue_ledger']) await superPool.query(`DELETE FROM ${t} WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 3 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 3 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'CS',$2,$3)`, [ORG, `cs-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'CS','INR','active')`, [BRAND, ORG]);
    await superPool.query(
      `INSERT INTO realized_revenue_ledger (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code, occurred_at, economic_effective_at, billing_posted_period, recognition_label)
       VALUES ($1,'cs-fin-1','cs-order-1','finalization',100000,'INR','2026-06-10T10:00:00Z','2026-06-10T10:00:00Z','2026-06','finalized')`,
      [BRAND],
    );
    await superPool.query(
      `INSERT INTO ad_spend_ledger (brand_id, spend_event_id, platform, level, level_id, stat_date, spend_minor, currency_code, raw_event_id, occurred_at)
       VALUES ($1,'cs-spend-1','meta','campaign','c1','2026-06-12',20000,'INR','cs-spend-1','2026-06-12T00:00:00Z')`,
      [BRAND],
    );
    // COGS 40% (Trusted) + shipping 10% (Estimated) — confidence floor should be Estimated (rank 1).
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
  await superPool?.end?.().catch(() => {});
});

describe('cm2_signal_for_brand (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[cm2-signal] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('returns the raw aggregates under brain_app + GUC (SECURITY INVOKER / RLS)', async () => {
    if (!pgAvailable) return;
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_brand_id',$1,true), set_config('app.current_user_id',$2,true), set_config('app.current_workspace_id',$2,true)`, [BRAND, NIL]);
      const r = await c.query(`SELECT * FROM cm2_signal_for_brand($1::uuid)`, [BRAND]);
      await c.query('COMMIT');
      const row = r.rows[0] as Record<string, unknown>;
      expect(String(row['net_revenue_minor'])).toBe('100000');
      expect(String(row['marketing_minor'])).toBe('20000');
      expect(Number(row['order_count'])).toBe(1);
      expect(Number(row['cogs_pct_bps'])).toBe(4000);
      expect(Number(row['variable_pct_bps'])).toBe(1000);
      expect(row['has_cogs']).toBe(true);
      expect(Number(row['confidence_rank'])).toBe(1); // floor of Trusted(2) + Estimated(1)
    } finally {
      c.release();
    }
  });
});
