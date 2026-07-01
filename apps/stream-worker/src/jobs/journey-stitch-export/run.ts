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
    // Read the stitch PER-BRAND under the brand GUC. connectors.connector_journey_stitch_map is FORCE RLS
    // (isolation = brand_id = current_setting('app.current_brand_id')), so a GUC-LESS cross-brand read as
    // brain_app silently returns 0 rows — the whole journey-stitch export was materializing nothing. Loop
    // the active brands, set the GUC transaction-locally per read (auto-reset on COMMIT — no pool leak), and
    // accumulate. (ops.silver_journey_stitch is NOT RLS, so the reload write below stays a single cross-brand
    // DELETE + INSERT.)
    type StitchRow = { brand_id: string; order_id: string; stitched_anon_id: string | null; brain_id: string | null; created_at: Date | null };
    const rows: StitchRow[] = [];
    const brandRes = await pgPool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
    for (const { id: brandId } of brandRes.rows) {
      const c = await pgPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]); // txn-local GUC
        const r = await c.query<StitchRow>(
          `SELECT brand_id::text, order_id, stitched_anon_id, brain_id::text AS brain_id, created_at
             FROM connectors.connector_journey_stitch_map`,
        );
        await c.query('COMMIT');
        rows.push(...r.rows);
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    }

    // Full-table reload via DELETE (NOT TRUNCATE): migration 0116 deliberately grants brain_app
    // SELECT/INSERT/UPDATE/DELETE but NOT TRUNCATE (least privilege — TRUNCATE needs table ownership
    // or the TRUNCATE grant). TRUNCATE here raised "permission denied for table silver_journey_stitch".
    // DELETE with no WHERE matches the documented reload design (0116 line 54).
    await pgPool.query('DELETE FROM ops.silver_journey_stitch');
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
