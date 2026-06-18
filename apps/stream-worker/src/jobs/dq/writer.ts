/**
 * dq/writer.ts — append-only INSERT into dq_check_result under brain_app + brand GUC.
 *
 * Every DQ executor writes exactly one dated row per (brand, category, target) per
 * tick. The write runs under brain_app (RLS enforced — NEVER superuser 'brain') with
 * app.current_brand_id set to the brand BEFORE the INSERT (NN-1 / RLS FORCE). The
 * table is append-only (brain_app has no UPDATE/DELETE) — history is the point.
 */

import type { Pool } from 'pg';
import type { DqCategory, DqLetterGrade } from './grade.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface DqCheckRow {
  readonly brandId: string;
  readonly category: DqCategory;
  readonly target: string;
  readonly grade: DqLetterGrade;
  readonly score: string | null;
  readonly observed: string;
  readonly threshold: string;
  readonly passing: boolean;
}

/**
 * Insert one dq_check_result row under the brand GUC. Uses a dedicated txn so the
 * GUC is set + the INSERT happens on the same session (RLS FORCE requires the GUC).
 */
export async function writeDqResult(pool: Pool, row: DqCheckRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC BEFORE the brand-scoped INSERT (NN-1 / RLS FORCE — verified under brain_app).
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [row.brandId, NIL_UUID],
    );
    await client.query(
      `INSERT INTO dq_check_result
         (brand_id, category, target, grade, score, observed, threshold, passing)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.brandId,
        row.category,
        row.target,
        row.grade,
        row.score,
        row.observed,
        row.threshold,
        row.passing,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
