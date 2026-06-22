/**
 * serveCustomerScore — serve the deterministic RFM/churn score for one customer (DB-AUDIT C5).
 *
 * The C5 model-serving path. It is cross-store by design:
 *   (a) READ the customer's score row from the Gold mart brain_gold.gold_customer_scores via the
 *       metric-engine seam (withSilverBrand/runScoped — I-ST01; the engine is the SOLE Gold reader).
 *   (b) RESOLVE the production model_id for (brand, 'customer_churn_rfm') from ml.model_registry (PG,
 *       RLS-scoped). This is the model whose prediction we are serving.
 *   (c) LOG one ml.prediction_log row (subject_type='customer', subject_key=brainId, prediction=the
 *       scores jsonb, score=a composite scalar) — append-only (brain_app has SELECT+INSERT only).
 *   (d) RETURN { model, score payload }.
 *
 * HONEST no_data: if the brand has no score row for this customer, we return state:'no_data' and write
 * NOTHING (do NOT fabricate a prediction). If no production model is registered, we serve the score
 * read but with model:null (the registry is the lifecycle authority; we never invent a model).
 *
 * Tenant isolation: the Gold read injects the brand predicate at the seam; the PG reads/writes run
 * under brain_app + the brand GUC (RLS). brand_id is the session brand (BFF), never the request. The
 * `ml` schema is NOT on the brain_app search_path, so every reference is schema-qualified.
 *
 * @effort deterministic — reads a precomputed Gold score; no model call.
 */

import type { DbPool, QueryContext } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { getCustomerScore } from '@brain/metric-engine';

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
  pool: DbPool;
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
    const model: ServingModel | null = modelRes.rows[0]
      ? {
          model_id: modelRes.rows[0].model_id,
          name: modelRes.rows[0].name,
          version: modelRes.rows[0].version,
          stage: modelRes.rows[0].stage,
          framework: modelRes.rows[0].framework,
        }
      : null;

    // (c) Append the prediction_log row (append-only — brain_app has no UPDATE/DELETE on it).
    //     prediction = the scores jsonb; score = the composite scalar. model_id may be null when no
    //     production model is registered (the prediction is still an honest record of what we served).
    const ins = await client.query<{ prediction_id: string }>(
      ctx,
      `INSERT INTO ml.prediction_log
              (brand_id, model_id, subject_type, subject_key, prediction, score)
       VALUES ($1, $2, 'customer', $3, $4::jsonb, $5)
       RETURNING prediction_id`,
      [brandId, model?.model_id ?? null, brainId, JSON.stringify(served), composite],
    );

    // (d) Return the serving model + the score payload + the logged prediction id.
    return {
      state: 'has_data',
      model,
      score: served,
      prediction_id: ins.rows[0]!.prediction_id,
    };
  } finally {
    client.release();
  }
}
