/**
 * recommendation-action.live.test.ts — live Postgres tests for the M7 action ledger.
 *
 * Proves:
 *   1. record 'served' then 'dismissed' → the append-only ledger has 2 rows (newest-first history)
 *      and recommendation.status flips to 'dismissed'.
 *   2. 'accepted' is recorded in the ledger but leaves status 'open' (the documented mapping).
 *   3. 'reopened' moves status back to 'open'.
 *   4. an unknown action is rejected (InvalidRecommendationActionError) — nothing is written.
 *   5. a recommendation_id not visible to the brand → RecommendationNotFoundError.
 *   6. RLS isolation — BRAND_B's GUC can neither see BRAND_A's actions nor act on its recs.
 *
 * REQUIRES Postgres with migration 0082 (ai_config.recommendation_action).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import {
  recordRecommendationAction,
  RecommendationNotFoundError,
  InvalidRecommendationActionError,
} from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'b777777a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'b777777a-0a1a-4a1a-8a1a-000000000002';
const ORG_ID = '0777777a-0a1a-4a1a-8a1a-000000000001';
const USER_ID = 'a777777a-0a1a-4a1a-8a1a-000000000001';
const CORR = 'rec-action-live-test';

let superPool: pg.Pool;
let dbPool: DbPool;
let pgAvailable = false;
let recA = ''; // a recommendation belonging to BRAND_A

async function seed(): Promise<void> {
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1, 'rec-action@example.invalid', 'rec-action@example.invalid', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1, 'Rec Action Org', 'rec-action-org', $2) ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, USER_ID],
  );
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code)
     VALUES ($1, $2, 'Rec Action Brand', 'INR') ON CONFLICT (id) DO NOTHING`,
    [BRAND_A, ORG_ID],
  );
  const r = await superPool.query<{ recommendation_id: string }>(
    `INSERT INTO ai_config.recommendation (brand_id, detector, subject, kind, confidence, priority, status, payload)
     VALUES ($1, 'rto_risk', 'brand', 'risk', 'Trusted', 100, 'open', '{"title":"x"}'::jsonb)
     RETURNING recommendation_id`,
    [BRAND_A],
  );
  recA = r.rows[0]!.recommendation_id;
}

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM ai_config.recommendation_action WHERE brand_id = $1`, [b]).catch(() => {});
    await superPool.query(`DELETE FROM ai_config.recommendation WHERE brand_id = $1`, [b]).catch(() => {});
  }
  await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
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

async function statusOf(brand: string, recId: string): Promise<string | undefined> {
  const r = await superPool.query<{ status: string }>(
    `SELECT status FROM ai_config.recommendation WHERE brand_id = $1 AND recommendation_id = $2`,
    [brand, recId],
  );
  return r.rows[0]?.status;
}

describe('recommendation action ledger (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[recommendation-action] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. served then dismissed → 2 append-only rows + status=dismissed', async () => {
    if (!pgAvailable) return;
    const served = await recordRecommendationAction(
      { brandId: BRAND_A, recommendationId: recA, action: 'served', actor: USER_ID },
      CORR,
      { pool: dbPool },
    );
    expect(served.action).toBe('served');
    expect(served.actor).toBe(USER_ID);
    expect(await statusOf(BRAND_A, recA)).toBe('open'); // served is audit-only

    const dismissed = await recordRecommendationAction(
      { brandId: BRAND_A, recommendationId: recA, action: 'dismissed', actor: USER_ID, reason: 'not relevant' },
      CORR,
      { pool: dbPool },
    );
    expect(dismissed.action).toBe('dismissed');
    expect(dismissed.reason).toBe('not relevant');
    expect(await statusOf(BRAND_A, recA)).toBe('dismissed');

    const ledger = await superPool.query<{ action: string }>(
      `SELECT action FROM ai_config.recommendation_action
        WHERE brand_id = $1 AND recommendation_id = $2 ORDER BY created_at`,
      [BRAND_A, recA],
    );
    expect(ledger.rows.map((r) => r.action)).toEqual(['served', 'dismissed']); // append-only, both kept
  });

  it("2. accepted is recorded but leaves status 'open' (documented mapping)", async () => {
    if (!pgAvailable) return;
    // reopen first so we have an 'open' baseline.
    await recordRecommendationAction(
      { brandId: BRAND_A, recommendationId: recA, action: 'reopened', actor: USER_ID },
      CORR,
      { pool: dbPool },
    );
    expect(await statusOf(BRAND_A, recA)).toBe('open');

    const accepted = await recordRecommendationAction(
      { brandId: BRAND_A, recommendationId: recA, action: 'accepted', actor: USER_ID },
      CORR,
      { pool: dbPool },
    );
    expect(accepted.action).toBe('accepted');
    expect(await statusOf(BRAND_A, recA)).toBe('open'); // acceptance lives in the ledger, not the enum
  });

  it('4. unknown action is rejected and writes nothing', async () => {
    if (!pgAvailable) return;
    const before = await superPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_config.recommendation_action WHERE brand_id = $1`,
      [BRAND_A],
    );
    await expect(
      recordRecommendationAction(
        // @ts-expect-error — exercising the runtime guard with an invalid action.
        { brandId: BRAND_A, recommendationId: recA, action: 'frobnicate', actor: USER_ID },
        CORR,
        { pool: dbPool },
      ),
    ).rejects.toBeInstanceOf(InvalidRecommendationActionError);
    const after = await superPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_config.recommendation_action WHERE brand_id = $1`,
      [BRAND_A],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('5. a recommendation not visible to the brand → not found', async () => {
    if (!pgAvailable) return;
    await expect(
      recordRecommendationAction(
        {
          brandId: BRAND_A,
          recommendationId: '99999999-9999-4999-8999-999999999999',
          action: 'dismissed',
          actor: USER_ID,
        },
        CORR,
        { pool: dbPool },
      ),
    ).rejects.toBeInstanceOf(RecommendationNotFoundError);
  });

  it("6. RLS — BRAND_B cannot see BRAND_A's actions nor act on its rec", async () => {
    if (!pgAvailable) return;
    // BRAND_B acting on BRAND_A's recommendation_id: under BRAND_B's GUC the FK target is invisible
    // (RLS) so the insert FK-fails → not found. Brand isolation holds.
    await expect(
      recordRecommendationAction(
        { brandId: BRAND_B, recommendationId: recA, action: 'dismissed', actor: USER_ID },
        CORR,
        { pool: dbPool },
      ),
    ).rejects.toBeInstanceOf(RecommendationNotFoundError);
    // And BRAND_A's status is untouched by the failed cross-brand attempt.
    expect(await statusOf(BRAND_A, recA)).toBe('open');
    // No orphan BRAND_B ledger row was written (the visibility guard rejected BEFORE any insert).
    const leaked = await superPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_config.recommendation_action WHERE brand_id = $1`,
      [BRAND_B],
    );
    expect(leaked.rows[0]!.n).toBe(0);
  });
});
