/**
 * serveCustomerScore — serve the deterministic RFM/churn score for one customer (DB-AUDIT C5).
 *
 * The C5 model-serving path. It is cross-store by design:
 *   (a) READ the customer's score row from the Gold mart brain_gold.gold_customer_scores via the
 *       metric-engine seam (withSilverBrand/runScoped — I-ST01; the engine is the SOLE Gold reader).
 *   (b) RESOLVE the production model_id for (brand, 'customer_churn_rfm') from ml.model_registry (PG,
 *       RLS-scoped). The registry is operational lifecycle config — it legitimately STAYS in PG.
 *   (c) LOG one inference row to the OPERATIONAL PG table ops.ops_ml_prediction_log via the core PG pool
 *       — append-only (subject_type='customer', subject_key=brainId, prediction=the scores jsonb,
 *       score=a composite scalar). V4 (StarRocks REMOVAL, migration 0116): brain_ops moved to the PG
 *       `ops` schema — PG is the SOLE operational store, and the read-only Trino srPool CANNOT write.
 *       This append-only log is RANGE-partitioned on created_at (SELECT/INSERT grant only — no UPDATE).
 *       prediction_id is deterministic (sha256 over brand‖model‖subject‖scored_on) so a replay of the
 *       same served score is idempotent: we pre-filter the id (created_at is NOW() at insert, so it is
 *       NOT part of the dedup key) → INSERT-new-only, preserving the prior append semantics.
 *   (d) RETURN { model, score payload }.
 *
 * HONEST no_data: if the brand has no score row for this customer, we return state:'no_data' and write
 * NOTHING (do NOT fabricate a prediction). If no production model is registered, we serve the score
 * read but with model:null (the registry is the lifecycle authority; we never invent a model).
 *
 * Tenant isolation: the Gold read injects the brand predicate explicitly at the Trino seam (no RLS —
 * I-ST01); the PG registry read AND the inference-log write run under brain_app + the brand GUC. The
 * ops.* tables are NOT RLS-forced (cross-brand trusted ETL home — migration 0116) but carry brand_id as
 * the PK lead and an explicit brand_id predicate on every read/write. brand_id is the session brand
 * (BFF), never the request. The `ml` / `ops` schemas are NOT on the brain_app search_path, so every PG
 * reference is schema-qualified.
 *
 * @effort deterministic — reads a precomputed Gold score; no model call.
 */

import { createHash } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { getCustomerScore } from '@brain/metric-engine';

/** The operational inference log (PG `ops` schema). DDL: db/migrations/0116_brain_ops_to_pg.sql. */
const PREDICTION_LOG_TABLE = 'ops.ops_ml_prediction_log';

/**
 * Deterministic prediction_id — sha256(brand‖model‖subject_type‖subject_key‖scored_on). Re-serving the
 * SAME score (same scored_on) yields the SAME id → the pre-filter suppresses the replay (idempotent on the
 * DUPLICATE-KEY append-only lakehouse table). model_id is folded in so a model change produces a new fact.
 */
function computePredictionId(parts: {
  brandId: string;
  modelId: string | null;
  subjectType: string;
  subjectKey: string;
  scoredOn: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        parts.brandId,
        parts.modelId ?? '',
        parts.subjectType,
        parts.subjectKey,
        parts.scoredOn ?? '',
      ].join('‖'),
    )
    .digest('hex');
}

const CHURN_MODEL_NAME = 'customer_churn_rfm';

/** The served score payload (the prediction we log + return). Money = bigint minor-unit STRINGS. */
export interface ServedScore {
  brain_id: string;
  recency_score: number;
  frequency_score: number;
  monetary_score: number;
  churn_risk: string;
  lifetime_orders: string;
  lifetime_value_minor: string;
  days_since_last_order: number | null;
  scored_on: string | null;
  /** The composite scalar logged as prediction_log.score (R+F+M; honest deterministic blend). */
  composite_score: number;
}

/** The serving model (the production registry row that owns this prediction), or null if none registered. */
export interface ServingModel {
  model_id: string;
  name: string;
  version: string;
  stage: string;
  framework: string;
}

export type ServeCustomerScoreResult =
  | { state: 'no_data'; brain_id: string }
  | { state: 'has_data'; model: ServingModel | null; score: ServedScore; prediction_id: string };

