/**
 * Stream-worker (Deployable 2) — connector pull-job runner + the erasure consumer lane.
 *
 * ADR-0015 WS2 (single Bronze writer): the stream-worker NO LONGER writes Bronze in any form.
 * The Kafka Connect Iceberg sink (ADR-0010) is the SOLE Bronze writer — it lands the whole
 * collector topic (pixel + server-trusted + backfill lanes) into brain_bronze.collector_events_connect,
 * and the Silver keystone (silver_collector_event.py) owns validation, the R2 tenant / R3 consent
 * gate, quarantine routing, and the (brand_id, event_id) admission MERGE.
 *
 * ADR-0015 WS3/WS4 (identity in Silver): the identity/consent/CAPI/cache/touchpoint consumer lanes
 * are DELETED from the streaming path. Identity resolution is a SILVER-STAGE batch step now —
 * jobs/silver-identity/run.ts reads new canonical Silver rows since a watermark, resolves via the
 * PRESERVED IdentityResolver/Neo4jIdentityRepository (fronted by an identifier_hash→brain_id Redis
 * cache), writes the merge/suppress dirty-sets to ops.*_pending DIRECTLY, folds consent projection
 * (ProjectConsentUseCase) + CAPI-deletion triggering, and evicts brand-scoped serving-cache keys
 * in-process (ServingCacheEvictor). Neo4j is NEVER wired to the collector, the log, or Bronze.
 * The removed consumers: IdentityBridgeConsumer, IdentityChangeRecomputeConsumer,
 * RestitchDirtyConsumer, JourneyReversionDirtyConsumer, ConsentSuppressorConsumer,
 * AnalyticsCacheInvalidateConsumer, CapiDeletionConsumer, TouchpointCacheConsumer — and the
 * identity.* / cache.invalidate.v1 / gold.rewritten.v1 Kafka lanes they served.
 *
 * WHAT REMAINS HERE: the DPDP/PDPL erasure orchestrator (the one request-driven consumer group
 * left on the live collector topic) and the connector pull-job runner (backfills, repulls,
 * schedulers, DQ). The pull jobs PRODUCE to the log (Kafka Connect lands them — no direct Bronze
 * write anywhere in this process).
 *
 * Connects as brain_app (not brain) so RLS is enforced (F-4). Dev DB superuser 'brain' BYPASSES
 * RLS — NEVER use DATABASE_URL=postgres://brain@... for this service. Use BRAIN_APP_DATABASE_URL.
 */
import { Kafka, type ConsumerConfig } from 'kafkajs';
import { Pool, Pool as PgPool } from 'pg';
import { assertRoleEnforcesRls } from '@brain/db';
import { resolveRackId } from './infrastructure/kafka/resolveRackId.js';
import { RetryCounterAdapter } from './infrastructure/redis/RetryCounterAdapter.js';
import { Neo4jIdentityRepository } from './infrastructure/neo4j/Neo4jIdentityRepository.js';
import { PgScopedRecomputeRepository } from './infrastructure/pg/ScopedRecomputeRepository.js';
import { Redis } from 'ioredis';
import { createSaltProvider } from './infrastructure/secrets/SaltProvider.js';
import { initObservability, initSentry, createLogger, registerProcessFailureHandlers } from '@brain/observability';
import { loadStreamWorkerConfig } from '@brain/config';

