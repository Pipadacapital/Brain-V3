/**
 * ingest-dedup-prune — bounded retention for the global ingest dedup index (ADR-0012).
 *
 * Argo CronWorkflow entry point (run weekly). Calls the catalog-driven SQL routine
 * data_plane.prune_ingest_dedup(retain interval, batch integer) (migration 0131), which batched-DELETEs
 * rows from data_plane.ingest_dedup whose ingested_at is older than the retention window. Without a prune
 * the dedup index (one row per (brand_id, event_id) ever ingested) grows unbounded.
 *
 * The function is SECURITY DEFINER (definer owns the table, so it may DELETE and bypasses the per-brand
 * FORCE RLS policy across all brands in one pass) with EXECUTE granted to brain_app, so this job connects
 * as brain_app like every other worker path — no elevated DELETE grant on the role, and NO brand GUC to
 * set (a single connection running the SELECT suffices). Forgetting old rows is safe: backfills only
 * re-ingest recent data, and Silver's per-lane dedup backstops any very-old re-ingest (see 0131 header).
 *
 * Config via env (sane defaults):
 *   INGEST_DEDUP_RETAIN       (default '180 days') — Postgres interval literal; prune rows older than this.
 *   INGEST_DEDUP_PRUNE_BATCH  (default 50000)      — batch size for the batched DELETE.
 *
 * Usage: node dist/jobs/ingest-dedup-prune.js  (or via Argo CronWorkflow targeting this file).
 */

import { Pool } from 'pg';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../log.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;

export async function runIngestDedupPrune(): Promise<{ deleted: number }> {
  const retain = cfg.INGEST_DEDUP_RETAIN;
  const batch = cfg.INGEST_DEDUP_PRUNE_BATCH;

  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  try {
    log.info(`ingest-dedup prune starting retain='${retain}' batch=${batch}`);
    const res = await pool.query<{ deleted: string }>(
      'SELECT data_plane.prune_ingest_dedup($1::interval, $2) AS deleted',
      [retain, batch],
    );
    // bigint comes back as a string over the wire — parse for the log/return.
    const deleted = Number.parseInt(res.rows[0]?.deleted ?? '0', 10);
    log.info(`ingest-dedup prune complete: deleted=${deleted}`);
    return { deleted };
  } finally {
    await pool.end();
  }
}

// Run when invoked directly
if (
  process.argv[1]?.endsWith('ingest-dedup-prune.ts') ||
  process.argv[1]?.endsWith('ingest-dedup-prune.js')
) {
  runIngestDedupPrune().catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}
