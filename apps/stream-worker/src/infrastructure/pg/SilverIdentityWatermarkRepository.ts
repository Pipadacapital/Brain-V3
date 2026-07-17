/**
 * PgSilverIdentityWatermarkRepository — per-(job, brand) watermark for the Silver identity stage
 * (ADR-0015 WS3). The PG-ops analogue of the transform tier's silver_job_watermark side-table:
 * the Node batch job records the max Silver `ingested_at` it has folded per brand, and each run
 * reads from (watermark − lookback) so a row that landed in Silver late (Bronze→Silver lag) is
 * still folded — resolution is idempotent, so the overlap re-process is safe.
 *
 * TENANT ISOLATION: brand_id is in the PRIMARY KEY. Like the ops.*_pending queues this is a
 * cross-brand trusted-ETL table (the worker runs as brain_app with NO brand GUC), NOT RLS-forced;
 * isolation is the explicit brand_id on every row. MONEY: none.
 *
 * DDL: db/migrations/0138_silver_identity_watermark.sql (ops.silver_identity_watermark).
 */
import type pg from 'pg';

export interface ISilverIdentityWatermarkRepository {
  /** The stored watermark (ISO-8601 UTC) for (jobName, brandId), or null when never run. */
  get(jobName: string, brandId: string): Promise<string | null>;
  /** Idempotent upsert of the new watermark (only ever advanced by the caller). */
  set(jobName: string, brandId: string, watermarkIso: string): Promise<void>;
}

export class PgSilverIdentityWatermarkRepository implements ISilverIdentityWatermarkRepository {
  /** @param pool pg.Pool connected as brain_app (the worker's dbUrl pool). */
  constructor(private readonly pool: pg.Pool) {}

  async get(jobName: string, brandId: string): Promise<string | null> {
    const r = await this.pool.query<{ watermark: string }>(
      `SELECT to_char(watermark AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS watermark
         FROM ops.silver_identity_watermark
        WHERE job_name = $1 AND brand_id = $2`,
      [jobName, brandId],
    );
    return r.rows[0]?.watermark ?? null;
  }

  async set(jobName: string, brandId: string, watermarkIso: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ops.silver_identity_watermark (job_name, brand_id, watermark, updated_at)
       VALUES ($1, $2, $3::timestamptz, now())
       ON CONFLICT (job_name, brand_id) DO UPDATE SET
         watermark  = EXCLUDED.watermark,
         updated_at = now()`,
      [jobName, brandId, watermarkIso],
    );
  }
}
