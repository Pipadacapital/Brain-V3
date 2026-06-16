/**
 * BronzeRow — value object representing a row to be written to bronze_events.
 *
 * Mirrors bronze_spec.json field-for-field so Phase-3 Iceberg migration is
 * a mechanical column-map. All timestamps are ISO-8601 strings (converted to
 * timestamptz at the Postgres write boundary — D-6).
 *
 * No raw PII in any field (I-S02).
 */
export interface BronzeRow {
  /** Tenant key — RLS anchor and PK first component (I-S01). */
  brand_id: string;
  /** Idempotency key component — PK second component (I-ST04). */
  event_id: string;
  /** Event time (UTC, ISO-8601 → timestamptz at write). */
  occurred_at: string;
  /** Collector receipt time (UTC, ISO-8601 → timestamptz at write). */
  ingested_at: string;
  /** Apicurio artifact subject. M1: literal 'brain.collector.event.v1'. */
  schema_name: string;
  /** Apicurio schema version. M1: literal 1 (F-10; Apicurio-resolved in M2). */
  schema_version: number;
  /** Semantic event type — from CollectorEventV1.event_name. */
  event_type: string;
  /** Distributed trace correlation ID (ADR-009). */
  correlation_id: string;
  /** brand_id:event_id composite — for log correlation. */
  partition_key: string;
  /** JSON-encoded event body. No raw PII (I-S02). */
  payload: Record<string, unknown>;
  /** Optional stream-worker metadata (dedup status, watermark lag). */
  processing_flags?: Record<string, unknown> | null;
  /** Optional collector deployment version. */
  collector_version?: string | null;
}
