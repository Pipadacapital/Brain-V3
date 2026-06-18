/**
 * dq-isolation.live.test.ts — feat-data-quality-engine Track A (NON-INERT isolation).
 *
 * Proves dq_check_result per-brand RLS is REAL (not inert) under brain_app:
 *
 *   - Asserts current_user='brain_app' AND is_superuser=false FIRST. Without this the
 *     dev superuser 'brain' BYPASSES RLS and the test would FALSE-PASS (MEMORY:
 *     dev-db-superuser-masks-rls). The assertion is the non-inert guard.
 *   - Seeds dq_check_result rows for BRAND_A and BRAND_B.
 *   - Under BRAND_A's GUC: COUNT(*) sees ONLY A's rows; a cross-brand read for B → 0.
 *   - Negative control: superuser (RLS-bypassing) sees BOTH brands → proves the 0 above
 *     was RLS filtering, not an empty DB.
 *   - Append-only: brain_app cannot UPDATE/DELETE dq_check_result (42501 under RLS grants).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'dafdafda-0000-4000-8000-0000000000a1';
const BRAND_B = 'dafdafda-0000-4000-8000-0000000000b2';

let superPool: pg.Pool;
let appPool: pg.Pool;

/** Seed a dq_check_result row for a brand under the superuser (bypass RLS for setup). */
async function seedResult(brandId: string, grade = 'A+'): Promise<void> {
  await superPool.query(
    `INSERT INTO dq_check_result
       (result_id, brand_id, category, target, grade, score, observed, threshold, passing)
     VALUES ($1, $2, 'freshness', 'bronze_events', $3, '0.0000', '5', '60', true)`,
    [randomUUID(), brandId, grade],
  );
}

async function clear(brandId: string): Promise<void> {
  await superPool.query('DELETE FROM dq_check_result WHERE brand_id = $1', [brandId]);
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });
  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');
  const org = await superPool.query<{ id: string }>(`SELECT id FROM organization LIMIT 1`);
  const orgId = org.rows[0]?.id;
  for (const [id, name] of [
    [BRAND_A, 'A dq'],
    [BRAND_B, 'B dq'],
  ] as const) {
    await superPool.query(
      `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
       VALUES ($1,$2,$3,'INR','active') ON CONFLICT (id) DO UPDATE SET status='active'`,
      [id, orgId, `Test Brand ${name}`],
    );
  }
  await clear(BRAND_A);
  await clear(BRAND_B);
}, 30_000);

afterAll(async () => {
  await clear(BRAND_A);
  await clear(BRAND_B);
  await superPool.end().catch(() => {});
  await appPool.end().catch(() => {});
});

describe('dq_check_result — NON-INERT tenant isolation under brain_app', () => {
  it('brand A reads only its rows; cross-brand B read = 0; superuser sees both', async () => {
    await seedResult(BRAND_A);
    await seedResult(BRAND_B);

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);

      // NON-INERT guard: must be brain_app + NOT superuser, else RLS is bypassed (false-pass).
      const ctx = await client.query<{ u: string; s: boolean }>(
        `SELECT current_user AS u,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s`,
      );
      expect(ctx.rows[0]!.u).toBe('brain_app');
      expect(ctx.rows[0]!.s).toBe(false);

      // Under A's GUC: ONLY A's row is visible (B filtered by RLS).
      const all = await client.query<{ n: string }>(`SELECT COUNT(*) n FROM dq_check_result`);
      expect(Number(all.rows[0]!.n)).toBe(1);

      // Cross-brand read for B under A's GUC → 0 (the explicit non-inert assertion).
      const crossB = await client.query<{ n: string }>(
        `SELECT COUNT(*) n FROM dq_check_result WHERE brand_id = $1`,
        [BRAND_B],
      );
      expect(Number(crossB.rows[0]!.n)).toBe(0);

      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Negative control: superuser bypasses RLS → sees BOTH → the 0 above was RLS, not empty DB.
    const both = await superPool.query<{ n: string }>(
      `SELECT COUNT(*) n FROM dq_check_result WHERE brand_id IN ($1,$2)`,
      [BRAND_A, BRAND_B],
    );
    expect(Number(both.rows[0]!.n)).toBe(2);
  });

  it('append-only: brain_app cannot UPDATE or DELETE dq_check_result', async () => {
    await clear(BRAND_A);
    await seedResult(BRAND_A);
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      await expect(
        client.query(`UPDATE dq_check_result SET grade = 'D' WHERE brand_id = $1`, [BRAND_A]),
      ).rejects.toThrow(/permission denied|42501/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const client2 = await appPool.connect();
    try {
      await client2.query('BEGIN');
      await client2.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      await expect(
        client2.query(`DELETE FROM dq_check_result WHERE brand_id = $1`, [BRAND_A]),
      ).rejects.toThrow(/permission denied|42501/i);
      await client2.query('ROLLBACK');
    } finally {
      client2.release();
    }
  });
});
