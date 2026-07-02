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

/**
 * A pending row as claimed by the drainer (AUD-PERF-012): the body travels as the CANONICAL
 * jsonb text (raw_body::text) and is passed to Kafka verbatim — no driver JSON.parse + drainer
 * JSON.stringify round-trip on the SLA path. The three fields the drainer needs (partition key
 * + correlation) are SQL projections, null when absent or not a JSON string.
 */
export interface PendingSpoolEntry {
  readonly id: bigint;
  /** Canonical jsonb text of the spooled body — the Kafka message value, byte-for-byte. */
  readonly rawBodyText: string;
  readonly correlationId: string | null;
  readonly brandId: string | null;
  readonly eventId: string | null;
}
