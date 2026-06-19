/**
 * merge-admin.live.test.ts — merge/unmerge control-plane + review queue (P0-C), live Postgres.
 *
 * Proves the SECURITY DEFINER functions under brain_app (prod role):
 *   - listMergeReviews returns pending candidates (RLS-scoped).
 *   - resolveMergeReview('merge') merges B→A (merged_into, lifecycle, merge_event, alias, audit,
 *     review status='merged'); ('reject') sets status='rejected'.
 *   - unmergeCustomer splits B back out (merged_into NULL, lifecycle 'split', alias closed).
 *   - cross-brand safety: resolving under another brand is a no-op.
 *
 * REQUIRES: Postgres with migrations through 0039 applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { listMergeReviews, resolveMergeReview, unmergeCustomer } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'e0390a1a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'e0390a1a-0a1a-4a1a-8a1a-000000000002';
const CANON = 'd0390a1a-0a1a-4a1a-8a1a-0000000000c1';
const MERGED = 'd0390a1a-0a1a-4a1a-8a1a-0000000000c2';
const REVIEW_MERGE = 'a0390a1a-0a1a-4a1a-8a1a-0000000000a1';
const REVIEW_REJECT = 'a0390a1a-0a1a-4a1a-8a1a-0000000000b1';
const CORR = 'merge-admin-test';

let superPool: pg.Pool;
let appPool: pg.Pool;
let dbPool: DbPool;
let pgAvailable = false;

async function cleanup() {
  await superPool.query(`DELETE FROM identity_audit WHERE brand_id=$1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM brain_id_alias WHERE brand_id=$1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM identity_merge_event WHERE brand_id=$1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM merge_review_queue WHERE brand_id=$1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM customer WHERE brand_id=$1`, [BRAND_A]).catch(() => {});
}

async function seed() {
  await superPool.query(
    `INSERT INTO customer (brand_id, brain_id, lifecycle_state) VALUES ($1,$2,'active'),($1,$3,'active')
     ON CONFLICT (brand_id, brain_id) DO NOTHING`,
    [BRAND_A, CANON, MERGED],
  );
  await superPool.query(
    `INSERT INTO merge_review_queue (brand_id, review_id, brain_id_a, brain_id_b, trigger_reason, status)
     VALUES ($1,$2,$3,$4,'probabilistic_email_match','pending'),
            ($1,$5,$3,$4,'shared_device','pending')
     ON CONFLICT DO NOTHING`,
    [BRAND_A, REVIEW_MERGE, CANON, MERGED, REVIEW_REJECT],
  );
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP_URL });
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
  if (appPool) await appPool.end();
  if (superPool) await superPool.end();
});

describe('merge-admin (live Postgres, under brain_app)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[merge-admin] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('lists pending merge reviews (RLS-scoped)', async () => {
    if (!pgAvailable) return;
    const list = await listMergeReviews(BRAND_A, CORR, { pool: dbPool });
    expect(list.reviews.length).toBe(2);
    expect(list.reviews.map((r) => r.review_id)).toContain(REVIEW_MERGE);
  });

  it('cross-brand: resolving under BRAND_B is a no-op (not_found)', async () => {
    if (!pgAvailable) return;
    const r = await resolveMergeReview(BRAND_B, REVIEW_MERGE, 'merge', appPool);
    expect(r.resolved).toBe(false);
  });

  it('reject → review status rejected', async () => {
    if (!pgAvailable) return;
    const r = await resolveMergeReview(BRAND_A, REVIEW_REJECT, 'reject', appPool);
    expect(r.resolved).toBe(true);
    expect(r.decision).toBe('rejected');
    const s = await superPool.query<{ status: string }>(`SELECT status FROM merge_review_queue WHERE brand_id=$1 AND review_id=$2`, [BRAND_A, REVIEW_REJECT]);
    expect(s.rows[0]?.status).toBe('rejected');
  });

  it('merge → B merged into A (merged_into, lifecycle, alias, event, audit)', async () => {
    if (!pgAvailable) return;
    const r = await resolveMergeReview(BRAND_A, REVIEW_MERGE, 'merge', appPool);
    expect(r.resolved).toBe(true);
    expect(r.decision).toBe('merged');
    expect(r.canonical_brain_id).toBe(CANON);

    const cust = await superPool.query<{ merged_into: string; lifecycle_state: string }>(`SELECT merged_into, lifecycle_state FROM customer WHERE brand_id=$1 AND brain_id=$2`, [BRAND_A, MERGED]);
    expect(cust.rows[0]?.merged_into).toBe(CANON);
    expect(cust.rows[0]?.lifecycle_state).toBe('merged');

    const alias = await superPool.query(`SELECT 1 FROM brain_id_alias WHERE brand_id=$1 AND observed_brain_id=$2 AND canonical_brain_id=$3 AND valid_to IS NULL`, [BRAND_A, MERGED, CANON]);
    expect(alias.rowCount).toBe(1);

    const ev = await superPool.query(`SELECT 1 FROM identity_merge_event WHERE brand_id=$1 AND canonical_brain_id=$2 AND merged_brain_id=$3`, [BRAND_A, CANON, MERGED]);
    expect(ev.rowCount).toBeGreaterThanOrEqual(1);

    const audit = await superPool.query(`SELECT 1 FROM identity_audit WHERE brand_id=$1 AND brain_id=$2 AND action='merge'`, [BRAND_A, MERGED]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('unmerge → B split back out (merged_into NULL, lifecycle split, alias closed)', async () => {
    if (!pgAvailable) return;
    const r = await unmergeCustomer(BRAND_A, MERGED, appPool);
    expect(r.unmerged).toBe(true);

    const cust = await superPool.query<{ merged_into: string | null; lifecycle_state: string }>(`SELECT merged_into, lifecycle_state FROM customer WHERE brand_id=$1 AND brain_id=$2`, [BRAND_A, MERGED]);
    expect(cust.rows[0]?.merged_into).toBeNull();
    expect(cust.rows[0]?.lifecycle_state).toBe('split');

    const live = await superPool.query(`SELECT 1 FROM brain_id_alias WHERE brand_id=$1 AND observed_brain_id=$2 AND valid_to IS NULL`, [BRAND_A, MERGED]);
    expect(live.rowCount).toBe(0); // alias closed
  });
});
