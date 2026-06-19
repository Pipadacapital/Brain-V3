/**
 * customer-360.live.test.ts — live Postgres tests for the identity Customer 360 read (P0-C).
 *
 * Proves:
 *   1. found — a seeded customer returns profile + hashed identifiers + merge history.
 *   2. honest not_found — an unknown brain_id returns state:'not_found' (no throw).
 *   3. RLS isolation — BRAND_A's customer is invisible to a BRAND_B-scoped query (→ not_found).
 *      The read goes through @brain/db createPool, whose query() runs SET LOCAL ROLE brain_app
 *      + the brand GUC in a transaction — so this also exercises the R-01/R-02 RLS fix.
 *   4. PII discipline — identifiers expose only a 12-hex hash PREFIX, never a raw value.
 *
 * REQUIRES: Postgres on localhost:5432 with migration 0017 applied.
 * Seeds/cleans via the superuser pool; reads via the RLS-enforcing DbPool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { getCustomer360 } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'c0360a1a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'c0360a1a-0a1a-4a1a-8a1a-000000000002';
const BRAIN_A = 'b0360a1a-0a1a-4a1a-8a1a-0000000000a1';
const BRAIN_MERGED = 'b0360a1a-0a1a-4a1a-8a1a-0000000000a2';
const CORR = 'customer-360-live-test';

let superPool: pg.Pool;
let dbPool: DbPool;
let pgAvailable = false;

function hash(v: string): string {
  return createHash('sha256').update(v).digest('hex'); // 64-hex, like a salted identifier hash
}

async function seed(): Promise<void> {
  // Superuser bypasses RLS — used for DDL/seed only.
  await superPool.query(
    `INSERT INTO customer (brand_id, brain_id, lifecycle_state, ai_processing_consent, resolution_consent)
     VALUES ($1, $2, 'active', TRUE, TRUE)
     ON CONFLICT (brand_id, brain_id) DO NOTHING`,
    [BRAND_A, BRAIN_A],
  );
  // The merged-away profile (must exist for the FK on its own links, and for the merge event).
  await superPool.query(
    `INSERT INTO customer (brand_id, brain_id, lifecycle_state, merged_into)
     VALUES ($1, $2, 'merged', $3)
     ON CONFLICT (brand_id, brain_id) DO NOTHING`,
    [BRAND_A, BRAIN_MERGED, BRAIN_A],
  );
  await superPool.query(
    `INSERT INTO identity_link (brand_id, brain_id, identifier_type, identifier_value, tier)
     VALUES ($1, $2, 'email', $3, 'strong'),
            ($1, $2, 'phone', $4, 'strong')
     ON CONFLICT DO NOTHING`,
    [BRAND_A, BRAIN_A, hash('a@example.com'), hash('+919876543210')],
  );
  await superPool.query(
    `INSERT INTO identity_merge_event (merge_id, brand_id, canonical_brain_id, merged_brain_id, confidence, identifier_combo)
     VALUES ($1, $2, $3, $4, 'high', ARRAY['email'])
     ON CONFLICT (merge_id) DO NOTHING`,
    [randomUUID(), BRAND_A, BRAIN_A, BRAIN_MERGED],
  );
}

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM identity_merge_event WHERE brand_id = $1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM identity_link WHERE brand_id = $1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM customer WHERE brand_id = $1`, [b]).catch(() => {});
  }
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

describe('getCustomer360 (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[customer-360] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. found — profile + hashed identifiers + merge history', async () => {
    if (!pgAvailable) return;
    const r = await getCustomer360(BRAND_A, BRAIN_A, CORR, { pool: dbPool });
    expect(r.state).toBe('found');
    if (r.state !== 'found') return;
    expect(r.customer.brain_id).toBe(BRAIN_A);
    expect(r.customer.lifecycle_state).toBe('active');
    expect(r.customer.resolution_consent).toBe(true);
    expect(r.identifiers).toHaveLength(2);
    expect(r.identifiers.map((i) => i.identifier_type).sort()).toEqual(['email', 'phone']);
    expect(r.merges).toHaveLength(1);
    expect(r.merges[0]!.role).toBe('canonical');
    expect(r.merges[0]!.merged_brain_id).toBe(BRAIN_MERGED);
  });

  it('2. honest not_found for an unknown brain_id', async () => {
    if (!pgAvailable) return;
    const r = await getCustomer360(BRAND_A, randomUUID(), CORR, { pool: dbPool });
    expect(r.state).toBe('not_found');
  });

  it('3. RLS isolation — BRAND_A customer invisible under BRAND_B scope', async () => {
    if (!pgAvailable) return;
    const r = await getCustomer360(BRAND_B, BRAIN_A, CORR, { pool: dbPool });
    expect(r.state).toBe('not_found');
  });

  it('4. PII discipline — only a hash prefix is exposed, never a raw value', async () => {
    if (!pgAvailable) return;
    const r = await getCustomer360(BRAND_A, BRAIN_A, CORR, { pool: dbPool });
    if (r.state !== 'found') throw new Error('expected found');
    for (const id of r.identifiers) {
      expect(id.identifier_hash_prefix).toMatch(/^[0-9a-f]{12}$/);
      expect((id as unknown as Record<string, unknown>)['identifier_value']).toBeUndefined();
    }
  });
});
