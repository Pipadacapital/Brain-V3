/**
 * dq/completeness-check.ts — required-column non-null rate vs max_null_rate.
 *
 * Measures the null rate of required columns on brand-scoped Postgres tables and
 * grades the "badness" (null-rate / max_null_rate). Targets:
 *   • bronze_events            — required: event_type, occurred_at (brand_id is NOT NULL by schema)
 *   • realized_revenue_ledger  — required: amount_minor, currency_code (money pairing)
 *   • ad_spend_ledger          — required: currency_code (spend pairing)
 *
 * Zero-tolerance (max_null_rate = 0): any null → D (breached), perfect → A+.
 * A table with no rows → A+ (vacuously complete) but observed='no_rows' for honesty —
 * completeness of an empty set is not a data-quality failure (freshness covers absence).
 */

import type { Pool } from 'pg';
import { gradeBadnessRatio } from './grade.js';
import type { DqCheckRow } from './writer.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface CompletenessTarget {
  readonly target: string;
  readonly table: string;
  readonly requiredColumns: readonly string[];
  readonly maxNullRate: number;
}

/** Frozen completeness targets — required columns + max tolerated null rate. */
export const COMPLETENESS_TARGETS: readonly CompletenessTarget[] = [
  {
    target: 'bronze_events',
    table: 'bronze_events',
    requiredColumns: ['event_type', 'occurred_at'],
    maxNullRate: 0,
  },
  {
    target: 'realized_revenue_ledger',
    table: 'realized_revenue_ledger',
    requiredColumns: ['amount_minor', 'currency_code'],
    maxNullRate: 0,
  },
  {
    target: 'ad_spend_ledger',
    table: 'ad_spend_ledger',
    requiredColumns: ['currency_code'],
    maxNullRate: 0,
  },
] as const;

export async function completenessCheck(
  pool: Pool,
  brandId: string,
): Promise<DqCheckRow[]> {
  const rows: DqCheckRow[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );

    for (const t of COMPLETENESS_TARGETS) {
      // COUNT(*) total + COUNT of rows where ANY required column is NULL.
      const nullPredicate = t.requiredColumns.map((c) => `${c} IS NULL`).join(' OR ');
      const r = await client.query<{ total: string; bad: string }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE ${nullPredicate})::text AS bad
           FROM ${t.table}
          WHERE brand_id = $1`,
        [brandId],
      );
      const total = Number(r.rows[0]?.total ?? '0');
      const bad = Number(r.rows[0]?.bad ?? '0');

      if (total === 0) {
        // Empty set is vacuously complete (A+); freshness covers absence-of-data.
        rows.push({
          brandId,
          category: 'completeness',
          target: t.target,
          grade: 'A+',
          score: '0.0000',
          observed: 'no_rows',
          threshold: t.maxNullRate.toString(),
          passing: true,
        });
        continue;
      }

      const nullRate = bad / total;
      const outcome = gradeBadnessRatio(nullRate, t.maxNullRate);
      rows.push({
        brandId,
        category: 'completeness',
        target: t.target,
        grade: outcome.grade,
        score: outcome.score,
        observed: nullRate.toFixed(4),
        threshold: t.maxNullRate.toFixed(4),
        passing: outcome.passing,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return rows;
}
