/**
 * phone-guard-reeval.live.test.ts — the job must ENUMERATE active brands under brain_app.
 *
 * The job connects as brain_app (FORCE RLS). It previously enumerated brands with a bare
 * `SELECT id FROM brand` under no app.current_brand_id GUC, which returns ZERO rows (NN-1
 * fail-closed) — so the whole re-evaluation silently no-op'd and expired suppressions were
 * never lifted (a slow LTV-breaking bug at prod COD volume). The fix routes enumeration through
 * the `list_active_brand_ids()` SECURITY DEFINER fn (durable rule system-job-force-rls-enumeration).
 *
 * This test seeds an EXPIRED suppression with zero live links (count 0 ≤ threshold) and asserts the
 * job un-suppresses it. Before the fix it stays suppressed (enumeration found no brands) → RED.
 *
 * REQUIRES Postgres with migrations 0017 (identity graph) + 0019 (list_active_brand_ids).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runPhoneGuardReeval } from '../jobs/phone-guard-reeval.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'a9000a1a-0a1a-4a1a-8a1a-000000000a01';
const ORG = 'a9000a1a-0a1a-4a1a-8a1a-0000000000f1';
const USER = 'a9000a1a-0a1a-4a1a-8a1a-0000000000e1';
const PHONE_HASH = 'a'.repeat(64); // 64-hex sentinel (never raw PII)

let superPool: pg.Pool;
let pgAvailable = false;

async function cleanup() {
  await superPool.query(`DELETE FROM shared_utility_identifier WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    await cleanup();
    await superPool.query(
      `INSERT INTO app_user (id,email,email_normalized,password_hash)
       VALUES ($1,'pg@example.invalid','pg@example.invalid','x') ON CONFLICT (id) DO NOTHING`, [USER]);
    await superPool.query(
      `INSERT INTO organization (id,name,slug,owner_user_id)
       VALUES ($1,'PG Org','pg-org',$2) ON CONFLICT (id) DO NOTHING`, [ORG, USER]);
    // threshold 10 / window 30 defaults; status active so list_active_brand_ids() returns it.
    await superPool.query(
      `INSERT INTO brand (id,organization_id,display_name,currency_code,status)
       VALUES ($1,$2,'PG Brand','INR','active') ON CONFLICT (id) DO NOTHING`, [BRAND, ORG]);
    // An EXPIRED suppression (suppressed_until in the past) with zero live links → must un-suppress.
    await superPool.query(
      `INSERT INTO shared_utility_identifier
         (brand_id, identifier_type, identifier_value, profile_count, suppressed_until, window_days, reason)
       VALUES ($1,'phone',$2,50, NOW() - INTERVAL '1 day', 30, 'flagged')
       ON CONFLICT (brand_id, identifier_type, identifier_value)
       DO UPDATE SET suppressed_until = NOW() - INTERVAL '1 day', reason='flagged'`,
      [BRAND, PHONE_HASH]);
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (superPool) await superPool.end();
});

describe('phone-guard-reeval enumerates under brain_app (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[phone-guard-reeval] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('un-suppresses an expired suppression with zero live links (was a no-op before the fix)', async () => {
    if (!pgAvailable) return;
    // The job uses BRAIN_APP_DATABASE_URL internally (brain_app, FORCE RLS).
    process.env['BRAIN_APP_DATABASE_URL'] = APP;
    await runPhoneGuardReeval();

    const res = await superPool.query<{ suppressed_until: Date | null; reason: string | null }>(
      `SELECT suppressed_until, reason FROM shared_utility_identifier
       WHERE brand_id=$1 AND identifier_type='phone' AND identifier_value=$2`,
      [BRAND, PHONE_HASH]);
    expect(res.rows[0]?.suppressed_until).toBeNull(); // un-suppressed (proves the brand WAS enumerated)
    expect(res.rows[0]?.reason).toBe('reeval_count_below_threshold');
  });
});
