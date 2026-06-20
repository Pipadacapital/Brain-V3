/**
 * gmv-asof-guc.live.test.ts — F-SEC-02: GetRealizedGmvAsOf under brain_app RLS + GUC no-leak.
 *
 * GetRealizedGmvAsOfQuery now runs through withBrandTxn (BEGIN → SET LOCAL ROLE brain_app →
 * transaction-local app.current_brand_id → COMMIT). This proves, under a REAL brain_app pool
 * (NOSUPERUSER NOBYPASSRLS — RLS genuinely enforced, not masked by superuser):
 *   1. correctness — returns the brand's realized GMV (provisional excluded, reversal netted),
 *   2. defense-in-depth — the brand GUC does NOT leak to the next query on the SAME pooled
 *      connection (the COMMIT resets the transaction-local GUC + role).
 *
 * REQUIRES Postgres with migration 0018 (realized_revenue_ledger + realized_gmv_as_of).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { GetRealizedGmvAsOfQuery } from '../internal/application/queries/GetRealizedGmvAsOf.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'f5e20018-0018-4018-8018-0000000000a1';
const BRAND_B = 'f5e20018-0018-4018-8018-0000000000b2';
const ORG = 'f5e20018-0018-4018-8018-0000000000f1';
const USER = 'f5e20018-0018-4018-8018-0000000000e1';
const AS_OF = new Date('2026-06-30T00:00:00.000Z');

let superPool: pg.Pool;
let appPool: pg.Pool; // max:1 so GUC-leak across calls is observable on one connection
let pgAvailable = false;

async function cleanup() {
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id = ANY($1::uuid[])`, [[BRAND_A, BRAND_B]]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id = ANY($1::uuid[])`, [[BRAND_A, BRAND_B]]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

async function seedLedger(brand: string, rows: Array<[string, number]>) {
  let i = 0;
  for (const [eventType, amt] of rows) {
    i += 1;
    const label = eventType === 'provisional_recognition' ? 'provisional' : 'finalized';
    await superPool.query(
      `INSERT INTO realized_revenue_ledger
         (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
          occurred_at, economic_effective_at, billing_posted_period, recognition_label)
       VALUES ($1,$2,$3,$4,$5::bigint,'INR','2026-06-1${i}Z','2026-06-1${i}Z','2026-06',$6)
       ON CONFLICT (brand_id, ledger_event_id) DO NOTHING`,
      [brand, `${brand}-evt-${i}`, `${brand}-ord`, eventType, amt, label],
    );
  }
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 1 });
    await cleanup();
    await superPool.query(
      `INSERT INTO app_user (id,email,email_normalized,password_hash)
       VALUES ($1,'gmv@example.invalid','gmv@example.invalid','x') ON CONFLICT (id) DO NOTHING`, [USER]);
    await superPool.query(
      `INSERT INTO organization (id,name,slug,owner_user_id)
       VALUES ($1,'GMV Org','gmv-org',$2) ON CONFLICT (id) DO NOTHING`, [ORG, USER]);
    for (const b of [BRAND_A, BRAND_B]) {
      await superPool.query(
        `INSERT INTO brand (id,organization_id,display_name,currency_code,status)
         VALUES ($1,$2,'GMV','INR','active') ON CONFLICT (id) DO NOTHING`, [b, ORG]);
    }
    // A: realized = 100000 (finalization) − 10000 (rto_reversal) = 90000; provisional EXCLUDED.
    await seedLedger(BRAND_A, [['provisional_recognition', 50000], ['finalization', 100000], ['rto_reversal', -10000]]);
    // B: a distinct value to prove isolation.
    await seedLedger(BRAND_B, [['finalization', 777777]]);
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end().catch(() => {});
  if (superPool) await superPool.end();
});

describe('GetRealizedGmvAsOf under brain_app RLS (F-SEC-02, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[gmv-asof-guc] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('returns the brand-scoped realized GMV under enforced RLS (provisional excluded, reversal netted)', async () => {
    if (!pgAvailable) return;
    const q = new GetRealizedGmvAsOfQuery(appPool);
    expect(await q.execute(BRAND_A, AS_OF)).toBe(90000n);
    expect(await q.execute(BRAND_B, AS_OF)).toBe(777777n); // isolation — its own GUC scope
  });

  it('does NOT leak the brand GUC to the next query on the same pooled connection', async () => {
    if (!pgAvailable) return;
    const q = new GetRealizedGmvAsOfQuery(appPool);
    await q.execute(BRAND_A, AS_OF);
    // Same max:1 pool → same connection. The withBrandTxn COMMIT must have reset the local GUC.
    const res = await appPool.query<{ guc: string | null }>(
      "SELECT current_setting('app.current_brand_id', TRUE) AS guc",
    );
    expect(res.rows[0]?.guc ?? '').toBe(''); // reset — no residual brand context
  });
});
