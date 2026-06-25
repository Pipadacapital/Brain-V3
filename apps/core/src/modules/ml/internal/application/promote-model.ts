/**
 * promoteModel — move a model to a new lifecycle stage (DB-AUDIT C5 ML platform).
 *
 * The gated promotion path of the model lifecycle. A model has a stage in
 * {training, staging, production, archived}. The registry enforces a partial-unique invariant —
 * AT MOST ONE production model per (brand_id, name) (index model_registry_one_production WHERE
 * stage='production'). So promoting a model to 'production' must FIRST archive the current production
 * model of the same (brand, name), then promote the target — atomically, or the partial-unique throws.
 *
 * Atomicity: both writes run in ONE transaction on a raw pg client under brain_app + the brand GUC
 * (beginRlsTxn → BEGIN; SET LOCAL ROLE brain_app; SET LOCAL app.current_brand_id). RLS + the explicit
 * brand_id predicate scope every write — a cross-brand model_id is invisible and untouched.
 *
 * brand_id is the session brand (BFF), never the request. The `ml` schema is NOT on the brain_app
 * search_path, so every reference is schema-qualified.
 */

import type { Pool, PoolClient } from 'pg';
import { beginRlsTxn } from '@brain/db';
import { loadCoreConfig } from '@brain/config';
import type { ModelDto } from './queries/list-models.js';

/** The closed set of stages a model can be promoted/demoted to (mirrors the 0083 CHECK). */
export const MODEL_STAGES = ['training', 'staging', 'production', 'archived'] as const;
export type ModelStage = (typeof MODEL_STAGES)[number];

export function isModelStage(v: unknown): v is ModelStage {
  return typeof v === 'string' && (MODEL_STAGES as readonly string[]).includes(v);
}

/** Thrown when the target model is not visible to the brand (RLS) or does not exist. */
export class ModelNotFoundError extends Error {
  constructor(modelId: string) {
    super(`Model ${modelId} not found for this brand`);
    this.name = 'ModelNotFoundError';
  }
}

/** Thrown when the requested stage is not one of the allowed kinds. */
export class InvalidModelStageError extends Error {
  constructor(stage: string) {
    super(`Unknown model stage: ${stage}`);
    this.name = 'InvalidModelStageError';
  }
}

/**
 * Thrown when a candidate model's eval metrics fail the production baseline gate.
 *
 * The eval gate is a fail-safe guard: ANY candidate whose metrics are missing or below any
 * configured baseline is blocked from production — regardless of subjective "looks better" signals.
 * This closes the audit finding that auc=0.01 could ship (no gate existed).
 *
 * Baselines are intentionally conservative defaults; the team may raise them per model name via
 * EVAL_GATE_BASELINES_JSON env (a JSON map of { "<name>": { "auc": <n>, ... } }) but may never
 * set them below the FLOOR values defined in EVAL_GATE_METRIC_FLOORS.
 */
export class EvalGateError extends Error {
  constructor(
    modelId: string,
    public readonly failures: Array<{ metric: string; actual: number | undefined; baseline: number }>,
  ) {
    const details = failures
      .map((f) => `${f.metric}: actual=${f.actual ?? 'missing'}, required>=${f.baseline}`)
      .join('; ');
    super(`Model ${modelId} failed the production eval gate: ${details}`);
    this.name = 'EvalGateError';
  }
}

/**
 * Absolute floor values for eval metrics — the gate may never be configured below these.
 * These are the production safety guarantees; raising them is safe, lowering below floor is rejected.
 *
 * auc=0.5  = random classifier (no better than coin flip) — the historical gap allowed auc=0.01
 * precision/recall = 0.1 — absolute minimum signal (floor, not target)
 */
export const EVAL_GATE_METRIC_FLOORS: Readonly<Record<string, number>> = {
  auc: 0.5,
  precision: 0.1,
  recall: 0.1,
  f1: 0.1,
  accuracy: 0.5,
};

