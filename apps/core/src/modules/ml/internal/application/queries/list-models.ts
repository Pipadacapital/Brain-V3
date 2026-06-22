/**
 * listModels — the model registry for a brand (DB-AUDIT C5 ML platform).
 *
 * Reads ml.model_registry for the active brand under the RLS-enforced pool (SET LOCAL ROLE brain_app
 * + app.current_brand_id GUC, set per-query by the @brain/db wrapper). Returns the registry rows as a
 * serialized DTO (timestamps → ISO strings, jsonb passed through). brand_id is the session brand (BFF),
 * never the request. The `ml` schema is NOT on the brain_app search_path, so every reference is
 * schema-qualified.
 *
 * @effort deterministic — a plain registry SELECT, no model call.
 */

import type { DbPool, QueryContext } from '@brain/db';

/** A model-registry row as surfaced to the UI. metrics/feature_set are passthrough jsonb. */
export interface ModelDto {
  model_id: string;
  name: string;
  version: string;
  stage: 'training' | 'staging' | 'production' | 'archived';
  framework: string;
  feature_set: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
  trained_at: string | null;
  promoted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  model_id: string;
  name: string;
  version: string;
  stage: ModelDto['stage'];
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

export interface ListModelsDeps {
  pool: DbPool;
}

export async function listModels(
  brandId: string,
  correlationId: string,
  deps: ListModelsDeps,
): Promise<ModelDto[]> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const res = await client.query<ModelRow>(
      ctx,
      `SELECT model_id, name, version, stage, framework, feature_set, metrics,
              trained_at, promoted_at, created_at, updated_at
         FROM ml.model_registry
        WHERE brand_id = $1
        ORDER BY name ASC, created_at DESC`,
      [brandId],
    );
    return res.rows.map((r) => ({
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
    }));
  } finally {
    client.release();
  }
}
