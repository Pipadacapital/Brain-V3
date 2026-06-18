/**
 * dq/schema-validity-check.ts — REUSES the existing DLQ/quarantine signal.
 *
 * Schema/contract violations already land out-of-band: ProcessEventUseCase
 * quarantines a parsed-but-failed-gate event and writes a 'pixel.brand_mismatch'
 * audit_log row (REC-1); Zod/Avro-validation failures route to the DLQ topic. This
 * check does NOT re-run validation — it CONSUMES the signal already produced:
 *
 *   validity_failure_rate = quarantine_count / (quarantine_count + accepted_count)
 *
 * over a trailing window, where:
 *   • quarantine_count = audit_log rows with a quarantine action for the brand in-window
 *   • accepted_count   = bronze_events rows for the brand in-window (events that PASSED)
 *
 * Graded as a "badness" ratio vs max_validity_failure_rate. No quarantine + some
 * accepted → A+. audit_log has RLS DISABLED (cross-brand SoR) so isolation here is the
 * MANDATORY explicit WHERE brand_id = $1 filter (the same posture DbAuditWriter uses).
 */

import type { Pool } from 'pg';
import { gradeBadnessRatio } from './grade.js';
import type { DqCheckRow } from './writer.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Audit actions that represent a quarantine / schema-or-contract rejection. */
const QUARANTINE_ACTIONS = ['pixel.brand_mismatch'] as const;

/** Frozen SLA: max tolerated schema-validity failure rate (0.1% — matches the Sprint-0 DQ_CHECKS). */
export const MAX_VALIDITY_FAILURE_RATE = 0.001;

/** Trailing window for the validity-rate measurement. */
export const VALIDITY_WINDOW_HOURS = 24;

export async function schemaValidityCheck(
  pool: Pool,
  brandId: string,
): Promise<DqCheckRow[]> {
  const client = await pool.connect();
  let quarantineCount = 0;
  let acceptedCount = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );

    const windowStart = `NOW() - INTERVAL '${VALIDITY_WINDOW_HOURS} hours'`;

    // Quarantine count — audit_log (RLS DISABLED → MANDATORY explicit brand filter).
    const quarantined = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM audit_log
        WHERE brand_id = $1
          AND action = ANY($2::text[])
          AND created_at >= ${windowStart}`,
      [brandId, QUARANTINE_ACTIONS],
    );

    // Accepted count — bronze_events (RLS-scoped under the GUC, also explicit filter).
    const accepted = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM bronze_events
        WHERE brand_id = $1
          AND ingested_at >= ${windowStart}`,
      [brandId],
    );
    await client.query('COMMIT');

    quarantineCount = Number(quarantined.rows[0]?.n ?? '0');
    acceptedCount = Number(accepted.rows[0]?.n ?? '0');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  {
    const total = quarantineCount + acceptedCount;

    if (total === 0) {
      // No events in-window → vacuously valid (A+); freshness covers absence-of-data.
      return [
        {
          brandId,
          category: 'schema_validity',
          target: 'collector.event',
          grade: 'A+',
          score: '0.0000',
          observed: 'no_events',
          threshold: MAX_VALIDITY_FAILURE_RATE.toFixed(4),
          passing: true,
        },
      ];
    }

    const failureRate = quarantineCount / total;
    const outcome = gradeBadnessRatio(failureRate, MAX_VALIDITY_FAILURE_RATE);
    return [
      {
        brandId,
        category: 'schema_validity',
        target: 'collector.event',
        grade: outcome.grade,
        score: outcome.score,
        observed: failureRate.toFixed(4),
        threshold: MAX_VALIDITY_FAILURE_RATE.toFixed(4),
        passing: outcome.passing,
      },
    ];
  }
}
