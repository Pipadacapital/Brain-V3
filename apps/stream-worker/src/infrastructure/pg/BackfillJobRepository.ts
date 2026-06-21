/**
 * PgBackfillJobRepository — data access for backfill_job rows.
 *
 * Connects as brain_app (RLS enforced). All writes set the brand GUC
 * (app.current_brand_id) per the NN-1 two-arg fail-closed pattern.
 *
 * The worker process (stream-worker/src/jobs/shopify-backfill/) uses this
 * repository for the full job lifecycle:
 *   claimQueued()     — atomically transition queued → running (FOR UPDATE SKIP LOCKED)
 *   updateProgress()  — after each page (records_processed, cursor_value, cursor_date)
 *   finalize()        — write terminal state (completed/partial/failed + labels/reasons)
 *
 * The trigger endpoint (apps/core/main.ts) uses insertQueued() via its own PG
 * connection; the worker reads the row here in stream-worker.
 *
 * ADR-BF-1 / D-2 / D-9 / D-12.
 *
 * Note: the WORKER does NOT own insertQueued — that is a Track B (backend) concern.
 * insertQueued is included here for completeness / test use in A4.
 */

import { Pool, PoolClient } from 'pg';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

// SEC-BF-L1 (no-drift): this row shape is duplicated in apps/core
// (modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts) — intentional (I-E05: no
// cross-app imports), but the two MUST stay identical. backfill-job-row-parity.test.ts enforces it.
export interface BackfillJobRow {
  id: string;
  brand_id: string;
  connector_instance_id: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
  records_processed: string; // PG returns BIGINT as string
  estimated_total: string | null;
  cursor_value: string | null;
  cursor_date: string | null;   // ISO-8601 from PG TIMESTAMPTZ
  achieved_depth_label: string | null;
  failure_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertQueuedParams {
  brandId: string;
  connectorInstanceId: string;
}

export interface UpdateProgressParams {
  jobId: string;
  brandId: string;
  recordsProcessed: bigint;
  estimatedTotal: bigint | null;
  cursorValue: string;
  cursorDate: Date; // oldest processed_at seen so far
}

export interface FinalizeParams {
  jobId: string;
  brandId: string;
  status: 'completed' | 'partial' | 'failed';
  achievedDepthLabel: string | null;
  failureReason: string | null;
  recordsProcessed: bigint;
  cursorValue: string | null;
}

export class PgBackfillJobRepository {
  private readonly pool: Pool;

  constructor(connectionString: string = DB_URL) {
    this.pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /**
   * Insert a new backfill_job row with status='queued'.
   * Called by the trigger endpoint (Track B / main.ts) after the overlap-lock check.
   * Returns the new job id.
   *
   * Note: The overlap-lock (D-9) is enforced by claimQueued via FOR UPDATE SKIP LOCKED;
   * the trigger also checks before INSERT. This insert is idempotent in that a
   * DB constraint violation here is a bug (the caller must have already checked).
   */
  async insertQueued(params: InsertQueuedParams): Promise<string> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );
      const result = await client.query<{ id: string }>(
        `INSERT INTO backfill_job
           (brand_id, connector_instance_id, status, records_processed)
         VALUES ($1, $2, 'queued', 0)
         RETURNING id`,
        [params.brandId, params.connectorInstanceId],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      if (!row) throw new Error('[BackfillJobRepository] insertQueued: no row returned');
      return row.id;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically claim a queued job for a given connector_instance_id.
   * Uses SELECT FOR UPDATE SKIP LOCKED — DB-level overlap prevention (D-9 / HP-2).
   * Transitions status queued → running, sets started_at = NOW().
   * Returns the claimed job row, or null if no queued job exists.
   *
   * Called by the backfill worker poll loop (D-2).
   */
  async claimQueued(connectorInstanceId: string, brandId: string): Promise<BackfillJobRow | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [brandId],
      );

      // Lock the queued row for this connector (SKIP LOCKED = no wait if another worker racing)
      const lockResult = await client.query<{ id: string }>(
        `SELECT id FROM backfill_job
         WHERE connector_instance_id = $1
           AND status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [connectorInstanceId],
      );

      if ((lockResult.rowCount ?? 0) === 0) {
        await client.query('COMMIT');
        return null;
      }

      const jobId = lockResult.rows[0]!.id;

      // Transition → running
      const updateResult = await client.query<BackfillJobRow>(
        `UPDATE backfill_job
         SET status = 'running', started_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [jobId],
      );

      await client.query('COMMIT');
      return updateResult.rows[0] ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update progress after processing a page of orders (D-14).
   * Sets records_processed, estimated_total (if resolved), cursor_value,
   * cursor_date (oldest processed_at seen). Called after EVERY page.
   */
  async updateProgress(params: UpdateProgressParams): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );
      await client.query(
        `UPDATE backfill_job
         SET records_processed = $2,
             estimated_total   = $3,
             cursor_value      = $4,
             cursor_date       = $5,
             updated_at        = NOW()
         WHERE id = $1`,
        [
          params.jobId,
          params.recordsProcessed.toString(),
          params.estimatedTotal !== null ? params.estimatedTotal.toString() : null,
          params.cursorValue,
          params.cursorDate.toISOString(),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Finalize a job: write terminal status, achieved_depth_label, failure_reason.
   * Called once the page loop ends (completed/partial/failed).
   * Sets completed_at = NOW().
   */
  async finalize(params: FinalizeParams): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );
      await client.query(
        `UPDATE backfill_job
         SET status                = $2,
             achieved_depth_label  = $3,
             failure_reason        = $4,
             records_processed     = $5,
             cursor_value          = COALESCE($6, cursor_value),
             completed_at          = NOW(),
             updated_at            = NOW()
         WHERE id = $1`,
        [
          params.jobId,
          params.status,
          params.achievedDepthLabel,
          params.failureReason,
          params.recordsProcessed.toString(),
          params.cursorValue,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read a single job by id (for tests / progress API).
   * Under brain_app + GUC=brandId.
   */
  async findById(jobId: string, brandId: string): Promise<BackfillJobRow | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("SELECT set_config('app.current_brand_id', $1, false)", [brandId]);
      const result = await client.query<BackfillJobRow>(
        'SELECT * FROM backfill_job WHERE id = $1',
        [jobId],
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  /**
   * Find the latest job for a connector_instance_id (for tests and progress API).
   */
  async findLatestForConnector(
    connectorInstanceId: string,
    brandId: string,
  ): Promise<BackfillJobRow | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("SELECT set_config('app.current_brand_id', $1, false)", [brandId]);
      const result = await client.query<BackfillJobRow>(
        `SELECT * FROM backfill_job
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

  async end(): Promise<void> {
    await this.pool.end();
  }
}
