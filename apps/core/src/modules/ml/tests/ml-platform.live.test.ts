/**
 * ml-platform.live.test.ts — live tests for the C5 ML platform application layer.
 *
 * Proves:
 *   1. listModels returns the brand's registry rows (DTO; ISO timestamps).
 *   2. promoteModel staging→production ARCHIVES the prior production model of the same (brand,name)
 *      and leaves EXACTLY ONE production row (the partial-unique invariant model_registry_one_production).
 *   3. promoteModel rejects an unknown model (ModelNotFoundError) and an unknown stage.
 *   4. serveCustomerScore writes EXACTLY ONE inference row to the OPERATIONAL log (PG
 *      ops.ops_ml_prediction_log — V4 StarRocks REMOVAL, migration 0116; PG is the SOLE operational store)
 *      and is cross-brand isolated — another brand sees neither the score nor the logged prediction. When
 *      the brand has a Gold score row it returns has_data; otherwise the honest no_data path.
 *   5. [EVAL GATE] promoteModel to production blocks a sklearn model with sub-baseline AUC (0.01)
 *      via EvalGateError — the historical gap where any metrics could ship is closed.
 *
 * BRAIN V4: StarRocks and Trino are REMOVED (ADR-0014). The Gold customer-score read runs over DUCKDB-SERVING (the brain_serving
 * view mv_gold_customer_scores over iceberg.brain_gold.gold_customer_scores) through the metric-engine
 * seam; srPool is a duckdb-serving pool (createDuckDbServingPool). The inference-log write goes to PG
 * ops.ops_ml_prediction_log. Serving-dependent assertions degrade to the honest no_data path when the
 * serving tier is unavailable / has no score row — never a hard suite failure on a missing engine.
 *
 * REQUIRES: Postgres (migrations 0083 + 0116 applied). The Gold score read additionally needs duckdb-serving
 * on :8091 with the brain_serving views over Iceberg; absent serving → the score read returns no_data (PENDING).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { createDuckDbServingPool, type SilverPool } from '@brain/metric-engine';
import {
  listModels,
  promoteModel,
  serveCustomerScore,
  ModelNotFoundError,
  InvalidModelStageError,
  EvalGateError,
} from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SERVING_URL =
  process.env['DUCKDB_SERVING_URL'] ??
  `http://${process.env['DUCKDB_SERVING_HOST'] ?? '127.0.0.1'}:${process.env['DUCKDB_SERVING_PORT'] ?? '8091'}`;

const BRAND_A = 'c5111111-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'c5111111-0a1a-4a1a-8a1a-000000000002';
const ORG_ID = 'c5000000-0a1a-4a1a-8a1a-000000000001';
const USER_ID = 'c5aaaaaa-0a1a-4a1a-8a1a-000000000001';
const NAME = 'customer_churn_rfm';
const CORR = 'ml-platform-live-test';

let superPool: pg.Pool;
let rawPool: pg.Pool;
let dbPool: DbPool;
let srPool: SilverPool; // Brain V4: a duckdb-serving pool (createDuckDbServingPool) — the serving read port.
let pgAvailable = false;
let servingUp = false;
let prodModelA = '';
let stagingModelA = '';
/** A sklearn staging model with auc=0.01 — should be blocked by the eval gate. */
let subBaselineModelA = '';

