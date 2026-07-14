/**
 * dq/completeness-check.ts — required-column non-null rate vs max_null_rate.
 *
 * Measures the null rate of required columns and grades the "badness" (null-rate / max_null_rate).
 * PG money ledgers (realized_revenue_ledger, ad_spend_ledger) have been dropped — their analytical
 * facts now live in Bronze/Silver, so completeness is a dbt/Bronze build invariant. The only PG
 * completeness target list (COMPLETENESS_TARGETS) is therefore empty; the live check covers the
 * Iceberg Bronze SoR (the ADR-0010 connect lift view: event_type, occurred_at) via bronzeCompleteness.
 *
 * Zero-tolerance (max_null_rate = 0): any null → D (breached), perfect → A+.
 * A table with no rows → A+ (vacuously complete) but observed='no_rows' for honesty —
 * completeness of an empty set is not a data-quality failure (freshness covers absence).
 */

import type { Pool } from 'pg';
import { gradeBadnessRatio } from './grade.js';
import type { DqCheckRow } from './writer.js';
import { BRAND_PREDICATE, BRONZE_COLLECTOR_PREDICATE, ICEBERG_BRONZE, type SilverReader } from './silver-reader.js';
import { log } from '../../log.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface CompletenessTarget {
  readonly target: string;
  readonly table: string;
  readonly requiredColumns: readonly string[];
  readonly maxNullRate: number;
}

/** PG completeness targets. MEDALLION REALIGNMENT: there are NO PG money ledgers left to check —
 * realized_revenue_ledger was dropped (recognition is the Bronze-sourced gold_revenue_ledger) and
 * ad_spend_ledger was dropped (ad spend is the Bronze-sourced silver_marketing_spend). Both are now
 * dbt/Bronze build invariants, not PG completeness checks (see bronzeCompleteness below). This list is
 * intentionally empty — a future operational PG fact would be added here. */
const COMPLETENESS_TARGETS: readonly CompletenessTarget[] = [] as const;

/** Required (NOT NULL) Bronze columns checked against the Iceberg SoR. */
const BRONZE_REQUIRED_COLUMNS = ['event_type', 'occurred_at'] as const;

/** Completeness of the Iceberg Bronze SoR (the ADR-0010 connect lift view) over Trino, brand-scoped at the seam. */
async function bronzeCompleteness(silver: SilverReader, brandId: string): Promise<DqCheckRow> {
  const nullPredicate = BRONZE_REQUIRED_COLUMNS.map((c) => `${c} IS NULL`).join(' OR ');
  const r = await silver.scopedQuery<{ total: string | number; bad: string | number }>(
    brandId,
    `SELECT COUNT(*) AS total,
            COUNT(CASE WHEN ${nullPredicate} THEN 1 END) AS bad
       FROM ${ICEBERG_BRONZE}
      WHERE ${BRONZE_COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}`,
  );
  const total = Number(r[0]?.total ?? 0);
  const bad = Number(r[0]?.bad ?? 0);
  if (total === 0) {
    return { brandId, category: 'completeness', target: 'bronze_events', grade: 'A+', score: '0.0000',
      observed: 'no_rows', threshold: '0', passing: true };
  }
  const nullRate = bad / total;
  const outcome = gradeBadnessRatio(nullRate, 0);
  return { brandId, category: 'completeness', target: 'bronze_events', grade: outcome.grade,
    score: outcome.score, observed: nullRate.toFixed(4), threshold: (0).toFixed(4), passing: outcome.passing };
}

export async function completenessCheck(
  pool: Pool,
  silver: SilverReader | null,
  brandId: string,
): Promise<DqCheckRow[]> {
  const rows: DqCheckRow[] = [];

  // ── Bronze completeness (Iceberg SoR via StarRocks) ────────────────────────
  if (silver !== null) {
    try {
      rows.push(await bronzeCompleteness(silver, brandId));
    } catch (err) {
      log.error(`iceberg bronze completeness read failed brand=${brandId}`, { err: err });
      rows.push({ brandId, category: 'completeness', target: 'bronze_events', grade: 'D', score: null,
        observed: 'unreachable', threshold: '0', passing: false });
    }
  } else {
    rows.push({ brandId, category: 'completeness', target: 'bronze_events', grade: 'D', score: null,
      observed: 'unreachable', threshold: '0', passing: false });
  }

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
