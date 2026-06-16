/**
 * SpoolEntry entity — represents a single row in collector_spool.
 * The spool is the durability anchor: events are here BEFORE any Redpanda produce.
 */
export interface SpoolEntry {
  readonly id: bigint;
  readonly receivedAt: Date;
  readonly rawBody: Record<string, unknown>;
  readonly status: 'pending' | 'drained';
  readonly drainedAt: Date | null;
}

export interface PendingSpoolEntry {
  readonly id: bigint;
  readonly rawBody: Record<string, unknown>;
}