export interface ServeCustomerScoreDeps {
  /**
   * PG pool — reads the production model row from ml.model_registry (RLS-scoped) AND appends the
   * inference row to ops.ops_ml_prediction_log (V4: PG is the SOLE operational store, migration 0116).
   */
  pool: DbPool;
  /** Trino pool (READ-ONLY) — reads the Gold customer score via the metric-engine seam. */
  srPool: SilverPool;
}

export async function serveCustomerScore(
  brandId: string,
  brainId: string,
  correlationId: string,
  deps: ServeCustomerScoreDeps,
): Promise<ServeCustomerScoreResult> {
  // (a) Read the Gold score row (brand-scoped at the seam). Honest no_data → nothing logged.
  const scoreRow = await getCustomerScore(brandId, brainId, { srPool: deps.srPool });
  if (!scoreRow) {
    return { state: 'no_data', brain_id: brainId };
  }

  const composite = scoreRow.recencyScore + scoreRow.frequencyScore + scoreRow.monetaryScore;
  const served: ServedScore = {
    brain_id: scoreRow.brainId,
    recency_score: scoreRow.recencyScore,
    frequency_score: scoreRow.frequencyScore,
    monetary_score: scoreRow.monetaryScore,
    churn_risk: scoreRow.churnRisk,
    lifetime_orders: String(scoreRow.lifetimeOrders),
    lifetime_value_minor: String(scoreRow.lifetimeValueMinor),
    days_since_last_order: scoreRow.daysSinceLastOrder,
    scored_on: scoreRow.scoredOn,
    composite_score: composite,
  };

  const ctx: QueryContext = { brandId, correlationId };
  const subjectType = 'customer';
  let model: ServingModel | null;
  let predictionId: string;
  const client = await deps.pool.connect();
  try {
    // (b) Resolve the production model for (brand, churn) — RLS-scoped.
    const modelRes = await client.query<{
      model_id: string;
      name: string;
      version: string;
      stage: string;
      framework: string;
    }>(
      ctx,
      `SELECT model_id, name, version, stage, framework
         FROM ml.model_registry
        WHERE brand_id = $1 AND name = $2 AND stage = 'production'
        LIMIT 1`,
      [brandId, CHURN_MODEL_NAME],
    );
    model = modelRes.rows[0]
      ? {
          model_id: modelRes.rows[0].model_id,
          name: modelRes.rows[0].name,
          version: modelRes.rows[0].version,
          stage: modelRes.rows[0].stage,
          framework: modelRes.rows[0].framework,
        }
      : null;

    // (c) Append one inference row to the OPERATIONAL log (PG ops.ops_ml_prediction_log) — append-only;
    //     prediction = the scores jsonb (as JSON text), score = the composite scalar. model_id may be
    //     NULL when no production model is registered (still an honest record of what we served).
    //     Deterministic prediction_id → pre-filter existing → INSERT-new-only (idempotent; created_at is
    //     NOW() at insert so it is NOT the dedup key — the append-only grant has no UPDATE). brand_id is
    //     carried explicitly (PK lead; ops.* is not RLS-forced — migration 0116).
    predictionId = computePredictionId({
      brandId,
      modelId: model?.model_id ?? null,
      subjectType,
      subjectKey: brainId,
      scoredOn: served.scored_on,
    });

    const existRes = await client.query<{ prediction_id: string }>(
      ctx,
      `SELECT prediction_id FROM ${PREDICTION_LOG_TABLE} WHERE brand_id = $1 AND prediction_id = $2 LIMIT 1`,
      [brandId, predictionId],
    );
    if (existRes.rows.length === 0) {
      await client.query(
        ctx,
        `INSERT INTO ${PREDICTION_LOG_TABLE}
                (brand_id, created_at, prediction_id, model_id, subject_type, subject_key, prediction, score)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          brandId,
          new Date(),
          predictionId,
          model?.model_id ?? null,
          subjectType,
          brainId,
          JSON.stringify(served),
          composite,
        ],
      );
    }
  } finally {
    client.release();
  }

  // (d) Return the serving model + the score payload + the logged prediction id.
  return {
    state: 'has_data',
    model,
    score: served,
    prediction_id: predictionId,
  };
}
