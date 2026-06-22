/**
 * order-detail.live.test.ts — getOrderDetail (one order's economic breakdown from Bronze), live PG.
 *
 * Bronze is now Iceberg-only (PG bronze_events retired, dropped in db/migrations/0070). This reader
 * sources the order composition SOLELY from the StarRocks external Iceberg catalog via the
 * withSilverBrand seam. When StarRocks is NOT wired (srPool absent), the reader returns the honest
 * not_found contract — it NEVER falls back to (or queries) a PG bronze table. These tests assert
 * that honest-empty contract under the real RLS harness; they do not seed or select bronze_events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getOrderDetail } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'de7a11de-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'de7a11de-0a11-4a11-8a11-00000000bb01';
const ORG = 'de7a11de-0a11-4a11-8a11-00000000ff01';
const USER = 'de7a11de-0a11-4a11-8a11-00000000ee01';
const ORG_B = 'de7a11de-0a11-4a11-8a11-00000000ff02';
const ORDER_ID = 'depth-order-1';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

async function cleanup() {
  for (const b of [BRAND_A, BRAND_B]) await superPool.query(`DELETE FROM brand WHERE id=$1`, [b]).catch(() => {});
  for (const o of [ORG, ORG_B]) await superPool.query(`DELETE FROM organization WHERE id=$1`, [o]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000, max: 4 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP_URL, max: 4 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'OD',$2,$3)`, [ORG, `od-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'ODB',$2,$3)`, [ORG_B, `odb-${ORG_B.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'OD','INR','active')`, [BRAND_A, ORG]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'ODB','INR','active')`, [BRAND_B, ORG_B]);
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

describe('getOrderDetail (Iceberg-only Bronze, honest not_found without StarRocks)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[order-detail] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('returns honest not_found when StarRocks (srPool) is not wired — never PG fallback', async () => {
    if (!pgAvailable) return;
    const r = await getOrderDetail(BRAND_A, ORDER_ID, { pool: appPool });
    expect(r.state).toBe('not_found');
    expect(r.order_id).toBe(ORDER_ID);
  });

  it('returns not_found for an unknown order (srPool absent, honest empty)', async () => {
    if (!pgAvailable) return;
    const r = await getOrderDetail(BRAND_A, 'no-such-order', { pool: appPool });
    expect(r.state).toBe('not_found');
  });
});
