/**
 * attribution-reconcile — the scheduled attribution write-pipeline job (Phase 5).
 *
 * Enumerates active brands (list_active_brand_ids, 0019) and runs reconcileAttribution for each:
 * the credit pass attributes newly-finalized orders to their journey touches; the clawback pass
 * mirrors reversals. Idempotent per brand. One brand failing does not abort the run; the job exits
 * non-zero only if ANY brand errored.
 *
 * Reads the Postgres Gold ledger (as brain_app) + the StarRocks Silver touch tier (mysql2). When
 * STARROCKS_HOST is unset the job logs and exits 0 (no Silver → nothing to attribute) rather than
 * crash. Invoked by the core image's job entrypoint (CLI): `node dist/jobs/attribution-reconcile.js`.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { SilverPool } from '@brain/metric-engine';
import { createLogger } from '@brain/observability';
import { requireEnvInProd } from '@brain/config';
import { reconcileAttribution, reconcileDataDrivenAttribution } from '../modules/attribution/index.js';

const log = createLogger({ serviceName: 'job:attribution-reconcile' });

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

export interface AttributionJobResult {
  brands: number;
  credited: number;
  clawed_back: number;
  unattributed: number;
  errors: number;
}

export async function runAttributionReconcile(deps?: {
  pool?: pg.Pool;
  srPool?: SilverPool;
}): Promise<AttributionJobResult> {
  const srHost = process.env['STARROCKS_HOST'];
  if (!deps?.srPool && srHost === undefined) {
    log.warn('attribution-reconcile skipped — STARROCKS_HOST unset (no Silver tier to attribute over)');
    return { brands: 0, credited: 0, clawed_back: 0, unattributed: 0, errors: 0 };
  }

  const pool = deps?.pool ?? new pg.Pool({ connectionString: DB_URL, max: 3 });
  const srPool =
    deps?.srPool ??
    (mysql.createPool({
      host: srHost,
      port: Number(process.env['STARROCKS_PORT'] ?? 9030),
      user: process.env['STARROCKS_ANALYTICS_USER'] ?? 'brain_analytics',
      password: requireEnvInProd('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev'),
      connectionLimit: 3,
    }) as unknown as SilverPool);
  const ownsPool = !deps?.pool;
  const ownsSr = !deps?.srPool;

  const result: AttributionJobResult = { brands: 0, credited: 0, clawed_back: 0, unattributed: 0, errors: 0 };
  try {
    const brandsRes = await pool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
    log.info('attribution reconcile starting', { brands: brandsRes.rows.length });

    for (const brand of brandsRes.rows) {
      result.brands += 1;
      try {
        const r = await reconcileAttribution(brand.id, `attr-job-${randomUUID()}`, { pool, srPool });
        result.credited += r.credited;
        result.clawed_back += r.clawed_back;
        result.unattributed += r.unattributed;
        // The GLOBAL data-driven (Markov) model — trained from the corpus, applied per recognized order.
        const dd = await reconcileDataDrivenAttribution(brand.id, `attr-dd-${randomUUID()}`, { pool, srPool });
        result.credited += dd.credited;
        result.clawed_back += dd.clawed_back;
        result.unattributed += dd.unattributed;
      } catch (err) {
        result.errors += 1;
        log.error('reconcile failed for brand', { brand_id: brand.id, err });
      }
    }
    log.info('attribution reconcile complete', { ...result });
    return result;
  } finally {
    if (ownsPool) await pool.end();
    if (ownsSr) await (srPool as unknown as mysql.Pool).end();
  }
}

// Entry point — only when run directly (not when imported in tests).
if (
  process.argv[1]?.endsWith('attribution-reconcile.ts') ||
  process.argv[1]?.endsWith('attribution-reconcile.js')
) {
  runAttributionReconcile()
    .then((r) => process.exit(r.errors > 0 ? 1 : 0))
    .catch((err) => {
      log.error('fatal', { err });
      process.exit(1);
    });
}
