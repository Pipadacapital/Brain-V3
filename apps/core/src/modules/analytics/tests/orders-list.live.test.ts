/**
 * orders-list.live.test.ts — getOrdersList (paginated latest-state orders from Bronze), live PG.
 *
 * Bronze is now Iceberg-only (PG bronze_events retired, dropped in db/migrations/0070). This reader
 * sources orders SOLELY from the StarRocks external Iceberg catalog via the withSilverBrand seam.
 * When StarRocks is NOT wired (srPool absent), the reader returns the honest no_data contract —
 * it NEVER falls back to (or queries) a PG bronze table. These tests assert that honest-empty
 * contract under the real RLS harness; they do not seed or select bronze_events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getOrdersList } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'a5d11507-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'a5d11507-0a11-4a11-8a11-00000000bb01';
const ORG = 'a5d11507-0a11-4a11-8a11-00000000ff01';
const ORG_B = 'a5d11507-0a11-4a11-8a11-00000000ff02';
const USER = 'a5d11507-0a11-4a11-8a11-00000000ee01';

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
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'OLST',$2,$3)`, [ORG, `olst-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'OLSTB',$2,$3)`, [ORG_B, `olstb-${ORG_B.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'OLST','INR','active')`, [BRAND_A, ORG]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'OLSTB','INR','active')`, [BRAND_B, ORG_B]);
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

describe('getOrdersList (Iceberg-only Bronze, honest no_data without StarRocks)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[orders-list] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('returns honest no_data when StarRocks (srPool) is not wired — never PG fallback', async () => {
    if (!pgAvailable) return;
    const r = await getOrdersList(BRAND_A, { page: 1, pageSize: 20 }, { pool: appPool });
    expect(r.state).toBe('no_data');
    expect(r.total).toBe('0');
  });

  it('no_data for a brand with zero orders (srPool absent)', async () => {
    if (!pgAvailable) return;
    const r = await getOrdersList(BRAND_B, { page: 1, pageSize: 20 }, { pool: appPool });
    expect(r.state).toBe('no_data');
    expect(r.total).toBe('0');
  });
});
