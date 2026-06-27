/**
 * journey-stitch-export — materialize the PG cart-stitch → ops.silver_journey_stitch (PG `ops` schema).
 *
 * MEDALLION REALIGNMENT (Epic 4): connectors.connector_journey_stitch_map is the transactional capture
 * (anon read BACK from the order's note_attributes + the cron-resolved brain_id). The journey marts read
 * the ops.silver_journey_stitch projection. V4 (StarRocks REMOVAL, migration 0116) moved that projection
 * into the PG `ops` schema — PG is the SOLE operational store — so this job now reads AND writes PG on a
 * single pool. Full-refresh (TRUNCATE + reload); ON CONFLICT keeps mid-batch replays idempotent.
 *
 * Invoked by the worker job entrypoint: `node dist/jobs/journey-stitch-export/run.js`.
 */
import pg from 'pg';
import { log } from '../../log.js';

// intentional raw: distinct DATABASE_URL fallback + a different (superuser 'brain') default
// than the worker brain_app default centralized in config — preserve the exact chain here.
const PG_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BATCH = 1000;

export interface StitchExportResult {
  rows: number;
}

export async function runJourneyStitchExport(): Promise<StitchExportResult> {
  const pgPool = new pg.Pool({ connectionString: PG_URL, max: 3 });
  try {
    // Read the full stitch (brain_app — cross-brand ETL; isolation at the read seam).
    const rows = (
      await pgPool.query<{ brand_id: string; order_id: string; stitched_anon_id: string | null; brain_id: string | null; created_at: Date | null }>(
        `SELECT brand_id::text, order_id, stitched_anon_id, brain_id::text AS brain_id, created_at
           FROM connectors.connector_journey_stitch_map`,
      )
    ).rows;

    await pgPool.query('TRUNCATE TABLE ops.silver_journey_stitch');
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = chunk
        .map((r, j) => {
          const b = j * 5;
          params.push(r.brand_id, r.order_id, r.stitched_anon_id, r.brain_id, r.created_at);
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW())`;
        })
        .join(',');
      await pgPool.query(
        `INSERT INTO ops.silver_journey_stitch
           (brand_id, order_id, stitched_anon_id, brain_id, created_at, updated_at)
         VALUES ${tuples}
         ON CONFLICT (brand_id, order_id) DO UPDATE SET
           stitched_anon_id = EXCLUDED.stitched_anon_id,
           brain_id         = EXCLUDED.brain_id,
           created_at       = EXCLUDED.created_at,
           updated_at       = NOW()`,
        params,
      );
    }
    log.info(`[journey-stitch-export] materialized ${rows.length} stitch rows → ops.silver_journey_stitch`);
    return { rows: rows.length };
  } finally {
    await pgPool.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runJourneyStitchExport()
    .then((r) => { log.info(`[journey-stitch-export] done — ${r.rows} rows`); process.exit(0); })
    .catch((err) => { log.error('[journey-stitch-export] fatal', { err }); process.exit(1); });
}