/** Structured logger for stream-worker lifecycle/error logs. */
const log = createLogger({ serviceName: 'stream-worker' });
import {
  DevVaultKeyProvider,
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
  type VaultKeyProvider,
} from '@brain/pii-vault';
import { RequestCapiDeletionUseCase } from './application/RequestCapiDeletionUseCase.js';
import { CapiDeletionRepository } from './infrastructure/pg/CapiDeletionRepository.js';
import { ErasureOrchestratorConsumer } from './interfaces/consumers/ErasureOrchestratorConsumer.js';
import { EraseSubjectUseCase, type IBrainIdLookup } from './application/EraseSubjectUseCase.js';
import { ArgoErasureWorkflowSubmitter } from './infrastructure/argo/ArgoErasureWorkflowSubmitter.js';
import { ErasureRepository } from './infrastructure/pg/ErasureRepository.js';
import {
  ServingCacheEvictor,
  DirectServingCacheInvalidator,
} from './infrastructure/redis/ServingCacheEvictor.js';
// MEDALLION REALIGNMENT: ALL PG-ledger write paths are now REMOVED. The revenue recognition ledger
// is built FROM Bronze (silver_order_recognition → gold_revenue_ledger). Ad spend likewise flows
// spend.live.v1 → Bronze (Iceberg, server-trusted) → silver_marketing_spend. PostgreSQL holds
// operational state only.
import { startHealthServer } from './infrastructure/health/HealthServer.js';
import { startSyncRequestClaimer, enumerateConnectedConnectors } from './jobs/sync-request-claimer/run.js';
import { run as runShopifyBackfill } from './jobs/shopify-backfill/run.js';
import { runIngestionBackfillFromQueue, type SupportedProvider } from './jobs/ingestion-backfill/run.js';
import { supportsBackfillQueue, supportsIngestionBackfill } from '@brain/connector-core';
import { PgBackfillJobRepository } from './infrastructure/pg/BackfillJobRepository.js';
import { startDqChecks } from './jobs/dq/run.js';
import { startIngestScheduler } from './jobs/ingest-scheduler/run.js';
import { ConnectorRateLimiter } from './infrastructure/redis/ConnectorRateLimiter.js';
// Advertising metadata + 2-year backfill jobs (A2/A3 Transport handoffs). meta-entity-sync /
// google-entity-sync emit the SHARED ad.entity.updated feed (~6h cadence); the spend-repull
// runBackfill() lanes walk back 730 days resumably (safe to re-trigger; instant no-op at the floor).
import { run as runMetaEntitySync } from './jobs/meta-entity-sync/run.js';
import { run as runGoogleEntitySync } from './jobs/google-entity-sync/run.js';
import { runBackfill as runMetaSpendBackfill } from './jobs/meta-spend-repull/run.js';
import {
  runBackfill as runGoogleSpendBackfill,
  enumerateGoogleConnectors,
} from './jobs/google-ads-spend-repull/run.js';

interface PeriodicJobHandle {
  stop(): Promise<void>;
}

/**
 * Generic in-process periodic runner (A2/A3 ad-connector metadata + backfill jobs). Fires runFn() once
 * at startup then every intervalMs, with an inFlight guard (a slow run never re-enters) and full error
 * isolation (a throw is logged + swallowed so the loop never dies) — the SAME loop shape as
 * startIngestScheduler. Each scheduled job self-enumerates its connectors and owns its own Pool +
 * idempotent producer, so this helper only handles cadence; it holds no brand context (MT-1 preserved).
 */
