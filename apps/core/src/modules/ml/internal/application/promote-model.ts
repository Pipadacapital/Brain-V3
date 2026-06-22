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
  feature_set: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
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
    const target = await client.query<{ name: string }>(
      `SELECT name FROM ml.model_registry WHERE model_id = $1 AND brand_id = $2`,
      [modelId, brandId],
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new ModelNotFoundError(modelId);
    }
    const name = target.rows[0]!.name;

    if (toStage === 'production') {
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
