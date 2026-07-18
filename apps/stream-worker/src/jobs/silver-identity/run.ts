/**
 * silver-identity — the SILVER-STAGE identity batch job (ADR-0015 WS3 / doc-18 PR 3.1).
 *
 * Identity is now a TRANSFORM-TIER step invoked from Silver: this job replaces the streaming
 * IdentityBridgeConsumer (+ the consent/CAPI/dirty-set/cache consumers — see side-effects.ts).
 * Neo4j is a Silver dependency, called ONLY from here — never from the collector, the log, or
 * Bronze (ADR-0015 D5).
 *
 * Pipeline ordering (tools/dev/duckdb-refresh.sh): keystone → silver passes → THIS JOB →
 * silver_identity_map.py (graph → Iceberg map) → gold. Invoked as
 * `pnpm --filter @brain/stream-worker run job:silver-identity` (or the built dist path in prod).
 *
 * WHAT ONE RUN DOES (per active brand, leader-locked, watermark-driven):
 *   1. reads NEW canonical Silver keystone rows since (watermark − lookback) over duckdb-serving
 *      (brain_serving.mv_silver_collector_event — the established brand-scoped Node read path,
 *      keyset-paginated on (ingested_at, event_id)),
 *   2. extracts identifiers via the SHARED extractEventIdentifiers (byte-identical hashing),
 *   3. consults the `identifier_hash → brain_id` Redis cache (IdentifierCacheAdapter): an event
 *      whose deterministic identifiers are ALL cached onto ONE brain_id is a guaranteed no-op
 *      resolve → skipped without touching Neo4j (only first-seen identifiers hit the graph),
 *   4. resolves the rest via the EXISTING BatchResolveIdentityUseCase → Neo4jIdentityRepository
 *      (matcher/resolver logic untouched; deterministic-only, same scope as the backfill CLI),
 *   5. applies the direct side effects (side-effects.ts) PER COMMITTED CHUNK (M2 — same
 *      granularity as the Neo4j writes): scoped-recompute + restitch/journey dirty-sets +
 *      tp-cache merge invalidation + identifier-cache priming,
 *   6. seeds the touchpoint hot cache (TouchpointCacheService — flag identity.tp_cache, OFF ⇒ inert),
 *   7. projects consent (ProjectConsentUseCase) and records CAPI retroactive deletions
 *      (RequestCapiDeletionUseCase) for consent-bearing rows — the former ConsentSuppressor/
 *      CapiDeletion consumer lanes, now Silver-stage steps (both idempotent ON CONFLICT),
 *   8. evicts the brand-scoped serving-cache keys directly when a merge dirtied Gold,
 *   9. advances the per-brand watermark ONLY when the brand processed with zero errors — a failed
 *      brand re-processes the same window next run (everything here is idempotent/replay-safe).
 *
 * FLAG: IDENTITY_IN_SILVER — DEFAULT ON (owner-approved deviation from doc-18's staged
 * default-off; single-PR cutover on dummy data). 'false' ⇒ the job exits 0 as an inert no-op.
 *
 * PII: hash-only in logs (I-S02). Tenant isolation: every serving read goes through the
 * ${BRAND_PREDICATE} seam; every write carries brand_id first (I-S01). No money.
 */
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { loadStreamWorkerConfig } from '@brain/config';
import { createFlagService, RedisFlagStoreAdapter, type RedisFlagClient } from '@brain/platform-flags';
import {
  DevVaultKeyProvider,
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
  type VaultKeyProvider,
} from '@brain/pii-vault';
import { createSaltProvider } from '../../infrastructure/secrets/SaltProvider.js';
import { Neo4jIdentityRepository } from '../../infrastructure/neo4j/Neo4jIdentityRepository.js';
import { BatchResolveIdentityUseCase } from '../../application/BatchResolveIdentityUseCase.js';
import { extractEventIdentifiers } from '../../application/extract-event-identifiers.js';
import { ProjectConsentUseCase } from '../../application/ProjectConsentUseCase.js';
import { ConsentRepository } from '../../infrastructure/pg/ConsentRepository.js';
import { RequestCapiDeletionUseCase } from '../../application/RequestCapiDeletionUseCase.js';
import { CapiDeletionRepository } from '../../infrastructure/pg/CapiDeletionRepository.js';
import { PgScopedRecomputeRepository } from '../../infrastructure/pg/ScopedRecomputeRepository.js';
import { PgRestitchDirtyRepository } from '../../infrastructure/pg/RestitchDirtyRepository.js';
import { PgJourneyReversionDirtyRepository } from '../../infrastructure/pg/JourneyReversionDirtyRepository.js';
import { PgSilverIdentityWatermarkRepository } from '../../infrastructure/pg/SilverIdentityWatermarkRepository.js';
import { withTickLeaderLock, LEADER_LOCK_SILVER_IDENTITY } from '../../infrastructure/pg/LeaderLock.js';
import { IdentifierCacheAdapter } from '../../infrastructure/redis/IdentifierCacheAdapter.js';
import { ServingCacheEvictor } from '../../infrastructure/redis/ServingCacheEvictor.js';
import { RedisTouchpointCacheStore } from '../../touchpoint-cache/TouchpointCacheStore.js';
import { IdentityStoreBrainIdResolver } from '../../touchpoint-cache/BrainIdResolver.js';
import { TouchpointCacheService } from '../../touchpoint-cache/TouchpointCacheService.js';
import { incrementCounter } from '@brain/observability';
import { createSilverReader, BRAND_PREDICATE, type SilverReader } from '../dq/silver-reader.js';
import { applyResolveSideEffects, type SideEffectCounts } from './side-effects.js';
import { computeWatermarkWindow } from './watermark-window.js';
import { log } from '../../log.js';

