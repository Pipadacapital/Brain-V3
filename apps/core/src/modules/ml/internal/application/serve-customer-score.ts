/**
 * serveCustomerScore — serve the deterministic RFM/churn score for one customer (DB-AUDIT C5).
 *
 * The C5 model-serving path. It is cross-store by design:
 *   (a) READ the customer's score row from the Gold mart brain_gold.gold_customer_scores via the
 *       metric-engine seam (withSilverBrand/runScoped — I-ST01; the engine is the SOLE Gold reader).
 *   (b) RESOLVE the production model_id for (brand, 'customer_churn_rfm') from ml.model_registry (PG,
 *       RLS-scoped). The registry is operational lifecycle config — it legitimately STAYS in PG.
 *   (c) LOG one inference row to the OPERATIONAL StarRocks DB brain_ops.ops_ml_prediction_log via srPool
 *       — append-only (subject_type='customer', subject_key=brainId, prediction=the scores jsonb,
 *       score=a composite scalar). V4 PHASE 5 (audit MV-2/DB-2): model-inference output is OPERATIONAL
 *       serving state → its own operational StarRocks DB brain_ops, NOT the dbt-internal brain_gold (retired
 *       in Phase 6) and NOT operational PG (ml.prediction_log was DROPPED in migration 0103).
 *       prediction_id is deterministic (sha256 over brand‖model‖subject‖scored_on) so a
 *       replay of the same served score is idempotent (StarRocks has no RLS/RETURNING; we pre-filter the
 *       id → INSERT-new-only, preserving the prior PG append semantics).
 *   (d) RETURN { model, score payload }.
 *
 * HONEST no_data: if the brand has no score row for this customer, we return state:'no_data' and write
 * NOTHING (do NOT fabricate a prediction). If no production model is registered, we serve the score
 * read but with model:null (the registry is the lifecycle authority; we never invent a model).
 *
 * Tenant isolation: the Gold read + the inference-log write inject/carry the brand predicate explicitly
 * (StarRocks has no RLS — I-ST01 at the seam); the PG registry read runs under brain_app + the brand GUC
 * (RLS). brand_id is the session brand (BFF), never the request. The `ml` schema is NOT on the brain_app
 * search_path, so every PG reference is schema-qualified.
 *
 * @effort deterministic — reads a precomputed Gold score; no model call.
 */

import { createHash } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { getCustomerScore } from '@brain/metric-engine';

/** The operational inference log (StarRocks brain_ops). DDL: db/starrocks/ops/ops_ml_prediction_log.sql. */
const PREDICTION_LOG_TABLE = 'brain_ops.ops_ml_prediction_log';

/** StarRocks DATETIME literal ('YYYY-MM-DD HH:MM:SS', UTC) from a Date. */
function toSrDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

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
  /** PG pool — reads the production model row from ml.model_registry (RLS-scoped, stays in PG). */
  pool: DbPool;
  /** StarRocks pool — reads the Gold score AND appends the inference row to the lakehouse log. */
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
  let model: ServingModel | null;
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
  } finally {
    client.release();
  }

  // (c) Append one inference row to the OPERATIONAL log (StarRocks brain_ops.ops_ml_prediction_log) —
  //     append-only; prediction = the scores jsonb (as JSON text), score = the composite scalar. model_id
  //     may be NULL when no production model is registered (still an honest record of what we served).
  //     Deterministic prediction_id → pre-filter existing → INSERT-new-only (idempotent on the
  //     DUPLICATE-KEY table; StarRocks has no RLS/RETURNING). brand_id is carried explicitly (I-ST01).
  const subjectType = 'customer';
  const predictionId = computePredictionId({
    brandId,
    modelId: model?.model_id ?? null,
    subjectType,
    subjectKey: brainId,
    scoredOn: served.scored_on,
  });

  const [existRows] = await deps.srPool.query(
    `SELECT prediction_id FROM ${PREDICTION_LOG_TABLE} WHERE brand_id = ? AND prediction_id = ? LIMIT 1`,
    [brandId, predictionId],
  );
  const alreadyLogged = (existRows as Array<{ prediction_id: string }>).length > 0;
  if (!alreadyLogged) {
    await deps.srPool.query(
      `INSERT INTO ${PREDICTION_LOG_TABLE}
              (brand_id, created_at, prediction_id, model_id, subject_type, subject_key, prediction, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        brandId,
        toSrDatetime(new Date()),
        predictionId,
        model?.model_id ?? null,
        subjectType,
        brainId,
        JSON.stringify(served),
        composite,
      ],
    );
  }

  // (d) Return the serving model + the score payload + the logged prediction id.
  return {
    state: 'has_data',
    model,
    score: served,
    prediction_id: predictionId,
  };
}
