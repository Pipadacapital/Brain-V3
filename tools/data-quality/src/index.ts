/**
 * data-quality — DQ framework scaffold (Sprint-0, ruling 7)
 *
 * Sprint-0 scope: Zod DQ-category declarations + empty test stubs + CI invocation.
 * No live DQ pipelines (deferred to M1 when Silver/Gold marts have real data).
 *
 * DQ categories (per data-quality skill):
 *   - freshness:      max(event_time) within threshold
 *   - completeness:   null-rate assertions on critical columns
 *   - schema_validity: contract violation rate on ingest
 *   - reconciliation: Bronze row count vs Redpanda offset
 *
 * @see data-quality skill
 *      (dbt was removed in Brain V4 — the transform is now Spark-on-Iceberg under db/iceberg/spark/)
 */

import { z } from 'zod';

// UNIFIED-BRONZE cutover: table name flips with BRONZE_SOURCE (scaffold config; no live queries yet).
const BRONZE_SOURCE = (process.env['BRONZE_SOURCE'] ?? 'legacy').toLowerCase();
const BRONZE_TABLE = BRONZE_SOURCE === 'events' ? 'brain_bronze.events' : BRONZE_TABLE;

// ---------------------------------------------------------------------------
// DQ Category declarations (Zod schema — single source of truth)
// These declarations drive both the dbt test stubs AND the CI DQ gate.
// ---------------------------------------------------------------------------

export const FreshnessCheckSchema = z.object({
  category: z.literal('freshness'),
  tableName: z.string(),
  columnName: z.string(),
  maxAgeHours: z.number().positive(),
  severity: z.enum(['warn', 'error']),
  brandId: z.string().uuid().optional(),  // null = applies to all brands
});

export const CompletenessCheckSchema = z.object({
  category: z.literal('completeness'),
  tableName: z.string(),
  columnName: z.string(),
  maxNullRatePct: z.number().min(0).max(100),
  severity: z.enum(['warn', 'error']),
  brandId: z.string().uuid().optional(),
});

export const SchemaValidityCheckSchema = z.object({
  category: z.literal('schema_validity'),
  topicName: z.string(),
  maxQuarantineRatePct: z.number().min(0).max(100),
  severity: z.enum(['warn', 'error']),
  brandId: z.string().uuid().optional(),
});

export const ReconciliationCheckSchema = z.object({
  category: z.literal('reconciliation'),
  bronzeTableName: z.string(),
  redpandaTopic: z.string(),
  maxRowCountDelta: z.number().int().nonnegative(),
  severity: z.enum(['warn', 'error']),
  brandId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Union type — any DQ check
// ---------------------------------------------------------------------------
export const DQCheckSchema = z.discriminatedUnion('category', [
  FreshnessCheckSchema,
  CompletenessCheckSchema,
  SchemaValidityCheckSchema,
  ReconciliationCheckSchema,
]);

export type FreshnessCheck = z.infer<typeof FreshnessCheckSchema>;
export type CompletenessCheck = z.infer<typeof CompletenessCheckSchema>;
export type SchemaValidityCheck = z.infer<typeof SchemaValidityCheckSchema>;
export type ReconciliationCheck = z.infer<typeof ReconciliationCheckSchema>;
export type DQCheck = z.infer<typeof DQCheckSchema>;

// ---------------------------------------------------------------------------
// DQ check declarations (Sprint-0: stubs — will bind real tables in M1)
// ---------------------------------------------------------------------------

export const DQ_CHECKS: DQCheck[] = [
  // Freshness: Bronze collector_events must have events < 2h old during business hours
  {
    category: 'freshness',
    tableName: BRONZE_TABLE,
    columnName: 'occurred_at',
    maxAgeHours: 2,
    severity: 'error',  // freshness breach = metric marked "estimated"
  },

  // Completeness: brand_id must never be null on any Bronze event
  {
    category: 'completeness',
    tableName: BRONZE_TABLE,
    columnName: 'brand_id',
    maxNullRatePct: 0,  // zero tolerance
    severity: 'error',
  },

  // Completeness: event_id must never be null (idempotency key)
  {
    category: 'completeness',
    tableName: BRONZE_TABLE,
    columnName: 'event_id',
    maxNullRatePct: 0,
    severity: 'error',
  },

  // Schema validity: DLQ rate < 0.1% of total events
  {
    category: 'schema_validity',
    topicName: 'dev.collector.event.v1',
    maxQuarantineRatePct: 0.1,
    severity: 'error',
  },

  // Reconciliation: Bronze row count vs Redpanda committed offset (≤ 100 event lag)
  {
    category: 'reconciliation',
    bronzeTableName: BRONZE_TABLE,
    redpandaTopic: 'dev.collector.event.v1',
    maxRowCountDelta: 100,
    severity: 'warn',  // reconciliation lag → warn (not error — expected under high load)
  },
];

// ---------------------------------------------------------------------------
// Iron Law: metric is authoritative ONLY after DQ gate passes
// (data-quality skill Iron Law)
// ---------------------------------------------------------------------------
export interface DQGateResult {
  passed: boolean;
  failedChecks: string[];
  metricStatus: 'authoritative' | 'estimated';
}

export function evaluateDQGate(checkResults: { checkId: string; passed: boolean }[]): DQGateResult {
  const failed = checkResults.filter(r => !r.passed);
  const passed = failed.length === 0;
  return {
    passed,
    failedChecks: failed.map(f => f.checkId),
    metricStatus: passed ? 'authoritative' : 'estimated',
  };
}

// ---------------------------------------------------------------------------
// Sprint-0 note: no live DQ execution (no real data yet)
// The DQ_CHECKS array is the declaration layer.
// Execution (freshness queries, null-rate queries, reconciliation counts)
// is implemented in M1 as dbt tests + Grafana alerts.
// ---------------------------------------------------------------------------
export const SPRINT_0_NOTE =
  'DQ framework Sprint-0: declarations only. Live execution added in M1 with real Silver/Gold data.';
