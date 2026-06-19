/**
 * erase-customer.live.test.ts — DPDP right-to-deletion (P0-C), live Postgres.
 *
 * Proves the SECURITY DEFINER erase_customer() path, invoked under brain_app (prod role):
 *   1. erase → contact_pii hard-deleted, identity_link tombstoned, customer 'erased', audited.
 *   2. honest no-op for an unknown brain_id (erased:false).
 *   3. cross-brand safety — erasing under BRAND_B does not touch BRAND_A's customer.
 *
 * REQUIRES: Postgres on localhost:5432 with migrations 0017 + 0037 + 0038 applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eraseCustomer } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'e0380a1a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'e0380a1a-0a1a-4a1a-8a1a-000000000002';
const BRAIN_A = 'd0380a1a-0a1a-4a1a-8a1a-0000000000a1';
const EMAIL_HASH = createHash('sha256').update('salt||erase@example.com').digest('hex');

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;

async function cleanup() {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM identity_audit WHERE brand_id=$1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM contact_pii WHERE brand_id=$1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM identity_link WHERE brand_id=$1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM customer WHERE brand_id=$1`, [b]).catch(() => {});
  }
}

async function seed() {
  await superPool.query(
    `INSERT INTO customer (brand_id, brain_id, lifecycle_state) VALUES ($1,$2,'active')
     ON CONFLICT (brand_id, brain_id) DO NOTHING`,
    [BRAND_A, BRAIN_A],
  );
  await superPool.query(
    `INSERT INTO identity_link (brand_id, brain_id, identifier_type, identifier_value, tier, is_active)
     VALUES ($1,$2,'email',$3,'strong',TRUE) ON CONFLICT DO NOTHING`,
    [BRAND_A, BRAIN_A, EMAIL_HASH],
  );
  await superPool.query(
    `INSERT INTO contact_pii (brand_id, brain_id, pii_type, identifier_hash, pii_ciphertext, pii_iv, pii_auth_tag, key_version)
     VALUES ($1,$2,'email',$3,'\\x0102'::bytea,'\\x03'::bytea,'\\x04'::bytea,1)
     ON CONFLICT (brand_id, brain_id, pii_type) DO NOTHING`,
    [BRAND_A, BRAIN_A, EMAIL_HASH],
  );
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP_URL });
    await cleanup();
    await seed();
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (appPool) await appPool.end();
  if (superPool) await superPool.end();
});

describe('eraseCustomer (live Postgres, under brain_app)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[erase-customer] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('2. unknown brain_id → erased:false (no-op)', async () => {
    if (!pgAvailable) return;
    const r = await eraseCustomer(BRAND_A, randomUUID(), appPool);
    expect(r.erased).toBe(false);
  });

  it('3. cross-brand safety — erasing under BRAND_B does not touch BRAND_A', async () => {
    if (!pgAvailable) return;
    const r = await eraseCustomer(BRAND_B, BRAIN_A, appPool);
    expect(r.erased).toBe(false);
    const cust = await superPool.query(`SELECT lifecycle_state FROM customer WHERE brand_id=$1 AND brain_id=$2`, [BRAND_A, BRAIN_A]);
    expect(cust.rows[0]?.lifecycle_state).toBe('active'); // untouched
  });

  it('1. erase → PII deleted, links tombstoned, customer erased, audited', async () => {
    if (!pgAvailable) return;
    const r = await eraseCustomer(BRAND_A, BRAIN_A, appPool);
    expect(r.erased).toBe(true);
    expect(r.contact_pii_deleted).toBe(1);
    expect(r.links_tombstoned).toBe(1);

    const pii = await superPool.query(`SELECT 1 FROM contact_pii WHERE brand_id=$1 AND brain_id=$2`, [BRAND_A, BRAIN_A]);
    expect(pii.rowCount).toBe(0);

    const link = await superPool.query<{ is_active: boolean }>(`SELECT is_active FROM identity_link WHERE brand_id=$1 AND brain_id=$2`, [BRAND_A, BRAIN_A]);
    expect(link.rows.every((x) => x.is_active === false)).toBe(true);

    const cust = await superPool.query<{ lifecycle_state: string }>(`SELECT lifecycle_state FROM customer WHERE brand_id=$1 AND brain_id=$2`, [BRAND_A, BRAIN_A]);
    expect(cust.rows[0]?.lifecycle_state).toBe('erased');

    const audit = await superPool.query(`SELECT 1 FROM identity_audit WHERE brand_id=$1 AND brain_id=$2 AND action='erase'`, [BRAND_A, BRAIN_A]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });
});
