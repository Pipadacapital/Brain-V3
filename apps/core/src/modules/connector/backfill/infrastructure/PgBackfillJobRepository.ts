/**
 * PgBackfillJobRepository (core-side adapter) — backfill_job data access for the
 * trigger endpoint and progress API in apps/core.
 *
 * Uses the @brain/db DbPool with QueryContext (GUC-based RLS, NN-1).
 * All queries run as brain_app (pool configured with BRAIN_APP_DATABASE_URL in prod;
 * the existing pool in main.ts is already configured with RLS middleware).
 *
 * Responsibilities owned by Track B:
 *   - insertQueued: INSERT backfill_job status=queued (POST /connectors/:id/backfill)
 *   - checkActiveJob: SELECT FOR UPDATE SKIP LOCKED — overlap-lock (D-9 / HP-2)
 *   - findLatestForConnector: GET /connectors/:id/jobs progress
 *
 * ADR-BF-3 (trigger) / ADR-BF-4 (progress) / D-9 (overlap-lock) / D-12 (schema).
 */

import type { DbPool, QueryContext } from '@brain/db';

export interface BackfillJobRow {
  id: string;
  brand_id: string;
  connector_instance_id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
  records_processed: string; // PG returns BIGINT as string
  estimated_total: string | null;
  cursor_value: string | null;
  cursor_date: string | null;
  achieved_depth_label: string | null;
  failure_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export class PgBackfillJobRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Overlap-lock check (D-9 / HP-2): SELECT FOR UPDATE SKIP LOCKED.
   * Returns the active job id if a queued/running job exists for this connector,
   * otherwise null. Called inside a transaction so the lock is scoped.
   *
   * Must be called before insertQueued to prevent duplicate jobs.
   */
  async checkActiveJob(
    connectorInstanceId: string,
    brandId: string,
    correlationId: string,
  ): Promise<string | null> {
    const ctx: QueryContext = { brandId, correlationId };
    const client = await this.pool.connect();
    try {
      // Inline transaction: lock is held for this call only (overlap-lock, not cursor-hold).
      // DbPool's query() sets the GUC per-query automatically.
      const result = await client.query<{ id: string }>(
        ctx,
        `SELECT id
         FROM backfill_job
         WHERE connector_instance_id = $1
           AND status IN ('queued', 'running')
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [connectorInstanceId],
      );
      return result.rows[0]?.id ?? null;
    } finally {
      client.release();
    }
  }

  /**
   * INSERT a new backfill_job row with status='queued'.
   * Caller MUST have already verified no active job exists (checkActiveJob returned null).
   * Returns the new job id (UUID).
   *
   * ADR-BF-3 / D-12.
   */
  async insertQueued(
    brandId: string,
    connectorInstanceId: string,
    correlationId: string,
  ): Promise<string> {
    const ctx: QueryContext = { brandId, correlationId };
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ id: string }>(
        ctx,
        `INSERT INTO backfill_job
           (brand_id, connector_instance_id, status, records_processed)
         VALUES ($1, $2, 'queued', 0)
         RETURNING id`,
        [brandId, connectorInstanceId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgBackfillJobRepository] insertQueued: no row returned');
      return row.id;
    } finally {
      client.release();
    }
  }

  /**
   * Find the most recent backfill_job for a connector_instance_id (brand-scoped).
   * Returns null if no job exists.
   *
   * ADR-BF-4 / progress API.
   */
  async findLatestForConnector(
    connectorInstanceId: string,
    brandId: string,
    correlationId: string,
  ): Promise<BackfillJobRow | null> {
    const ctx: QueryContext = { brandId, correlationId };
    const client = await this.pool.connect();
    try {
      const result = await client.query<BackfillJobRow>(
        ctx,
        `SELECT *
         FROM backfill_job
         WHERE connector_instance_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [connectorInstanceId],
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }
}
