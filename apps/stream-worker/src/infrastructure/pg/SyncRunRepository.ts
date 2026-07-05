/**
 * SyncRunRepository — append-only writer for connector_sync_run.
 *
 * connector_sync_run is the per-run audit ledger introduced by migration 0093.
 * It records two rows per job invocation:
 *   - a 'started' row at the top of the run (written before any API call)
 *   - a 'succeeded' or 'failed' row at the terminal point (written once, never mutated)
 *
 * APPEND-ONLY invariant (0093 / 0082 pattern):
 *   brain_app holds SELECT + INSERT only — no UPDATE/DELETE. Closed runs are immutable.
 *   The caller does NOT update the 'started' row; it writes a separate terminal row.
 *   This keeps the ledger replayable and auditable: every transition is a new row.
 *
 * RLS: connector_sync_run has FORCE RLS; all writes set app.current_brand_id GUC inside a
 * txn-local transaction before the INSERT (NN-1 / ADR-LV-7). The system worker carries no
 * human user/workspace context, so app.current_user_id + app.current_workspace_id are set to
 * NIL_UUID (a valid uuid the RLS policy can cast) — never a real identity.
 *
 * Non-fatal on error: a failed ledger write MUST NOT abort the job. The run ledger is an
 * audit trail, not a correctness primitive. If the INSERT fails (transient DB error, partition
 * not yet created), we log and swallow — the job continues and the primary idempotency contract
 * (event_id in Bronze + connector_cursor watermark) is unaffected.
 *
 * Thread safety: each call acquires a dedicated pool client, wraps in BEGIN/COMMIT, releases in
 * finally. No shared state between concurrent callers.
 */

import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { log } from '../../log.js';

/** System-worker sentinel: no human user/workspace — a valid uuid the RLS cast accepts. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ── Public types ──────────────────────────────────────────────────────────────

export type RunType = 'backfill' | 'repull' | 'webhook';

export interface StartRunParams {
  /** run_id pre-allocated by the caller so it can be threaded through to closeRun. */
  runId: string;
  brandId: string;
  provider: string;
  /** ad_account_id or NULL for storefront connectors with no sub-account discriminator. */
  accountKey?: string | null;
  runType: RunType;
  correlationId?: string | null;
}

export interface CloseRunParams {
  runId: string;
  brandId: string;
  /** ISO-8601 string matching the started_at of the opening row (needed for partition routing). */
  startedAt: string;
  status: 'succeeded' | 'failed';
  rowsIngested?: number | null;
  errorClass?: string | null;
  /** Truncated to 500 chars at the boundary — raw error messages can be large. */
  errorDetail?: string | null;
}

// ── Repository class ──────────────────────────────────────────────────────────

export class SyncRunRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Allocate a stable run_id for the caller to carry through startRun → closeRun.
   * Returns a plain UUIDv4 — deterministic re-use across retries is the caller's concern.
   */
  static newRunId(): string {
    return randomUUID();
  }

  /**
   * Write a 'started' row to connector_sync_run.
   *
   * Returns the ISO-8601 string of started_at (generated here to be used as the partition
   * routing key in closeRun). Non-fatal: errors are logged and swallowed — the caller must
   * NOT abort the job on a ledger write failure.
   */
  async startRun(params: StartRunParams): Promise<string> {
    const startedAt = new Date().toISOString();
    const {
      runId, brandId, provider, accountKey = null,
      runType, correlationId = null,
    } = params;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [brandId, NIL_UUID],
      );
      await client.query(
        `INSERT INTO connector_sync_run
           (run_id, brand_id, provider, account_key, run_type, status, started_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, 'started', $6, $7)`,
        [runId, brandId, provider, accountKey, runType, startedAt, correlationId],
      );
      await client.query('COMMIT');
      log.info(`[sync-run] started run_id=${runId} provider=${provider} brand=${brandId} type=${runType}`);
    } catch (err) {
      // Non-fatal: log + swallow. The job must not abort on a ledger write failure.
      await client.query('ROLLBACK').catch(() => undefined);
      log.error(`[sync-run] startRun failed (non-fatal) run_id=${runId}`, { err });
    } finally {
      client.release();
    }

    return startedAt;
  }

  /**
   * Write a terminal ('succeeded' | 'failed') row to connector_sync_run.
   *
   * The ledger is append-only: this is a new INSERT, not an UPDATE of the 'started' row.
   * started_at is passed in from startRun's return value — it is used as the partition key
   * so the INSERT routes to the correct monthly child partition.
   * Non-fatal: errors are logged and swallowed.
   */
  async closeRun(params: CloseRunParams): Promise<void> {
    const {
      runId, brandId, startedAt, status,
      rowsIngested = null, errorClass = null, errorDetail = null,
    } = params;

    // Truncate errorDetail to 500 chars (raw error messages can be large; the column is TEXT but
    // we enforce a soft cap here to avoid storing multi-megabyte stack traces in the ledger).
    const safeDetail = errorDetail ? errorDetail.slice(0, 500) : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_brand_id', $1, true),
                set_config('app.current_user_id', $2, true),
                set_config('app.current_workspace_id', $2, true)`,
        [brandId, NIL_UUID],
      );
      await client.query(
        `INSERT INTO connector_sync_run
           (run_id, brand_id, provider, account_key, run_type, status,
            started_at, finished_at, rows_ingested, error_class, error_detail, correlation_id)
         SELECT
           gen_random_uuid(),   -- new PK for the terminal row
           brand_id, provider, account_key, run_type, $3,
           started_at, NOW(), $4, $5, $6, correlation_id
         FROM connector_sync_run
         WHERE run_id = $1 AND brand_id = $2 AND started_at = $7
         LIMIT 1`,
        [runId, brandId, status, rowsIngested, errorClass, safeDetail, startedAt],
      );
      await client.query('COMMIT');
      log.info(`[sync-run] closed run_id=${runId} status=${status} rows=${rowsIngested ?? 0}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error(`[sync-run] closeRun failed (non-fatal) run_id=${runId} status=${status}`, { err });
    } finally {
      client.release();
    }
  }
}