/**
 * Default production baselines. Metrics present in a model's metrics jsonb MUST meet these.
 * Metrics absent from baselines are IGNORED (additive: adding a new metric to a model never
 * blocks promotion; the baseline must be explicitly set for a metric to be gated on it).
 *
 * OVERRIDE: set EVAL_GATE_BASELINES_JSON={"customer_churn_rfm":{"auc":0.75}} per-deployment.
 * Per-name overrides REPLACE the default for that metric for that model name.
 * Floor values (EVAL_GATE_METRIC_FLOORS) are always enforced on top of the configured baseline.
 */
export const DEFAULT_EVAL_BASELINES: Readonly<Record<string, number>> = {
  auc: 0.6,
  precision: 0.5,
  recall: 0.5,
  f1: 0.5,
  accuracy: 0.6,
};

/** Parse the EVAL_GATE_BASELINES_JSON env var (per-model override map). Silently returns {} on parse error. */
function loadBaselineOverrides(): Record<string, Record<string, number>> {
  const raw = loadCoreConfig().EVAL_GATE_BASELINES_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Record<string, number>>;
  } catch {
    return {};
  }
}

/**
 * Run the eval gate for a candidate model's metrics jsonb before production promotion.
 *
 * For each metric in DEFAULT_EVAL_BASELINES (or per-model override):
 *   1. If the metric is absent from the candidate's metrics → fail (missing eval evidence).
 *   2. If the metric is below the per-name baseline (or default, whichever is higher after floor) → fail.
 *
 * Deterministic-framework models (e.g. rule-based scorers) are EXEMPT: deterministic models have
 * no learned metric to eval-gate; they are promoted on explicit declaration. A model with
 * framework='deterministic' skips the eval gate entirely (it ships by design, not by measurement).
 *
 * @effort deterministic — arithmetic over a jsonb metrics object, no model call.
 */
export function runEvalGate(
  modelId: string,
  modelName: string,
  framework: string,
  metrics: unknown,
): void {
  // Deterministic models bypass the eval gate (they have no learned metrics).
  if (framework === 'deterministic') return;

  const overrides = loadBaselineOverrides();
  const nameOverrides = overrides[modelName] ?? {};

  // Resolve the effective baseline for each metric: max(floor, configured).
  // All metrics in the default set are gated unless the model name has a per-metric override of 0
  // (which is still floored, so effectively the floor).
  const metricsObj =
    metrics !== null && typeof metrics === 'object' && !Array.isArray(metrics)
      ? (metrics as Record<string, unknown>)
      : {};

  const failures: Array<{ metric: string; actual: number | undefined; baseline: number }> = [];

  for (const [metric, defaultBaseline] of Object.entries(DEFAULT_EVAL_BASELINES)) {
    const floor = EVAL_GATE_METRIC_FLOORS[metric] ?? 0;
    const configured = nameOverrides[metric] ?? defaultBaseline;
    const effective = Math.max(floor, configured);

    const rawActual = metricsObj[metric];
    // Skip metrics not present in the model's metrics (additive gate: only gate on declared metrics
    // that are in the default baseline set and present on the model). If a default-gated metric is
    // completely absent from the model's metrics, treat it as a failure (missing eval evidence).
    if (rawActual === undefined) {
      // Only fail on absent metrics for metrics that ARE in the default baseline (not per-model extras).
      // This prevents gating a model on metrics it was never evaluated on.
      // For our canonical baselines (auc/precision/recall/f1/accuracy), absence = insufficient evidence.
      failures.push({ metric, actual: undefined, baseline: effective });
      continue;
    }

    const actual = typeof rawActual === 'number' ? rawActual : NaN;
    if (isNaN(actual) || actual < effective) {
      failures.push({ metric, actual: isNaN(actual) ? undefined : actual, baseline: effective });
    }
  }

  if (failures.length > 0) {
    throw new EvalGateError(modelId, failures);
  }
}