function startPeriodicJob(
  name: string,
  intervalMs: number,
  runFn: () => Promise<void>,
): PeriodicJobHandle {
  let running = true;
  let inFlight = false;
  const tickOnce = async (): Promise<void> => {
    if (inFlight) return; // a still-running tick never re-enters
    inFlight = true;
    try {
      await runFn();
    } catch (err) {
      log.error(`[periodic:${name}] run failed (non-fatal)`, { err });
    } finally {
      inFlight = false;
    }
  };
  const loop = async (): Promise<void> => {
    while (running) {
      await tickOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };
  void loop();
  return {
    stop: async (): Promise<void> => {
      running = false;
    },
  };
}

export async function main(): Promise<void> {
  // Real OpenTelemetry export (ADR-009) — gated by OTEL_EXPORTER_OTLP_ENDPOINT (no-op in dev).
  // Keep the flush fns so graceful shutdown can export the final batch before exit (C1).
  const cfg = loadStreamWorkerConfig();
  const shutdownObservability = await initObservability({ serviceName: 'stream-worker', otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT });
  const closeSentry = await initSentry({ serviceName: 'stream-worker' }); // gated by SENTRY_DSN (no-op in dev)
  // Last-resort handlers (AUD-IMPL-003): route unhandledRejection/uncaughtException through the
  // structured logger + Sentry (instead of Node's raw-stderr crash), then exit non-zero.
  registerProcessFailureHandlers({ log, serviceName: 'stream-worker', flush: closeSentry });

  const brokers = cfg.KAFKA_BROKERS.split(',');
  const redisUrl = cfg.REDIS_URL;
  // IMPORTANT: must connect as brain_app to enforce RLS (not superuser 'brain')
  const dbUrl = cfg.BRAIN_APP_DATABASE_URL;
  const topic = cfg.COLLECTOR_TOPIC;
  // DPDP/PDPL crypto-shred erasure orchestrator: the ONE remaining consumer group on the live
  // topic (ADR-0015 WS4 — request-driven; every other lane moved to the Silver identity stage).
  // On a subject-erasure: shreds subject DEK (is_active=FALSE) + belt-and-suspenders hard delete
  // + surrogate tombstone + scoped Gold re-projection + CAPI deletion. Ordered, idempotent,
  // DLQ-after-MAX_RETRY. WIRED HERE: do NOT remove without updating erasure-orchestrator.unit.test.ts.
  const erasureOrchestratorGroupId = cfg.ERASURE_ORCHESTRATOR_CONSUMER_GROUP_ID;
  // ADR-0015 WS2: the backfill-lane Bronze consumer is GONE (Kafka Connect lands the backfill
  // topic directly — it is in the collector sink's `topics` list); BACKFILL_TOPIC remains a
  // producer-side concern of the backfill jobs (they load config themselves).

  const kafka = new Kafka({
    clientId: 'stream-worker',
    brokers,
    retry: { retries: 5 },
  });

  // KIP-392: inject this pod's AZ as the consumer rackId so EVERY consumer fetches from a same-AZ
  // replica (RackAwareReplicaSelector on the brokers) instead of the cross-AZ leader — cutting
  // DataTransfer-Regional-Bytes $. One wrap covers all consumer sites; an empty rackId (IMDS
  // unreachable / override unset) leaves today's leader-fetch behaviour untouched (no regression).
  const rackId = await resolveRackId();
  if (rackId) {
    // Monkeypatch the shared client so every consumer created downstream inherits the rackId (KIP-392).
    const base = kafka.consumer.bind(kafka);
    kafka.consumer = (config: ConsumerConfig) => base({ ...config, rackId });
    log.info('kafka rack-awareness enabled (KIP-392 follower fetching)', { rackId });
  }

  // ── Worker PG pool (health probe + RLS fail-closed guard) ───────────────────
  // P2.3: every worker pool uses dbUrl (must be brain_app, NOBYPASSRLS). Fail closed at startup if
  // it points at the superuser 'brain' — the worker writes consent/erasure state under per-brand
  // GUCs and a bypassing role would silently defeat FORCE RLS on those tables (the dev footgun).
  const auditPool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000 });
  await assertRoleEnforcesRls(auditPool, { label: 'stream-worker pool (dbUrl)' });

  // ── Durable retry counter (T2-8) ────────────────────────────────────────────
  // Redis-backed counter for the erasure consumer's retry/DLQ discipline. Keyed by
  // {groupId}:{topic}:{partition}:{offset}. Connected once here, quit on shutdown.
  const retryCounter = new RetryCounterAdapter(redisUrl);
  await retryCounter.connect();

  // ── Liveness/readiness probes (T2-10) ───────────────────────────────────────
  // Start the health port BEFORE the consumer so liveness answers during the (slow) boot
  // window. Readiness stays false (503) until the consumer has started AND Postgres is
  // reachable. pingDb reuses auditPool (brain_app) — a SELECT 1 needs no RLS GUC.
  let consumersReady = false;
  const healthServer = startHealthServer({
    port: cfg.HEALTH_PORT,
    isReady: () => consumersReady,
    pingDb: async () => {
      await auditPool.query('SELECT 1');
    },
    log,
  });

  // ── ADR-0015 WS3: NO identity resolution in this process ────────────────────────────────
  // The Silver identity stage (jobs/silver-identity/run.ts, ordered into tools/dev/duckdb-refresh.sh
  // between the silver passes and gold) owns extract → resolve (Neo4j) → dirty-sets → consent/CAPI →
  // cache eviction. The Neo4j repository below exists ONLY for the erasure lane's brain_id lookup +
  // graph purge (request-driven compliance — not stream identity resolution).
  const saltProvider = createSaltProvider(dbUrl);
  // PII vault DEK provider (P0-C): dev derives a deterministic per-brand DEK; prod unwraps
  // the brand_keyring DEK via AWS KMS.
  // intentional raw: NODE_ENV prod-gating selects the secret/KMS code path.
  const vaultKeyProvider: VaultKeyProvider =
    process.env['NODE_ENV'] === 'production'
      ? new KmsVaultKeyProvider(new PgPool({ connectionString: dbUrl, max: 2 }), new AwsKmsDecryptAdapter())
      : new DevVaultKeyProvider();
  const identityRepo = new Neo4jIdentityRepository(
    cfg.NEO4J_URI,
    cfg.NEO4J_USER,
    cfg.NEO4J_PASSWORD,
    dbUrl,
    vaultKeyProvider,
  );
  try {
    await identityRepo.bootstrap();
    log.info('[erasure] Neo4j identity SoR wired for the erasure lane (ADR-0004; lookup + purge only).');
  } catch (err) {
    log.warn(`[erasure] Neo4j bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Erasure orchestrator (DPDP/PDPL crypto-shred — feat-erasure-orchestrator) ──
  // Drives the ordered per-subject erasure sequence: DEK shred (subject_keyring is_active=FALSE) →
  // surrogate tombstone → Neo4j graph purge → scoped Gold re-projection + serving-cache eviction →
  // Bronze raw sweep → CAPI deletion → erasure complete.
  //
  // brainIdLookup: inline adapter over identityRepo.findBrainIdForErasure() — the erasure-lane
  // resolution that ALSO matches tombstoned edges (AUD-OPS-039 replay-safety). Throws on Neo4j
  // down (→ retry). Returns null on not-found (→ 'no_brain_id' skip, WARN).
  const brainIdLookup: IBrainIdLookup = {
    async findBrainId(lookupBrandId, subjectHash, identifierType) {
      // SEC H-1: match on the SUBJECT'S identifier type (email OR phone) — hardcoding 'email'
      // silently dropped phone-only RTBF erasures (acknowledged, never shredded = DPDP failure).
      return identityRepo.findBrainIdForErasure(lookupBrandId, identifierType, subjectHash);
    },
  };
  // ops pool: the scoped-recompute queue the erasure lane fail-closed writes (PG `ops` schema).
  const opsPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const scopedRecomputeRepo = new PgScopedRecomputeRepository(opsPool);
  // CAPI retroactive deletion — REUSED by the erasure sequence (the consent-withdrawal trigger
  // itself moved to the Silver identity stage). Default-closed: in dev (no Meta creds) requests
  // are recorded as 'would_delete_dev' — NOTHING is sent to Meta.
  const capiDeletionRepo = new CapiDeletionRepository(dbUrl);
  const requestCapiDeletionUseCase = new RequestCapiDeletionUseCase(
    saltProvider, capiDeletionRepo, cfg.META_CAPI_CREDS_WIRED,
  );
  // AUD-TP-22 → ADR-0015 WS3: serving-cache invalidation is now a DIRECT Redis eviction
  // (ServingCacheEvictor — the same brand-guarded SCAN+DEL the removed
  // AnalyticsCacheInvalidateConsumer ran), fulfilling the use case's publisher port in-process.
  const cacheEvictionRedis = new Redis(redisUrl);
  const directCacheInvalidator = new DirectServingCacheInvalidator(
    new ServingCacheEvictor(cacheEvictionRedis),
  );
  const erasureRepo = new ErasureRepository(dbUrl);
  // AUD-OPS-037: Bronze raw-PII erasure submitter — STEP 4 of the ordered sequence submits the
  // `bronze-raw-erasure` Argo WorkflowTemplate (erasure_raw_delete.py) so the subject's raw rows
  // leave the Bronze Iceberg tables (physical completion after bronze-maintenance snapshot expiry).
  // GATED on ARGO_SERVER_URL: unset (dev/tests) → the use case falls back to the registered-
  // DISABLED shredIcebergSnapshots seam. FAIL-SAFE when set: an unreachable Argo/k8s API throws →
  // the consumer does not commit → retry → DLQ@MAX_RETRY (an erasure is never silently dropped).
  const bronzeRawErasureSubmitter = cfg.ARGO_SERVER_URL
    ? new ArgoErasureWorkflowSubmitter({
        serverUrl: cfg.ARGO_SERVER_URL,
        mode: cfg.ARGO_SUBMIT_MODE,
        namespace: cfg.ARGO_WORKFLOWS_NAMESPACE,
        templateName: cfg.ARGO_ERASURE_WORKFLOW_TEMPLATE,
        authToken: cfg.ARGO_TOKEN,
        timeoutMs: cfg.ARGO_SUBMIT_TIMEOUT_MS,
      })
    : undefined;
  const eraseSubjectUseCase = new EraseSubjectUseCase(
    saltProvider,
    erasureRepo,
    brainIdLookup,
    scopedRecomputeRepo,
    requestCapiDeletionUseCase,
    // SEC M-1: evict the hot subject DEK from this process's vault cache the instant it is shredded.
    (b, s) => vaultKeyProvider.invalidate(b, s),
    bronzeRawErasureSubmitter,
    // AUD-TP-22: RTBF → serving-cache invalidation — DIRECT eviction (ADR-0015 WS3), same
    // brand-scoped guarantees as the retired cache.invalidate.v1 lane. FAIL-OPEN inside the use case.
    directCacheInvalidator,
    // AUD-OPS-039: Neo4j graph purge (STEP 2b) + graph-hash keying for the Bronze sweep on
    // brain_id-only triggers (STEP 4).
    identityRepo,
  );
  const erasureOrchestratorConsumer = new ErasureOrchestratorConsumer(
    kafka, eraseSubjectUseCase, topic, erasureOrchestratorGroupId, retryCounter,
  );

  // ── On-demand "Sync now" claimer (feat-connector-sync-now) ──────────────────
  // NOT a new deployable: an interval loop in THIS process. Claims sentinel
  // connector_cursor sync-request rows (written by core POST .../sync) and dispatches
  // the SAME repull run() the scheduler invokes (same code path). run()'s own
  // FOR UPDATE SKIP LOCKED overlap-lock guarantees no double-run. MUST use brain_app
  // (RLS enforced) — never superuser 'brain'. WIRED HERE: do not remove without
  // updating sync-request-claimer.live.test.ts.
  const syncClaimerPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const syncRequestClaimerIntervalMs = cfg.SYNC_REQUEST_CLAIMER_INTERVAL_MS;
  const syncRequestClaimer = startSyncRequestClaimer(syncClaimerPool, syncRequestClaimerIntervalMs);
  log.info(`sync-request claimer running — interval=${syncRequestClaimerIntervalMs}ms`,
  );

  // ── Data-Quality checks (feat-data-quality-engine / Phase 7 — Track A) ──────
  // NOT a new deployable / topic / envelope: interval loops in THIS process (mirrors
  // the sync-request claimer). Per-tick: enumerate active brands → run the 4 deterministic
  // DQ executors (freshness / completeness / schema_validity / reconciliation) under
  // brain_app + per-brand GUC → append one dq_check_result row per (brand, category, target)
  // with a FROZEN letter grade. MUST use brain_app (RLS enforced) — never superuser 'brain'.
  // WIRED HERE: do not remove without updating dq-checks.e2e.test.ts. Tier-0 deterministic.
  const dqPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const dqIntervalMs = cfg.DQ_CHECK_INTERVAL_MS;
  // Silver/Gold serving config over duckdb-serving (Brain V4 — Trino removed, ADR-0014) — when
  // DUCKDB_SERVING_HOST is absent, the Silver-tier checks emit an honest D row (never a false A+).
  const dqServingHost = cfg.DUCKDB_SERVING_HOST;
  const dqSilver =
    dqServingHost !== undefined
      ? {
          baseUrl: `http://${dqServingHost}:${cfg.DUCKDB_SERVING_PORT}`,
        }
      : undefined;
  const dqChecker = startDqChecks(dqPool, { intervalMs: dqIntervalMs, silver: dqSilver });
  log.info(`dq checks running — interval=${dqIntervalMs}ms silver=${dqSilver ? 'on' : 'off'}`,
  );

  // ── Continuous ingestion scheduler (feat-realtime-ingestion-pipeline / §3.3) ──
  // NOT a new deployable / topic / envelope: an interval loop in THIS process,
  // structurally identical to the sync-request claimer above. Every
  // SYNC_SCHEDULER_INTERVAL_MS (default 45s, env-tunable, >=15s floor) it enumerates
  // EVERY connected connector across EVERY brand via the existing SECURITY-DEFINER
  // enumerate fns and dispatches each one's existing repull run() — sequential
  // (rate-limit-safe), per-connector fail-isolated, overlap-safe (run()'s own
  // FOR UPDATE SKIP LOCKED). This is the near-real-time POLLING pipeline (honest:
  // true webhook push needs a public tunnel — see docs/dev/ingestion-in-dev.md).
  // MUST use brain_app (RLS enforced) — never superuser 'brain'. The scheduler holds
  // NO brand GUC; every brand-scoped op happens inside run() under its own GUC (MT-1).
  // WIRED HERE: do not remove without updating ingest-scheduler.e2e.test.ts.
  const ingestSchedulerPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const ingestSchedulerIntervalMs = cfg.SYNC_SCHEDULER_INTERVAL_MS;
  const ingestSchedulerBatch = cfg.REPULL_CLAIM_BATCH;
  // P1: global cross-replica per-provider rate limiter (Redis) — caps shared app-quota providers
  // (Meta/Google) so the parallel work-queue can't storm them across replicas. Fail-open.
  const connectorRateLimiter = new ConnectorRateLimiter(redisUrl);
  await connectorRateLimiter.connect();
  const ingestScheduler = startIngestScheduler(
    ingestSchedulerPool, ingestSchedulerIntervalMs, ingestSchedulerBatch, connectorRateLimiter,
  );
  log.info(`ingest scheduler running — interval=${ingestSchedulerIntervalMs}ms batch=${ingestSchedulerBatch} (work-queue + per-provider rate limit)`,
  );

  // ── Advertising metadata + 2-year backfill schedulers (A2/A3 Transport handoffs) ─────────────
  // In-process periodic loops (same shape as the ingest scheduler). meta-entity-sync / google-entity-sync
  // emit the SHARED `ad.entity.updated` feed on the live collector lane → silver_campaign's authoritative
  // dim; the spend-repull backfill lanes walk back 730 days resumably (reusing the spend.live.v1 event_id
  // so they MERGE-dedup against the trailing 28-day repull — no double-count) and are an instant no-op
  // once the floor is reached. Each job self-enumerates its activated ad connectors via the
  // SECURITY-DEFINER enumerate fns and derives brand_id server-side (MT-1); these schedulers hold NO
  // brand context. Cadences are env-tunable — defaults: entity-sync ~6h, spend backfill daily.
  const adEntitySyncIntervalMs = Number(process.env['AD_ENTITY_SYNC_INTERVAL_MS'] ?? 6 * 60 * 60 * 1000);
  const adSpendBackfillIntervalMs = Number(process.env['AD_SPEND_BACKFILL_INTERVAL_MS'] ?? 24 * 60 * 60 * 1000);
  // Google spend backfill is per-connector (no self-enumerating overload like Meta's): enumerate the
  // activated google_ads connectors under brain_app (RLS FORCE — never superuser 'brain'), then runBackfill()
  // each one fail-isolated. The pool sets NO GUC (enumerate is GUC-less SECURITY DEFINER; each runBackfill
  // sets its own brand GUC internally — MT-1).
  const googleBackfillPool = new PgPool({ connectionString: dbUrl, max: 2 });
  const runGoogleSpendBackfillAll = async (): Promise<void> => {
    const connectors = await enumerateGoogleConnectors(googleBackfillPool);
    for (const c of connectors) {
      try {
        await runGoogleSpendBackfill(c.connector_instance_id);
      } catch (err) {
        log.error(`[periodic:google-spend-backfill] connector=${c.connector_instance_id} failed (non-fatal)`, { err });
      }
    }
  };
  // ── Backfill claimer ───────────────────────────────────────────────────────────────────────────
  // Drains queued jobs.backfill_job rows (the UI "Backfill" button enqueues them). Mirrors the
  // sync-request-claimer: enumerate CONNECTED connectors (SECURITY DEFINER, GUC-less), then for each
  // SHOPIFY connector dispatch shopify-backfill run(ci) — which claimQueued()s (FOR UPDATE SKIP LOCKED,
  // idempotent so it's safe alongside a prod cron) and runs the resumable page loop. Scoped to shopify
  // (the queue-integrated resumable runner) so it never mis-claims a non-shopify connector's job.
  // Without this, dev backfills sit 'queued' forever (the runner was cron-only). Fail-isolated per
  // connector; the loop never dies (startPeriodicJob swallows throws).
  const backfillClaimerPool = new PgPool({ connectionString: dbUrl, max: 2 });
  const backfillClaimerIntervalMs = cfg.BACKFILL_CLAIMER_INTERVAL_MS;
  // Self-heal orphaned 'running' jobs: an in-process backfill that dies mid-run (dev tsx-watch reload,
  // crashed worker/cron pod) leaves the job 'running' with no finalize, and claimQueued only claims
  // 'queued' → stuck forever. Requeue any 'running' job older than this threshold before dispatching.
  // Comfortably longer than a real backfill run so a genuinely-active job is never requeued under itself.
  const backfillStaleRequeueMs = 10 * 60 * 1000;
  const backfillJobRepo = new PgBackfillJobRepository(dbUrl);
  const runBackfillClaim = async (): Promise<void> => {
    const connectors = await enumerateConnectedConnectors(backfillClaimerPool);
    // Drain only providers with a backfill runner (single source of truth shared with the
    // RequestConnectorBackfillCommand reject guard: @brain/connector-core). Two lanes:
    //   - supportsBackfillQueue (shopify) → the BESPOKE shopify paged-backfill runner.
    //   - supportsIngestionBackfill (meta/google_ads/razorpay/shiprocket/ga4/woocommerce) → the
    //     GENERIC resumable ingestion framework (claim + drive every manifest resource + finalize the
    //     backfill_job; woocommerce drives its NON-ORDER resources — orders stay on the sync lane).
    // A connector in neither lane is never claimed (no orphan job mis-claim).
    for (const c of connectors.filter(
      (x) => supportsBackfillQueue(x.provider) || supportsIngestionBackfill(x.provider),
    )) {
      try {
        const requeued = await backfillJobRepo.requeueStaleRunning(
          c.connector_instance_id, c.brand_id, backfillStaleRequeueMs,
        );
        if (requeued > 0) {
          log.warn(`[periodic:backfill-claimer] requeued ${requeued} stale 'running' job(s) for connector=${c.connector_instance_id}`);
        }
        if (supportsBackfillQueue(c.provider)) {
          await runShopifyBackfill(c.connector_instance_id);
        } else {
          await runIngestionBackfillFromQueue(
            c.connector_instance_id,
            c.provider as SupportedProvider,
            c.brand_id,
          );
        }
      } catch (err) {
        log.error(`[periodic:backfill-claimer] connector=${c.connector_instance_id} failed (non-fatal)`, { err });
      }
    }
  };
  const backfillClaimerJob = startPeriodicJob('backfill-claimer', backfillClaimerIntervalMs, runBackfillClaim);
  log.info(`backfill claimer running — interval=${backfillClaimerIntervalMs}ms (drains queued jobs.backfill_job: shopify bespoke + meta/google_ads/razorpay/shiprocket/ga4/woocommerce generic)`);

  const metaEntitySyncJob = startPeriodicJob('meta-entity-sync', adEntitySyncIntervalMs, () => runMetaEntitySync());
  const googleEntitySyncJob = startPeriodicJob('google-entity-sync', adEntitySyncIntervalMs, () => runGoogleEntitySync());
  const metaSpendBackfillJob = startPeriodicJob('meta-spend-backfill', adSpendBackfillIntervalMs, () => runMetaSpendBackfill());
  const googleSpendBackfillJob = startPeriodicJob('google-spend-backfill', adSpendBackfillIntervalMs, runGoogleSpendBackfillAll);
  log.info(`ad-connector schedulers running — entity-sync interval=${adEntitySyncIntervalMs}ms spend-backfill interval=${adSpendBackfillIntervalMs}ms (meta+google)`);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — draining consumers...`);
    // Go not-ready FIRST so the orchestrator stops routing to this instance before we tear
    // consumers down (liveness keeps answering — the process is still alive and draining).
    consumersReady = false;
    await Promise.all([
      erasureOrchestratorConsumer.stop(),
      syncRequestClaimer.stop(),
      backfillClaimerJob.stop(),
      dqChecker.stop(),
      ingestScheduler.stop(),
      // A2/A3 ad-connector schedulers (entity-sync + 2-year spend backfill, meta + google).
      metaEntitySyncJob.stop(),
      googleEntitySyncJob.stop(),
      metaSpendBackfillJob.stop(),
      googleSpendBackfillJob.stop(),
    ]);
    await syncClaimerPool.end();
    await dqPool.end();
    await ingestSchedulerPool.end();
    await googleBackfillPool.end().catch(() => undefined);
    await connectorRateLimiter.quit().catch(() => undefined);
    await capiDeletionRepo.end();
    await erasureRepo.end();
    await retryCounter.quit();
    await auditPool.end();
    await cacheEvictionRedis.quit().catch(() => undefined);
    await opsPool.end().catch(() => undefined);
    await identityRepo.end();
    await healthServer.close();
    // Flush buffered telemetry LAST so shutdown spans/metrics are exported (C1).
    await shutdownObservability().catch(() => { /* ignore */ });
    await closeSentry().catch(() => { /* ignore */ });
    log.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info(`starting — topic=${topic} brokers=${brokers.join(',')} (single Bronze writer = Kafka Connect ADR-0015 WS2; identity in Silver ADR-0015 WS3)`);

  // ── Erasure orchestrator consumer (feat-erasure-orchestrator MANDATORY WIRE) ──────
  // The one remaining live-topic consumer group. Drives the ordered DPDP/PDPL 6-step
  // crypto-shred sequence on a subject-erasure signal. WIRED HERE: do NOT remove without
  // updating erasure-orchestrator.unit.test.ts.
  log.info(`starting erasure orchestrator — topic=${topic} group=${erasureOrchestratorGroupId}`);
  await erasureOrchestratorConsumer.start();
  log.info('erasure orchestrator consumer running');

  // All consumers are up — flip readiness so the orchestrator routes work to this instance.
  consumersReady = true;
  log.info('readiness: ready (erasure consumer + job runner started)');
}

// Run when invoked directly (not imported in tests)
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}
