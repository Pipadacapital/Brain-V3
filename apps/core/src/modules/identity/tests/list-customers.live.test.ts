/**
 * list-customers.live.test.ts — live Postgres tests for the customer BROWSE seam (discover front-door).
 *
 * Proves:
 *   1. browse — lists the active brand's customers, newest-first, with the correct pre-LIMIT total
 *      and a per-customer ACTIVE-identifier count (counts only — never the identifier values).
 *   2. lifecycle filter — restricts to one lifecycle_state.
 *   3. pagination — limit/offset page through the set while total stays the full count.
 *   4. search-by-email — hashing the raw term with the per-brand salt (same as the resolver) finds the
 *      customer carrying that salted identity_link, and the result flags searched:true.
 *   5. RLS isolation — BRAND_A's customers are invisible under a BRAND_B scope (→ empty).
 *   6. PII discipline — rows carry no raw/hashed identifier values, only an identifier_count.
 *
 * REQUIRES: Postgres on localhost:5432 with migrations 0017 + 0057 applied. Seeds/cleans via the
 * superuser pool; reads via the RLS-enforcing DbPool (SET LOCAL ROLE brain_app + brand GUC).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { hashIdentifier, resolveSaltHex } from '@brain/identity-core';
import { listCustomers } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'c115700a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'c115700a-0a1a-4a1a-8a1a-000000000002';
const ORG = 'c115700a-0a1a-4a1a-8a1a-0000000000f1';
const USER = 'c115700a-0a1a-4a1a-8a1a-0000000000e1';
const CORR = 'list-customers-live-test';

// Three customers in BRAND_A: two active, one erased. BRAIN_1 carries an email identity_link whose
// salted hash matches what the use-case computes for 'priya@example.com' (dev salt is deterministic).
const BRAIN_1 = 'b1157001-0a1a-4a1a-8a1a-0000000000a1';
const BRAIN_2 = 'b1157001-0a1a-4a1a-8a1a-0000000000a2';
const BRAIN_3 = 'b1157001-0a1a-4a1a-8a1a-0000000000a3';
const SEARCH_EMAIL = 'priya@example.com';

let superPool: pg.Pool;
let dbPool: DbPool;
let pgAvailable = false;

async function seed(): Promise<void> {
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1, 'lc-test@example.invalid', 'lc-test@example.invalid', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1, 'LC Org', 'lc-test-org', $2) ON CONFLICT (id) DO NOTHING`,
    [ORG, USER],
  );
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code)
     VALUES ($1, $2, 'LC Brand', 'INR') ON CONFLICT (id) DO NOTHING`,
    [BRAND_A, ORG],
  );

  // created_at ascending so BRAIN_3 is newest (browse is newest-first → BRAIN_3 leads).
  await superPool.query(
    `INSERT INTO customer (brand_id, brain_id, lifecycle_state, ai_processing_consent, resolution_consent, created_at)
     VALUES ($1, $2, 'active', TRUE, TRUE, '2026-06-01Z'),
            ($1, $3, 'active', FALSE, TRUE, '2026-06-02Z'),
            ($1, $4, 'erased', FALSE, FALSE, '2026-06-03Z')
     ON CONFLICT (brand_id, brain_id) DO NOTHING`,
    [BRAND_A, BRAIN_1, BRAIN_2, BRAIN_3],
  );

  // BRAIN_1: two active identifiers (one is the searchable email). BRAIN_2: one. BRAIN_3: none.
  const emailHash = hashIdentifier(SEARCH_EMAIL, 'email', resolveSaltHex(BRAND_A));
  await superPool.query(
    `INSERT INTO identity_link (brand_id, brain_id, identifier_type, identifier_value, tier)
     VALUES ($1, $2, 'email', $3, 'strong'),
            ($1, $2, 'phone', $4, 'strong'),
            ($1, $5, 'email', $6, 'strong')
     ON CONFLICT DO NOTHING`,
    [
      BRAND_A,
      BRAIN_1,
      emailHash,
      hashIdentifier('+919811111111', 'phone', resolveSaltHex(BRAND_A)),
      BRAIN_2,
      hashIdentifier('other@example.com', 'email', resolveSaltHex(BRAND_A)),
    ],
  );
}

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM identity_link WHERE brand_id = $1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM customer WHERE brand_id = $1`, [b]).catch(() => {});
  }
  await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    dbPool = await createPool({ connectionString: SUPERUSER_URL });
    await cleanup();
    await seed();
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (dbPool) await dbPool.end();
  if (superPool) await superPool.end();
});

describe('listCustomers (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[list-customers] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. browse — newest-first, correct total + active-identifier counts', async () => {
    if (!pgAvailable) return;
    const r = await listCustomers(BRAND_A, {}, CORR, { pool: dbPool });
    expect(r.total).toBe(3);
    expect(r.searched).toBe(false);
    expect(r.items.map((i) => i.brain_id)).toEqual([BRAIN_3, BRAIN_2, BRAIN_1]); // created_at DESC
    const byId = Object.fromEntries(r.items.map((i) => [i.brain_id, i.identifier_count]));
    expect(byId[BRAIN_1]).toBe(2);
    expect(byId[BRAIN_2]).toBe(1);
    expect(byId[BRAIN_3]).toBe(0);
  });

  it('2. lifecycle filter — only the matching state', async () => {
    if (!pgAvailable) return;
    const r = await listCustomers(BRAND_A, { lifecycle: 'erased' }, CORR, { pool: dbPool });
    expect(r.total).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.brain_id).toBe(BRAIN_3);
    expect(r.items[0]!.lifecycle_state).toBe('erased');
  });

  it('3. pagination — limit/offset page through while total stays full', async () => {
    if (!pgAvailable) return;
    const page1 = await listCustomers(BRAND_A, { limit: 2, offset: 0 }, CORR, { pool: dbPool });
    expect(page1.total).toBe(3);
    expect(page1.items.map((i) => i.brain_id)).toEqual([BRAIN_3, BRAIN_2]);
    const page2 = await listCustomers(BRAND_A, { limit: 2, offset: 2 }, CORR, { pool: dbPool });
    expect(page2.total).toBe(3);
    expect(page2.items.map((i) => i.brain_id)).toEqual([BRAIN_1]);
  });

  it('4. search-by-email — salted-hash match finds the customer, searched:true', async () => {
    if (!pgAvailable) return;
    const r = await listCustomers(BRAND_A, { search: SEARCH_EMAIL }, CORR, { pool: dbPool });
    expect(r.searched).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.brain_id).toBe(BRAIN_1);

    // A non-matching email returns nothing (honest empty), not an error.
    const miss = await listCustomers(BRAND_A, { search: 'nobody@example.com' }, CORR, { pool: dbPool });
    expect(miss.items).toHaveLength(0);
    expect(miss.total).toBe(0);
  });

  it('5. RLS isolation — BRAND_A customers invisible under BRAND_B scope', async () => {
    if (!pgAvailable) return;
    const r = await listCustomers(BRAND_B, {}, CORR, { pool: dbPool });
    expect(r.total).toBe(0);
    expect(r.items).toHaveLength(0);
  });

  it('6. PII discipline — rows carry counts only, no identifier values', async () => {
    if (!pgAvailable) return;
    const r = await listCustomers(BRAND_A, {}, CORR, { pool: dbPool });
    for (const item of r.items) {
      const rec = item as unknown as Record<string, unknown>;
      expect(rec['identifier_value']).toBeUndefined();
      expect(rec['identifier_hash']).toBeUndefined();
      expect(typeof item.identifier_count).toBe('number');
    }
  });
});
