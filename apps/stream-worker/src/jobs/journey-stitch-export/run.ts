/**
 * journey-stitch-export — materialize the PG cart-stitch → StarRocks brain_silver.silver_journey_stitch.
 *
 * MEDALLION REALIGNMENT (Epic 4): connectors.connector_journey_stitch_map is the transactional capture
 * (anon read BACK from the order's note_attributes + the cron-resolved brain_id). dbt/StarRocks can't
 * read it analytically without a PG JDBC shim — the last "PG as analytical read source" deviation. This
 * job full-refreshes the StarRocks projection silver_touchpoint reads. Runs before the journey marts.
 *
 * Invoked by the worker job entrypoint: `node dist/jobs/journey-stitch-export/run.js`.
 */
import pg from 'pg';
import mysql from 'mysql2/promise';
import { log } from '../../log.js';

const PG_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? process.env['STARROCKS_PORT'] ?? '9030');
const SR_USER = process.env['STARROCKS_ROOT_USER'] ?? 'root';
const SR_PASSWORD = process.env['STARROCKS_ROOT_PASSWORD'] ?? '';
const BATCH = 1000;

export interface StitchExportResult {
  rows: number;
}

export async function runJourneyStitchExport(): Promise<StitchExportResult> {
  const pgPool = new pg.Pool({ connectionString: PG_URL, max: 3 });
  const sr = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: SR_USER, password: SR_PASSWORD, connectionLimit: 4 });
  try {
    // Read the full stitch (superuser/brain_app — cross-brand ETL; isolation at the read seam).
    const rows = (
      await pgPool.query<{ brand_id: string; order_id: string; stitched_anon_id: string | null; brain_id: string | null; created_at: Date | null }>(
        `SELECT brand_id::text, order_id, stitched_anon_id, brain_id::text AS brain_id, created_at
           FROM connectors.connector_journey_stitch_map`,
      )
    ).rows;

    await sr.query('TRUNCATE TABLE brain_silver.silver_journey_stitch');
    const dt = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 19).replace('T', ' ') : null);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const tuples = chunk.map(() => '(?,?,?,?,?,NOW())').join(',');
      const params: unknown[] = [];
      for (const r of chunk) params.push(r.brand_id, r.order_id, r.stitched_anon_id, r.brain_id, dt(r.created_at));
      await sr.query(
        `INSERT INTO brain_silver.silver_journey_stitch
           (brand_id, order_id, stitched_anon_id, brain_id, created_at, updated_at)
         VALUES ${tuples}`,
        params,
      );
    }
    log.info(`[journey-stitch-export] materialized ${rows.length} stitch rows → silver_journey_stitch`);
    return { rows: rows.length };
  } finally {
    await pgPool.end();
    await sr.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runJourneyStitchExport()
    .then((r) => { log.info(`[journey-stitch-export] done — ${r.rows} rows`); process.exit(0); })
    .catch((err) => { log.error('[journey-stitch-export] fatal', { err }); process.exit(1); });
}