/** Watermark job key (ops.silver_identity_watermark.job_name). */
const JOB_NAME = 'silver-identity';
/** Fallback low watermark for a brand's first run (fold everything). */
const EPOCH_ISO = '1970-01-01T00:00:00.000000Z';

export interface SilverIdentityRunResult {
  ranAsLeader: boolean;
  brands: number;
  rowsRead: number;
  resolved: number;
  cacheSkipped: number;
  noIdentifiers: number;
  invalidRows: number;
  consentProjected: number;
  capiDeletionsRequested: number;
  tpSeeded: number;
  servingCacheEvictedBrands: number;
  sideEffects: SideEffectCounts;
  errors: number;
  watermarksAdvanced: number;
}

interface SilverEventRow {
  event_id: string;
  ingested_at: string;
  payload: string;
}

function emptyCounts(): SideEffectCounts {
  return {
    identityEvents: 0,
    scopedRecomputes: 0,
    restitchKeys: 0,
    journeyReversionKeys: 0,
    tpMergeInvalidations: 0,
    cachePrimedIdentifiers: 0,
  };
}

function addCounts(a: SideEffectCounts, b: SideEffectCounts): void {
  a.identityEvents += b.identityEvents;
  a.scopedRecomputes += b.scopedRecomputes;
  a.restitchKeys += b.restitchKeys;
  a.journeyReversionKeys += b.journeyReversionKeys;
  a.tpMergeInvalidations += b.tpMergeInvalidations;
  a.cachePrimedIdentifiers += b.cachePrimedIdentifiers;
}

