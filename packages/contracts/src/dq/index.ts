/**
 * Data Quality (DQ) category declarations — Sprint-0 stubs (scope ruling 7).
 *
 * These Zod schemas declare the DQ metric categories that will feed into
 * dbt test stubs and CI invocations. No live DQ logic ships in Sprint 0.
 *
 * Categories (per doc 12 §4 / INVARIANTS.md I-E04):
 *  - Freshness: data arrived within expected SLA windows.
 *  - Completeness: required fields are populated.
 *  - Schema validity: event payload matches registered Avro schema.
 *  - Reconciliation: aggregate counts match between Bronze and StarRocks.
 */
import { z } from 'zod';

// ── Freshness ────────────────────────────────────────────────────────────────

export const DqFreshnessCheckSchema = z.object({
  category: z.literal('freshness'),
  /** The dbt model or table being checked. */
  table: z.string(),
  /** Expected max age in minutes before DQ fails. */
  max_age_minutes: z.number().int().positive(),
  /** The timestamp column to measure freshness against. */
  timestamp_column: z.string().default('ingest_at'),
});

export type DqFreshnessCheck = z.infer<typeof DqFreshnessCheckSchema>;

// ── Completeness ─────────────────────────────────────────────────────────────

export const DqCompletenessCheckSchema = z.object({
  category: z.literal('completeness'),
  table: z.string(),
  /** Columns that must have non-null values (completeness rate < 100% fails). */
  required_columns: z.array(z.string()).min(1),
  /** Acceptable null rate (0–1). Default 0 = no nulls allowed. */
  max_null_rate: z.number().min(0).max(1).default(0),
});

export type DqCompletenessCheck = z.infer<typeof DqCompletenessCheckSchema>;

// ── Schema validity ──────────────────────────────────────────────────────────

export const DqSchemaValidityCheckSchema = z.object({
  category: z.literal('schema_validity'),
  /** Apicurio subject name (e.g. "brain.collector.event.v1"). */
  avro_subject: z.string(),
  /** The Redpanda topic to sample from. */
  topic: z.string(),
  /** Number of events to sample per check run. */
  sample_size: z.number().int().positive().default(100),
});

export type DqSchemaValidityCheck = z.infer<typeof DqSchemaValidityCheckSchema>;

// ── Reconciliation ───────────────────────────────────────────────────────────

export const DqReconciliationCheckSchema = z.object({
  category: z.literal('reconciliation'),
  /** Description of what is being reconciled. */
  description: z.string(),
  /** The Bronze (Iceberg) aggregate query or table. */
  bronze_source: z.string(),
  /** The StarRocks aggregate query or table. */
  starrocks_source: z.string(),
  /** Acceptable delta in row count (0 = exact match required). */
  max_row_delta: z.number().int().nonnegative().default(0),
});

export type DqReconciliationCheck = z.infer<typeof DqReconciliationCheckSchema>;

// ── Union ─────────────────────────────────────────────────────────────────────

export const DqCheckSchema = z.discriminatedUnion('category', [
  DqFreshnessCheckSchema,
  DqCompletenessCheckSchema,
  DqSchemaValidityCheckSchema,
  DqReconciliationCheckSchema,
]);

export type DqCheck = z.infer<typeof DqCheckSchema>;
