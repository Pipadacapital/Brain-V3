/**
 * attribution-reconcile — the scheduled attribution write-pipeline job (Phase 5).
 *
 * Enumerates active brands (list_active_brand_ids, 0019) and runs reconcileAttribution for each:
 * the credit pass attributes newly-finalized orders to their journey touches; the clawback pass
 * mirrors reversals. Idempotent per brand. One brand failing does not abort the run; the job exits
 * non-zero only if ANY brand errored.
 *
 * Reads the Postgres Gold ledger (as brain_app) + the Silver/Gold SERVING tier over TRINO (Iceberg).
 * When TRINO_HOST is unset the job logs and exits 0 (no serving tier → nothing to attribute) rather
 * than crash. Invoked by the core image's job entrypoint (CLI): `node dist/jobs/attribution-reconcile.js`.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTrinoPool, type SilverPool } from '@brain/metric-engine';
import { createLogger } from '@brain/observability';
import { loadCoreConfig } from '@brain/config';
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
  // Skip-when-unavailable: gate on TRINO_HOST (the V4 serving tier). Unset → no serving tier to
  // attribute over → log + exit 0 rather than crash.
  const srHost = process.env['TRINO_HOST'];
  if (!deps?.srPool && srHost === undefined) {
    log.warn('attribution-reconcile skipped — TRINO_HOST unset (no serving tier to attribute over)');
    return { brands: 0, credited: 0, clawed_back: 0, unattributed: 0, errors: 0 };
  }

  const pool = deps?.pool ?? new pg.Pool({ connectionString: DB_URL, max: 3 });
  // Trino HTTP adapter — catalog='iceberg' resolves the two-part `brain_serving.mv_*` names to the
  // Trino serving views over Iceberg Gold/Silver. Stateless REST — no connection pool to tear down.
  const srPool: SilverPool =
    deps?.srPool ??
    createTrinoPool({
      baseUrl: `http://${srHost}:${loadCoreConfig().TRINO_PORT}`,
      catalog: 'iceberg',
      schema: 'brain_serving',
      user: 'brain_core',
    });
  const ownsPool = !deps?.pool;

  const result: AttributionJobResult = { brands: 0, credited: 0, clawed_back: 0, unattributed: 0, errors: 0 };
  try {
    const brandsRes = await pool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
    log.info('attribution reconcile starting', { brands: brandsRes.rows.length });

    for (const brand of brandsRes.rows) {
      result.brands += 1;
      try {
        const r = await reconcileAttribution(brand.id, `attr-job-${randomUUID()}`, { srPool });
        result.credited += r.credited;
        result.clawed_back += r.clawed_back;
        result.unattributed += r.unattributed;
        // The GLOBAL data-driven (Markov) model — trained from the corpus, applied per recognized order.
        const dd = await reconcileDataDrivenAttribution(brand.id, `attr-dd-${randomUUID()}`, { srPool });
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
    // srPool is the stateless Trino HTTP adapter (createTrinoPool) — no connection pool to tear down.
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