async function seed(): Promise<void> {
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1, 'ml-platform@example.invalid', 'ml-platform@example.invalid', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1, 'ML Platform Org', 'ml-platform-org', $2) ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, USER_ID],
  );
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(
      `INSERT INTO brand (id, organization_id, display_name, currency_code)
       VALUES ($1, $2, 'ML Brand', 'INR') ON CONFLICT (id) DO NOTHING`,
      [b, ORG_ID],
    );
  }
  // BRAND_A: a production v0 + a staging v1 of the same name (the promote-archives target).
  const prod = await superPool.query<{ model_id: string }>(
    `INSERT INTO ml.model_registry (brand_id, name, version, stage, framework)
     VALUES ($1, $2, 'v0', 'production', 'deterministic') RETURNING model_id`,
    [BRAND_A, NAME],
  );
  prodModelA = prod.rows[0]!.model_id;
  const staging = await superPool.query<{ model_id: string }>(
    `INSERT INTO ml.model_registry (brand_id, name, version, stage, framework, metrics)
     VALUES ($1, $2, 'v1', 'staging', 'deterministic', '{"auc":0.81}'::jsonb) RETURNING model_id`,
    [BRAND_A, NAME],
  );
  stagingModelA = staging.rows[0]!.model_id;

  // A sklearn staging model with auc=0.01 — the historical gap. The eval gate must block this.
  const subBaseline = await superPool.query<{ model_id: string }>(
    `INSERT INTO ml.model_registry (brand_id, name, version, stage, framework, metrics)
     VALUES ($1, $2, 'v2-subbaseline', 'staging', 'sklearn', '{"auc":0.01,"precision":0.05,"recall":0.05,"f1":0.05,"accuracy":0.3}'::jsonb) RETURNING model_id`,
    [BRAND_A, NAME],
  );
  subBaselineModelA = subBaseline.rows[0]!.model_id;
}

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    // V4 (migration 0116): the inference log lives in PG ops.ops_ml_prediction_log (PG is the SOLE
    // operational store; StarRocks removed). DELETE via superuser so re-runs start clean (the table is
    // append-only for brain_app, but the superuser test pool may DELETE).
    await superPool
      .query(`DELETE FROM ops.ops_ml_prediction_log WHERE brand_id = $1`, [b])
      .catch(() => {});
    await superPool.query(`DELETE FROM ml.model_registry WHERE brand_id = $1`, [b]).catch(() => {});
  }
  await superPool.query(`DELETE FROM brand WHERE id = ANY($1)`, [[BRAND_A, BRAND_B]]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    rawPool = new pg.Pool({ connectionString: APP_URL, connectionTimeoutMillis: 4000 });
    dbPool = await createPool({ connectionString: APP_URL });
    // Brain V4 serving: a duckdb-serving pool (createDuckDbServingPool) — used ONLY for the Gold score read via the
    // metric-engine seam (brain_serving.mv_gold_customer_scores over Iceberg). The inference-log write
    // targets PG ops.ops_ml_prediction_log (migration 0116, created by migrate). StarRocks is removed.
    srPool = createDuckDbServingPool({ baseUrl: SERVING_URL });
    await cleanup();
    await seed();
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }

  // Probe duckdb-serving independently — the Gold score read PENDINGs (no_data) when the serving tier is down.
  try {
    await srPool.query('SELECT 1');
    servingUp = true;
  } catch {
    servingUp = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (dbPool) await dbPool.end();
  if (rawPool) await rawPool.end();
  if (superPool) await superPool.end();
  // The serving pool is a stateless HTTP adapter — no connection to close.
});

async function productionCount(brand: string): Promise<number> {
  const r = await superPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ml.model_registry WHERE brand_id = $1 AND name = $2 AND stage = 'production'`,
    [brand, NAME],
  );
  return r.rows[0]!.n;
}

async function predictionCount(brand: string): Promise<number> {
  // V4 (migration 0116): inference log is the operational PG table ops.ops_ml_prediction_log.
  const r = await superPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.ops_ml_prediction_log WHERE brand_id = $1`,
    [brand],
  );
  return r.rows[0]?.n ?? 0;
}