export interface PromoteModelInput {
  modelId: string;
  toStage: ModelStage;
}

export interface PromoteModelDeps {
  /** Raw pg.Pool (rawPgPool from main.ts) — the multi-statement atomic path needs explicit BEGIN/COMMIT. */
  rawPool: Pool;
}

interface RawModelRow {
  model_id: string;
  name: string;
  version: string;
  stage: ModelStage;
  framework: string;
  feature_set: unknown;
  metrics: unknown;
  trained_at: Date | null;
  promoted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toIso(v: Date | null): string | null {
  return v instanceof Date ? v.toISOString() : v === null ? null : String(v);
}

function toDto(r: RawModelRow): ModelDto {
  return {
    model_id: r.model_id,
    name: r.name,
    version: r.version,
    stage: r.stage,
    framework: r.framework,
    feature_set: r.feature_set ?? null,
    metrics: r.metrics ?? null,
    trained_at: toIso(r.trained_at),
    promoted_at: toIso(r.promoted_at),
    created_at: toIso(r.created_at)!,
    updated_at: toIso(r.updated_at)!,
  };
}

export async function promoteModel(
  brandId: string,
  input: PromoteModelInput,
  correlationId: string,
  deps: PromoteModelDeps,
): Promise<ModelDto> {
  if (!isModelStage(input.toStage)) {
    throw new InvalidModelStageError(String(input.toStage));
  }
  const { modelId, toStage } = input;

  const client: PoolClient = await deps.rawPool.connect();
  try {
    await beginRlsTxn(client, { correlationId, brandId });

    // (a) Resolve the target model under RLS + brand scope. Invisible/absent → not found, nothing written.
    const target = await client.query<{ name: string; framework: string; metrics: unknown }>(
      `SELECT name, framework, metrics FROM ml.model_registry WHERE model_id = $1 AND brand_id = $2`,
      [modelId, brandId],
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ModelNotFoundError(modelId);
    }
    const { name, framework, metrics } = target.rows[0]!;

    if (toStage === 'production') {
      // (a2) Eval gate — block promotion if the candidate's metrics fail the baseline.
      //      Runs BEFORE any state mutation so a failed gate leaves the registry untouched.
      //      EvalGateError propagates out of the try block → ROLLBACK is executed in catch.
      runEvalGate(modelId, name, framework, metrics);

      // (b) Archive the CURRENT production model of the same (brand, name) — respects the
      //     partial-unique "one production per (brand,name)" invariant (model_registry_one_production).
      //     Excludes the target itself (a re-promote is a no-op on this step). Skips the target row.
      await client.query(
        `UPDATE ml.model_registry
            SET stage = 'archived', updated_at = now()
          WHERE brand_id = $1 AND name = $2 AND stage = 'production' AND model_id <> $3`,
        [brandId, name, modelId],
      );
      // (c) Promote the target → production + stamp promoted_at.
      const upd = await client.query<RawModelRow>(
        `UPDATE ml.model_registry
            SET stage = 'production', promoted_at = now(), updated_at = now()
          WHERE model_id = $1 AND brand_id = $2
        RETURNING model_id, name, version, stage, framework, feature_set, metrics,
                  trained_at, promoted_at, created_at, updated_at`,
        [modelId, brandId],
      );
      await client.query('COMMIT');
      return toDto(upd.rows[0]!);
    }

    // Non-production stages: just set the stage + touch updated_at.
    const upd = await client.query<RawModelRow>(
      `UPDATE ml.model_registry
          SET stage = $3, updated_at = now()
        WHERE model_id = $1 AND brand_id = $2
      RETURNING model_id, name, version, stage, framework, feature_set, metrics,
                trained_at, promoted_at, created_at, updated_at`,
      [modelId, brandId, toStage],
    );
    await client.query('COMMIT');
    return toDto(upd.rows[0]!);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
