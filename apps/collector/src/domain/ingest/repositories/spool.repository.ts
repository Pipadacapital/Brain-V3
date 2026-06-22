/**
 * SpoolRepository interface — domain boundary for spool persistence.
 * Concrete implementation lives in infrastructure/.
 */
import type { IngestEnvelope } from '../value-objects/envelope.js';
import type { PendingSpoolEntry } from '../entities/spool-entry.js';

export interface SpoolRepository {
  /**
   * Write a raw envelope to the spool. Returns the new row id.
   * This INSERT is the ACK boundary — it commits before HTTP 200 is returned.
   */
  insert(envelope: IngestEnvelope): Promise<bigint>;

  /**
   * Poll up to `limit` pending rows, ordered by id (oldest first).
   * Used by the drainer loop.
   */
  pollPending(limit: number): Promise<PendingSpoolEntry[]>;

  /**
   * Mark a spool row as drained after confirmed Kafka produce.
   * Sets status='drained', drained_at=now().
   */
  markDrained(id: bigint): Promise<void>;

  /**
   * Count pending rows, but stop scanning once `cap` is reached (a BOUNDED count).
   * Returns min(actual_pending, cap). Backs the spool back-pressure gauge (C4 / R-09):
   * we only need to know whether the backlog has crossed the high/low-water marks, never
   * the true depth — so the query is O(cap) on the partial pending index, not O(table).
   */
  countPendingBounded(cap: number): Promise<number>;

  /**
   * Retention reaper (DB-AUDIT M6): delete rows that have been 'drained' for longer than
   * `olderThanSeconds` (a short post-drain trail window). Returns the number of rows purged.
   * Bounds collector_spool growth — drained rows are disposable once produced to Kafka.
   */
  reapDrained(olderThanSeconds: number): Promise<number>;

  /**
   * Health check — can the spool DB be reached?
   * Returns true if a simple query succeeds.
   */
  ping(): Promise<boolean>;
}
