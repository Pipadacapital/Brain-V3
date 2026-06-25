/**
 * recommendation-detectors — the scheduled decision-engine job (doc 09: "a per-brand Argo
 * CronWorkflow runs the pipeline and delivers the day's decisions").
 *
 * Enumerates active brands (list_active_brand_ids — SECURITY DEFINER system enumeration, 0019) and
 * runs generateRecommendations for each: detectors raise/refresh/expire the open recommendation set
 * and append to the decision_log. Idempotent per brand (dedup on brand+detector+subject). One brand
 * failing does not abort the run; the job exits non-zero only if ANY brand errored (so the
 * CronWorkflow surfaces a partial failure).
 *
 * Invoked by the core image's job entrypoint (CLI): `node dist/jobs/recommendation-detectors.js`
 * (doc 06 §"Argo jobs → Core"). NOT a long-running service.
 */
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createPool, type DbPool, type QueryContext } from '@brain/db';
import { loadCoreConfig } from '@brain/config';
import type { SilverPool } from '@brain/metric-engine';
import { createLogger } from '@brain/observability';
import { generateRecommendations, measureRecommendationOutcomes } from '../modules/recommendation/index.js';

const log = createLogger({ serviceName: 'job:recommendation-detectors' });

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

/** StarRocks Silver/Gold pool — detector REVENUE signals read the lakehouse ledger (Epic 1 / B). */
function createSrPool(): SilverPool {
  const cfg = loadCoreConfig();
  return mysql.createPool({
    host: cfg.STARROCKS_HOST,
    port: cfg.STARROCKS_PORT,
    user: cfg.STARROCKS_ANALYTICS_USER,
    password: cfg.STARROCKS_ANALYTICS_PASSWORD,
    connectionLimit: 3,
  }) as unknown as SilverPool;
}

export interface RecommendationJobResult {
  brands: number;
  raised: number;
  expired: number;
  measured: number;
  errors: number;
}

export async function runRecommendationDetectors(deps?: { pool?: DbPool; srPool?: SilverPool }): Promise<RecommendationJobResult> {
  const pool = deps?.pool ?? (await createPool({ connectionString: DB_URL }));
  const ownsPool = !deps?.pool;
  const srPool = deps?.srPool ?? createSrPool();
  const ownsSrPool = !deps?.srPool;
  let brands = 0;
  let raised = 0;
  let expired = 0;
  let measured = 0;
  let errors = 0;

  try {
    const ctx: QueryContext = { correlationId: `reco-job-${randomUUID()}` };
    const client = await pool.connect();
    let brandIds: string[];
    try {
      const res = await client.query<{ id: string }>(ctx, 'SELECT id FROM list_active_brand_ids()', []);
      brandIds = res.rows.map((r) => r.id);
    } finally {
      client.release();
    }

    log.info('recommendation detectors starting', { brands: brandIds.length });
    for (const brandId of brandIds) {
      brands += 1;
      try {
        const r = await generateRecommendations(brandId, `reco-job-${randomUUID()}`, { pool, srPool });
        raised += r.raised;
        expired += r.expired;
        // Learning loop: re-measure each open rec's headline metric (then-at-raise vs now). Reuse
        // the signals generate just fetched (PF-6) so measure does not re-read the same source.
        const m = await measureRecommendationOutcomes(brandId, `reco-measure-${randomUUID()}`, {
          pool,
          srPool,
          signals: r.signals,
        });
        measured += m.measured;
      } catch (err) {
        errors += 1;
        log.error('detector run failed for brand', { brand_id: brandId, err });
      }
    }
    log.info('recommendation detectors complete', { brands, raised, expired, measured, errors });
    return { brands, raised, expired, measured, errors };
  } finally {
    if (ownsPool) await pool.end();
    if (ownsSrPool)
      await (srPool as unknown as mysql.Pool)
        .end()
        // Best-effort pool teardown — log at debug rather than swallow silently. // intentional
        .catch((err) => log.debug('recommendation-detectors: StarRocks pool end failed', { err }));
  }
}

// Entry point — only when run directly (not when imported in tests).
if (
  process.argv[1]?.endsWith('recommendation-detectors.ts') ||
  process.argv[1]?.endsWith('recommendation-detectors.js')
) {
  runRecommendationDetectors()
    .then((r) => process.exit(r.errors > 0 ? 1 : 0))
    .catch((err) => {
      log.error('fatal', { err });
      process.exit(1);
    });
}
