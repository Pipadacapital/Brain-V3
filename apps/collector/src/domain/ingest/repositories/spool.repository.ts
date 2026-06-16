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
   * Health check — can the spool DB be reached?
   * Returns true if a simple query succeeds.
   */
  ping(): Promise<boolean>;
}
