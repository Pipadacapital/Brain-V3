/**
 * semantic-preagg-refresh — AUD-SL-10: the scheduled MATERIALIZER for the semantic-layer pre-aggs.
 *
 * GAP CLOSED: the @brain/semantic-metrics compiler has always emitted pre-agg DDL + refresh SQL for
 * every `interactive` metric×time-grain (§1.11.1), and the compiled FAST views
 * (mv_metric_<name>_<grain>) read those `iceberg.brain_serving.preagg_*` tables — but NO job ever
 * ran the refresh, so the tables never existed and interactive grains fell back to base-entity
 * scans (fine at current volume, a latency/cost cliff at 100 brands / 1M events/day).
 *
 * WHAT IT DOES: loads the packaged metric registry, compiles it (deterministic — the same compile
 * the D2.snapshot test pins), and executes each pre-agg's ATOMIC Trino rebuild:
 * `CREATE OR REPLACE TABLE … AS SELECT` — ONE Iceberg replace transaction per table, so readers see
 * the previous rows until the new snapshot commits (never an empty table mid-refresh; honest data
 * or previous data, nothing in between).
 *
 * WHY TRINO (not Spark): the pre-agg sources are the semantic ENTITY views
 * (iceberg.brain_serving.semantic_*) — TRINO views (db/trino/views/semantic_*.sql), which Spark
 * cannot execute. Trino 455's Iceberg connector supports atomic CREATE OR REPLACE TABLE AS, making
 * it the correct (and simplest) materializer. The compiled Spark dialect (createDdl/refreshSql)
 * stays committed for a future Spark-readable-source cutover.
 *
 * TENANCY: this is a CROSS-BRAND batch build — brand_id is a GROUPING KEY in every pre-agg, not a
 * predicate (the same posture as the Spark Gold marts). Serving reads NEVER touch these tables
 * directly: they go through the compiled `mv_metric_*` views, which embed the ${BRAND_PREDICATE}
 * seam (compile-time row-level tenancy) — enforced by the D2.tenancy compiler tests.
 *
 * FAILURE POSTURE: one table failing must not starve the rest — errors are collected per table and
 * the job exits non-zero if ANY failed (the CronWorkflow surfaces a partial failure). Idempotent:
 * re-running just replaces the tables again.
 *
 * Invoked by the cronworkflows chart (`pnpm exec tsx src/jobs/semantic-preagg-refresh.ts`, core
 * image) hourly at :40 — after v4-gold (:25) commits the Gold marts the entity views project.
 */
import { loadCoreConfig } from '@brain/config';
import { createTrinoPool, type SilverPool } from '@brain/metric-engine';
import { compileMetric, loadPackagedRegistry, type CompiledPreagg } from '@brain/semantic-metrics';
import { createLogger } from '@brain/observability';

const log = createLogger({ serviceName: 'job:semantic-preagg-refresh' });

/**
 * Raw (UNSCOPED) Trino pool — this job executes cross-brand DDL/CTAS statements, not serving
 * reads, so it deliberately does NOT go through withSilverBrand (there is no per-brand read here;
 * see the TENANCY note above).
 */
function createPool(): SilverPool {
  const cfg = loadCoreConfig();
  return createTrinoPool({
    baseUrl: `http://${cfg.TRINO_HOST}:${cfg.TRINO_PORT}`,
    catalog: 'iceberg',
    schema: 'brain_serving',
    user: 'brain_preagg_refresh',
    // A pre-agg CTAS scans a whole entity view — allow a longer poll budget than the serving
    // default (600 polls ≈ 10 min at the adapter's cadence is plenty for the current marts).
    maxPolls: Number(process.env['PREAGG_REFRESH_MAX_POLLS'] ?? 2400),
  });
}

export interface PreaggRefreshResult {
  tables: number;
  refreshed: number;
  errors: number;
}

/** Collect every compiled pre-agg (interactive metric × time grain) from the packaged registry. */
export async function collectPreaggs(): Promise<CompiledPreagg[]> {
  const reg = await loadPackagedRegistry();
  const out: CompiledPreagg[] = [];
  for (const m of reg.all) {
    for (const g of compileMetric(m).grains) {
      if (g.preagg) out.push(g.preagg);
    }
  }
  return out;
}

export async function runSemanticPreaggRefresh(deps?: { srPool?: SilverPool }): Promise<PreaggRefreshResult> {
  const pool = deps?.srPool ?? createPool();
  const preaggs = await collectPreaggs();
  let refreshed = 0;
  let errors = 0;

  for (const p of preaggs) {
    const startedAt = Date.now();
    try {
      await pool.query(p.trinoCtasSql);
      refreshed += 1;
      log.info('preagg refreshed', { table: p.tableName, duration_ms: Date.now() - startedAt });
    } catch (err) {
      errors += 1;
      log.error('preagg refresh FAILED', {
        table: p.tableName,
        duration_ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('semantic-preagg-refresh complete', { tables: preaggs.length, refreshed, errors });
  return { tables: preaggs.length, refreshed, errors };
}

// Run when invoked directly (the CronWorkflow entrypoint).
const isDirectRun = process.argv[1]?.endsWith('semantic-preagg-refresh.ts') || process.argv[1]?.endsWith('semantic-preagg-refresh.js');
if (isDirectRun) {
  runSemanticPreaggRefresh()
    .then((r) => {
      // exit non-zero on ANY table failure so the CronWorkflow surfaces a partial failure.
      process.exit(r.errors > 0 ? 1 : 0);
    })
    .catch((err) => {
      log.error('semantic-preagg-refresh aborted', { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