describe('ml platform (live)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[ml-platform] Postgres unavailable — PENDING.');
    if (!servingUp)
      console.warn('[ml-platform] duckdb-serving tier unavailable — Gold score read PENDING (no_data path).');
    expect(true).toBe(true);
  });

  it('1. listModels returns the brand registry as a DTO with ISO timestamps', async () => {
    if (!pgAvailable) return;
    const models = await listModels(BRAND_A, CORR, { pool: dbPool });
    expect(models.length).toBe(2);
    const prod = models.find((m) => m.model_id === prodModelA)!;
    expect(prod.stage).toBe('production');
    expect(typeof prod.created_at).toBe('string');
    expect(() => new Date(prod.created_at).toISOString()).not.toThrow();
    const staging = models.find((m) => m.model_id === stagingModelA)!;
    expect(staging.metrics).toMatchObject({ auc: 0.81 });
  });

  it('2. promote staging→production archives the prior production (exactly one production remains)', async () => {
    if (!pgAvailable) return;
    expect(await productionCount(BRAND_A)).toBe(1);
    const promoted = await promoteModel(
      BRAND_A,
      { modelId: stagingModelA, toStage: 'production' },
      CORR,
      { rawPool },
    );
    expect(promoted.model_id).toBe(stagingModelA);
    expect(promoted.stage).toBe('production');
    expect(promoted.promoted_at).not.toBeNull();
    // The invariant: exactly one production model for (brand,name).
    expect(await productionCount(BRAND_A)).toBe(1);
    // The prior production was archived.
    const prior = await superPool.query<{ stage: string }>(
      `SELECT stage FROM ml.model_registry WHERE model_id = $1`,
      [prodModelA],
    );
    expect(prior.rows[0]!.stage).toBe('archived');
  });

  it('3. promote rejects an unknown model and an unknown stage', async () => {
    if (!pgAvailable) return;
    await expect(
      promoteModel(BRAND_A, { modelId: '99999999-9999-4999-8999-999999999999', toStage: 'staging' }, CORR, {
        rawPool,
      }),
    ).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(
      // @ts-expect-error — exercising the runtime stage guard.
      promoteModel(BRAND_A, { modelId: stagingModelA, toStage: 'frobnicate' }, CORR, { rawPool }),
    ).rejects.toBeInstanceOf(InvalidModelStageError);
  });

  it('4. serveCustomerScore writes exactly one lakehouse prediction row + is cross-brand isolated', async () => {
    if (!pgAvailable) return;
    // Find a brain_id with a Gold score for SOME brand via the serving view. If duckdb-serving is down or
    // the view is empty, assert the honest no_data path (nothing logged).
    let scoredBrand: string | null = null;
    let scoredBrainId: string | null = null;
    if (servingUp) {
      try {
        const rows = await srPool.query<{ brand_id: string; brain_id: string }>(
          `SELECT brand_id, brain_id FROM brain_serving.mv_gold_customer_scores LIMIT 1`,
        );
        const r = rows[0];
        if (r) {
          scoredBrand = r.brand_id;
          scoredBrainId = r.brain_id;
        }
      } catch {
        scoredBrand = null;
      }
    }

    if (!scoredBrand || !scoredBrainId) {
      // Honest no_data: BRAND_A has no Gold score → state:'no_data', nothing logged.
      const before = await predictionCount(BRAND_A);
      const res = await serveCustomerScore(BRAND_A, 'no-such-brain-id', CORR, { pool: dbPool, srPool });
      expect(res.state).toBe('no_data');
      expect(await predictionCount(BRAND_A)).toBe(before);
      return;
    }

    // has_data: serve for the brand that owns the score; exactly one lakehouse prediction row is appended.
    const before = await predictionCount(scoredBrand);
    const res = await serveCustomerScore(scoredBrand, scoredBrainId, CORR, { pool: dbPool, srPool });
    expect(res.state).toBe('has_data');
    if (res.state === 'has_data') {
      expect(res.score.brain_id).toBe(scoredBrainId);
      expect(typeof res.prediction_id).toBe('string');
    }
    expect(await predictionCount(scoredBrand)).toBe(before + 1);

    // Cross-brand isolation: BRAND_B's GUC sees neither the score nor the logged prediction.
    const isoBefore = await predictionCount(BRAND_B);
    const isoRes = await serveCustomerScore(BRAND_B, scoredBrainId, CORR, { pool: dbPool, srPool });
    expect(isoRes.state).toBe('no_data'); // BRAND_B cannot see another brand's Gold score row
    expect(await predictionCount(BRAND_B)).toBe(isoBefore); // nothing logged for BRAND_B
  });

  it('5. [EVAL GATE] promoteModel blocks a sklearn model with sub-baseline metrics (auc=0.01)', async () => {
    if (!pgAvailable) return;

    // The sub-baseline sklearn model (auc=0.01) must be rejected by the eval gate before any
    // registry write — the registry stays unchanged (no promotion, no archive of the current prod).
    const beforeCount = await productionCount(BRAND_A);

    await expect(
      promoteModel(
        BRAND_A,
        { modelId: subBaselineModelA, toStage: 'production' },
        CORR,
        { rawPool },
      ),
    ).rejects.toBeInstanceOf(EvalGateError);

    // Registry invariant: no promotion happened; production count is unchanged.
    expect(await productionCount(BRAND_A)).toBe(beforeCount);

    // The sub-baseline model itself must still be in 'staging' stage (gate rolled back).
    const statusRow = await superPool.query<{ stage: string }>(
      `SELECT stage FROM ml.model_registry WHERE model_id = $1`,
      [subBaselineModelA],
    );
    expect(statusRow.rows[0]?.stage).toBe('staging');
  });
});
