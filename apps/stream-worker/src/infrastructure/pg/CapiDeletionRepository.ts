/**
 * CapiDeletionRepository — writes capi_deletion_log rows to Postgres.
 *
 * Mirrors ConsentRepository discipline (architecture §5):
 *   ONE transaction: BEGIN → set_config('app.current_brand_id', $1, true) →
 *   count the subject's prior passbacks → INSERT the deletion request
 *   ON CONFLICT DO NOTHING → COMMIT. Connects as brain_app (NEVER superuser brain)
 *   so RLS FORCE is enforced (a missing/wrong GUC → 0 rows; cross-brand write blocked).
 *
 * GUC note: SET LOCAL x=$1 is invalid for custom GUCs.
 *   Use: SELECT set_config('app.current_brand_id', $1, true)  (is_local = txn-scoped).
 *
 * IDEMPOTENCY (the ≤15min retroactive-deletion acceptance gate is replay-safe):
 *   the INSERT is ON CONFLICT DO NOTHING against capi_deletion_log_event_dedup
 *   (brand_id, subject_hash, platform, source_event_id) WHERE source_event_id IS NOT
 *   NULL. 3× replay of the same withdrawal event → exactly one deletion request row.
 *   The repository never throws on a dedup hit; the consumer commits on a clean return.
 *
 * APPEND-ONLY: brain_app holds SELECT+INSERT only (no UPDATE/DELETE — 0034 Assertion-2).
 *
 * DEV-HONESTY (default-closed): in dev there are no real Meta CAPI creds, so the
 *   request is recorded with status='would_delete_dev' — NOTHING is sent to Meta.
 *   In prod the MetaCapiAdapter.delete() POSTs the suppression for the subject's prior
 *   passback events and the status advances to 'deleted'. We NEVER fake a deletion.
 *
 * No raw PII: subject_hash is a 64-hex identity-core hash; nothing raw is written.
 */
import { Pool } from 'pg';

export type CapiDeletionStatus =
  | 'requested'
  | 'deleted'
  | 'would_delete_dev'
  | 'failed';

export interface CapiDeletionRow {
  brandId: string;
  subjectHash: string;
  platform: 'meta';
  /** The withdrawal/tombstone collector event_id (idempotency anchor); null = no anchor. */
  sourceEventId: string | null;
  status: CapiDeletionStatus;
  /** The withdrawal time, for the ≤15min latency measurement. */
  tombstonedAt: string | null;
}

export interface CapiDeletionWriteResult {
  /** false when ON CONFLICT skipped the insert (a replay/dedup hit). */
  inserted: boolean;
  /** How many prior passback events this subject had (the deletion scope). */
  eventCount: number;
}

export class CapiDeletionRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // brain_app credentials — RLS FORCE enforced on capi_deletion_log / capi_passback_log.
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /**
   * Record a retroactive-deletion request in one transaction.
   * GUC-scoped to brandId; the INSERT is idempotent (ON CONFLICT DO NOTHING).
   * Counts the subject's prior passback events (the deletion scope) under the SAME
   * GUC so the count is itself RLS-enforced.
   */
  async requestDeletion(row: CapiDeletionRow): Promise<CapiDeletionWriteResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [row.brandId]);

      // Count this subject's prior passback events (the deletion scope). RLS-enforced
      // under the same brand GUC → cross-brand rows are invisible (return 0).
      const scope = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM capi_passback_log
          WHERE brand_id = $1
            AND subject_hash = $2
            AND status IN ('sent','would_send_dev')`,
        [row.brandId, row.subjectHash],
      );
      const eventCount = parseInt(scope.rows[0]?.n ?? '0', 10);

      const ins = await client.query(
        `INSERT INTO capi_deletion_log
           (brand_id, subject_hash, platform, source_event_id, status, event_count, tombstoned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (brand_id, subject_hash, platform, source_event_id)
           WHERE source_event_id IS NOT NULL
         DO NOTHING`,
        [
          row.brandId,
          row.subjectHash,
          row.platform,
          row.sourceEventId,
          row.status,
          eventCount,
          row.tombstonedAt,
        ],
      );

      await client.query('COMMIT');
      return { inserted: (ins.rowCount ?? 0) > 0, eventCount };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