export async function runSilverIdentity(): Promise<SilverIdentityRunResult> {
  const cfg = loadStreamWorkerConfig();
  const result: SilverIdentityRunResult = {
    ranAsLeader: false,
    brands: 0,
    rowsRead: 0,
    resolved: 0,
    cacheSkipped: 0,
    noIdentifiers: 0,
    invalidRows: 0,
    consentProjected: 0,
    capiDeletionsRequested: 0,
    tpSeeded: 0,
    servingCacheEvictedBrands: 0,
    sideEffects: emptyCounts(),
    errors: 0,
    watermarksAdvanced: 0,
  };

  // Kill switch (DEFAULT ON — owner-approved deviation from doc-18's staged default-off; see cfg).
  if (!cfg.IDENTITY_IN_SILVER) {
    log.info('[silver-identity] IDENTITY_IN_SILVER=false — inert no-op');
    return result;
  }

  const dbUrl = cfg.BRAIN_APP_DATABASE_URL;
  const pool = new Pool({ connectionString: dbUrl, max: 3 });
  const silver: SilverReader = createSilverReader({
    baseUrl: `http://${cfg.DUCKDB_SERVING_HOST}:${cfg.DUCKDB_SERVING_PORT}`,
  });

  // ── Redis: identifier cache + serving-cache evictor + per-brand flags ────────
  const identifierCache = new IdentifierCacheAdapter(cfg.REDIS_URL, cfg.SILVER_IDENTITY_CACHE_TTL_SECONDS);
  await identifierCache.connect();
  const evictionRedis = new Redis(cfg.REDIS_URL);
  const evictor = new ServingCacheEvictor(evictionRedis);
  const flagRedis = new Redis(cfg.REDIS_URL);
  const flagService = createFlagService({
    store: new RedisFlagStoreAdapter(flagRedis as unknown as RedisFlagClient),
  });

  // ── Identity SoR (Neo4j — ADR-0004) + salt/vault (same wiring as the backfill CLI) ──
  const saltProvider = createSaltProvider(dbUrl);
  // intentional raw: NODE_ENV prod-gating selects the secret/KMS code path (same as main.ts).
  const vaultKeyProvider: VaultKeyProvider =
    process.env['NODE_ENV'] === 'production'
      ? new KmsVaultKeyProvider(new Pool({ connectionString: dbUrl, max: 2 }), new AwsKmsDecryptAdapter())
      : new DevVaultKeyProvider();
  const identityRepo = new Neo4jIdentityRepository(
    cfg.NEO4J_URI,
    cfg.NEO4J_USER,
    cfg.NEO4J_PASSWORD,
    dbUrl,
    vaultKeyProvider,
  );
  await identityRepo.bootstrap();

  // ── Touchpoint hot cache (flag identity.tp_cache, DEFAULT OFF ⇒ inert) ───────
  const tpCacheStore = new RedisTouchpointCacheStore(cfg.REDIS_URL);
  await tpCacheStore.connect();
  const tpCacheService = new TouchpointCacheService(
    flagService,
    new IdentityStoreBrainIdResolver(saltProvider, identityRepo),
    tpCacheStore,
    {
      maxTouchpoints: cfg.TP_CACHE_MAX_TOUCHPOINTS,
      ttlSeconds: cfg.TP_CACHE_TTL_DAYS * 24 * 60 * 60,
    },
  );

  // ── Consent projection + CAPI retroactive deletion (former consumer lanes) ───
  const consentRepo = new ConsentRepository(dbUrl);
  const projectConsent = new ProjectConsentUseCase(saltProvider, consentRepo);
  const capiDeletionRepo = new CapiDeletionRepository(dbUrl);
  const requestCapiDeletion = new RequestCapiDeletionUseCase(
    saltProvider, capiDeletionRepo, cfg.META_CAPI_CREDS_WIRED,
  );

  // ── Ops repos ────────────────────────────────────────────────────────────────
  const watermarkRepo = new PgSilverIdentityWatermarkRepository(pool);
  const scopedRecomputeRepo = new PgScopedRecomputeRepository(pool);
  const restitchRepo = new PgRestitchDirtyRepository(pool);
  const journeyReversionRepo = new PgJourneyReversionDirtyRepository(pool);

  const pageSize = cfg.SILVER_IDENTITY_PAGE_SIZE;
  const nowIso = new Date().toISOString();

  const processBrand = async (brandId: string): Promise<void> => {
    result.brands += 1;
    let brandErrors = 0;
    let servingCacheDirty = false;

    const storedWm = (await watermarkRepo.get(JOB_NAME, brandId)) ?? EPOCH_ISO;
    // BOUNDED FORWARD-SLICE window (ADR-0015 open item #11): the keystone read over the unindexed
    // Iceberg-backed mv_silver_collector_event has NO upper bound, so a cold-start floor reaching
    // back the full catch-up gap (up to maxCatchup = 7d) makes a data-heavy brand's entire backlog
    // one keyset sweep that blows the 25s serving watchdog → watermark held → STUCK FOREVER. The
    // window now reads at most a maxSlice-wide slice `(from, to]` per run with a BOUNDED lookback
    // floor; on a clean pass the watermark advances to the slice CEILING, so the next run's floor
    // moves FORWARD and the 5-min cron chews any backlog across ticks. Re-processing the slice
    // overlap is SAFE — the whole stage is idempotent/replay-safe (deterministic resolve,
    // ON CONFLICT dirty-set writes, sliding-TTL cache primes).
    const window = computeWatermarkWindow({
      nowMs: Date.now(),
      storedWatermarkMs: Date.parse(storedWm),
      lookbackMs: cfg.SILVER_IDENTITY_LOOKBACK_MS,
      maxCatchupMs: cfg.SILVER_IDENTITY_MAX_CATCHUP_MS,
      maxSliceMs: cfg.SILVER_IDENTITY_MAX_SLICE_MS,
    });
    if (window.clipped) {
      // The cap bounded the floor: rows below the clipped floor are NOT covered by this run.
      incrementCounter('silver_identity_catchup_clipped_total', { brand_id: brandId });
      log.warn(
        '[silver-identity] catch-up window CLIPPED by SILVER_IDENTITY_MAX_CATCHUP_MS — rows with ' +
        'ingested_at below the clipped floor are NOT covered; run a manual FULL pass for this brand',
        {
          brand_id: brandId,
          stored_watermark: storedWm,
          catchup_gap_ms: window.catchupGapMs,
          max_catchup_ms: cfg.SILVER_IDENTITY_MAX_CATCHUP_MS,
          clipped_floor: window.fromIso,
        },
      );
    }
    if (window.sliced) {
      // The backlog extends beyond this run's slice ceiling — the cron chews it forward across
      // ticks (one slice per run keeps every read bounded under the 25s serving watchdog). Log so
      // ops sees the brand progressing, not stuck.
      log.info('[silver-identity] catch-up in progress — reading a bounded slice this run', {
        brand_id: brandId,
        from: window.fromIso,
        to: window.toIso,
        catchup_gap_ms: window.catchupGapMs,
        max_slice_ms: cfg.SILVER_IDENTITY_MAX_SLICE_MS,
      });
    }
    const fromIso = window.fromIso;
    const toIso = window.toIso;

    const batchResolve = new BatchResolveIdentityUseCase(saltProvider, identityRepo, brandId, {
      batchSize: cfg.SILVER_IDENTITY_BATCH_SIZE,
    });

    // Keyset cursor over (ingested_at, event_id) — strictly-ordered, tie-safe pagination.
    let cursorTs = fromIso;
    let cursorEventId = '';

    for (;;) {
      let rows: SilverEventRow[];
      try {
        rows = await silver.scopedQuery<SilverEventRow>(
          brandId,
          `SELECT event_id,
                  strftime(ingested_at, '%Y-%m-%dT%H:%M:%S.%fZ') AS ingested_at,
                  payload
             FROM brain_serving.mv_silver_collector_event
            WHERE (ingested_at > CAST(? AS TIMESTAMP)
                   OR (ingested_at = CAST(? AS TIMESTAMP) AND event_id > ?))
              AND ingested_at <= CAST(? AS TIMESTAMP)
              AND ${BRAND_PREDICATE}
            ORDER BY ingested_at, event_id
            LIMIT ${pageSize}`,
          [cursorTs, cursorTs, cursorEventId, toIso],
        );
      } catch (err) {
        brandErrors += 1;
        log.error('[silver-identity] serving read failed — brand aborted (watermark held)', {
          brand_id: brandId, err: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      if (rows.length === 0) break;
      result.rowsRead += rows.length;

      const toResolve: Array<Buffer> = [];

      for (const row of rows) {
        cursorTs = row.ingested_at;
        cursorEventId = row.event_id;

        const buf = Buffer.from(row.payload, 'utf8');

        // Consent projection + CAPI deletion trigger (both self-gating + idempotent ON CONFLICT;
        // a failure here is a consent-loss risk → count it and HOLD the watermark, never skip past).
        try {
          const consent = await projectConsent.execute(buf, nowIso);
          if (consent.outcome === 'projected') result.consentProjected += 1;
          const capi = await requestCapiDeletion.execute(buf, nowIso);
          if (capi.outcome === 'deletion_requested') result.capiDeletionsRequested += 1;
        } catch (err) {
          brandErrors += 1;
          log.error('[silver-identity] consent/CAPI projection failed (watermark held)', {
            brand_id: brandId, event_id: row.event_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }

        // Touchpoint hot-cache seed (flag identity.tp_cache DEFAULT OFF ⇒ cheap inert check;
        // best-effort cache — Iceberg is truth, so a failure is logged, never held against the run).
        try {
          const tp = await tpCacheService.handleCollectorEvent(buf);
          if (tp.outcome === 'appended') result.tpSeeded += 1;
        } catch (err) {
          log.warn('[silver-identity] tp-cache seed failed (fail-safe)', {
            brand_id: brandId, event_id: row.event_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }

        // Identity extraction + identifier-cache consult (only first-seen identifiers hit Neo4j).
        try {
          const extracted = await extractEventIdentifiers(buf, saltProvider);
          if (extracted.status === 'invalid') {
            result.invalidRows += 1;
            continue;
          }
          if (extracted.status === 'no_identifiers') {
            result.noIdentifiers += 1;
            continue;
          }
          const deterministic = extracted.identifiers.filter((i) => i.tier !== 'weak');
          if (deterministic.length === 0) {
            // Weak-only events never resolve deterministically (the batch path is
            // deterministic-only) — nothing for the graph.
            result.noIdentifiers += 1;
            continue;
          }
          const cached = await identifierCache.getMany(
            brandId,
            deterministic.map((i) => ({ type: i.type, hash: i.hash })),
          );
          const allCached = cached.every((c) => c !== null);
          const oneBrain = allCached && new Set(cached as string[]).size === 1;
          if (oneBrain) {
            // Every deterministic identifier already maps to the SAME brain_id → the resolve
            // would be an idempotent re-link (no new edges, no merge). Skip the graph; re-prime
            // for the sliding TTL.
            result.cacheSkipped += 1;
            await identifierCache.primeMany(
              brandId,
              deterministic.map((i) => ({ type: i.type, hash: i.hash, brainId: cached[0]! })),
            );
            continue;
          }
          toResolve.push(buf);
        } catch (err) {
          // Salt failure (D-2) or extraction infrastructure error: hold the watermark.
          brandErrors += 1;
          log.error('[silver-identity] identifier extraction failed (watermark held)', {
            brand_id: brandId, event_id: row.event_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Resolve the page's first-seen events through the EXISTING batch path (Neo4j SoR),
      // applying the direct side effects PER COMMITTED CHUNK (M2): the hook fires after each
      // internal chunk's writeOutcomesBatch commits, so side effects land with the SAME
      // granularity as the graph writes. A mid-page throw therefore never strands committed
      // chunks' merge side effects (they would re-resolve as linked/skipped next run and the
      // scoped-recompute/dirty-set/cache-evict work would be lost forever); the failed brand's
      // watermark is held and the re-run re-applies idempotently (ON CONFLICT upserts,
      // deterministic event_ids, sliding-TTL primes).
      if (toResolve.length > 0) {
        try {
          await batchResolve.executeWithOutcomes(toResolve, nowIso, async (chunk) => {
            result.resolved += chunk.results.filter((r) =>
              r.outcome === 'minted' || r.outcome === 'linked' || r.outcome === 'merged' || r.outcome === 'skipped',
            ).length;
            result.invalidRows += chunk.results.filter((r) => r.outcome === 'invalid').length;

            const applied = await applyResolveSideEffects(brandId, chunk.outcomes, {
              flags: flagService,
              scopedRecomputeRepo,
              restitchRepo,
              journeyReversionRepo,
              identifierCache,
              tpMergeInvalidator: tpCacheService,
              now: nowIso,
            });
            addCounts(result.sideEffects, applied.counts);
            servingCacheDirty = servingCacheDirty || applied.servingCacheDirty;
          });
        } catch (err) {
          brandErrors += 1;
          log.error('[silver-identity] batch resolve failed — brand aborted (watermark held)', {
            brand_id: brandId, batch_events: toResolve.length,
            err: err instanceof Error ? err.message : String(err),
          });
          break;
        }
      }

      if (rows.length < pageSize) break;
    }

    // Direct serving-cache eviction (replaces the cache.invalidate.v1 consumer): once per brand
    // whose Gold surface a merge dirtied. Fail-open inside the evictor (TTL is the safety net).
    if (servingCacheDirty) {
      await evictor.evictBrand(brandId);
      result.servingCacheEvictedBrands += 1;
    }

    // Advance the watermark ONLY on a clean brand pass — a held watermark makes the next run
    // re-process the same (idempotent) window, converging without loss. Advance to the slice
    // CEILING (window.toIso), NOT the max ingested_at seen: the WHOLE (from, to] slice was fully
    // processed (INCLUDING an empty slice), so the next run's floor moves FORWARD. Advancing to
    // maxSeen would stall on a sparse/empty slice and never move past it — the stuck-reset trap.
    if (brandErrors === 0 && toIso > storedWm) {
      await watermarkRepo.set(JOB_NAME, brandId, toIso);
      result.watermarksAdvanced += 1;
    }
    if (brandErrors === 0) incrementCounter('silver_identity_runs_total', { brand_id: brandId });
    result.errors += brandErrors;
  };

  try {
    const out = await withTickLeaderLock(pool, LEADER_LOCK_SILVER_IDENTITY, async () => {
      const brands = await pool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
      log.info('[silver-identity] starting', {
        brands: brands.rows.length, page_size: pageSize,
        lookback_ms: cfg.SILVER_IDENTITY_LOOKBACK_MS,
        max_catchup_ms: cfg.SILVER_IDENTITY_MAX_CATCHUP_MS,
        max_slice_ms: cfg.SILVER_IDENTITY_MAX_SLICE_MS,
      });
      for (const brand of brands.rows) {
        try {
          await processBrand(brand.id);
        } catch (err) {
          // Per-brand fail isolation: one bad brand never stalls the others.
          result.errors += 1;
          log.error('[silver-identity] brand pass failed (isolated)', {
            brand_id: brand.id, err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    result.ranAsLeader = out.ranAsLeader;
    if (!out.ranAsLeader) {
      log.info('[silver-identity] another run holds the leader lock — skipped');
    }
    return result;
  } finally {
    await identityRepo.end().catch(() => undefined);
    await consentRepo.end().catch(() => undefined);
    await capiDeletionRepo.end().catch(() => undefined);
    await identifierCache.quit().catch(() => undefined);
    await tpCacheStore.quit().catch(() => undefined);
    await evictionRedis.quit().catch(() => undefined);
    await flagRedis.quit().catch(() => undefined);
    await silver.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

/** Non-zero when ANY brand errored (the failed brands' watermarks were held — re-run converges). */
export function silverIdentityExitCode(result: SilverIdentityRunResult): number {
  return result.errors > 0 ? 1 : 0;
}

// ── CLI entrypoint (batch job — invoked by tools/dev/duckdb-refresh.sh / Argo cron) ────
if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runSilverIdentity()
    .then((r) => {
      log.info('[silver-identity] complete', { ...r, sideEffects: { ...r.sideEffects } });
      // Machine-readable result line for the refresh orchestrator (mirrors the DuckDB jobs' shape).
      console.log(JSON.stringify({ job: JOB_NAME, ...r }));
      process.exit(silverIdentityExitCode(r));
    })
    .catch((err) => {
      log.error('[silver-identity] fatal', { err });
      process.exit(1);
    });
}
