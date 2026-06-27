/**
 * Stream-worker (Deployable 2) — KafkaJS live consumer group.
 *
 * Pipeline: consume → Zod validate (M1-local) → Redis dedup → Bronze INSERT
 *   → commit Kafka offset ONLY after write confirmed (D-7).
 *
 * Architecture plan §6 Slice 3 (Track A / data-engineer):
 *   - consume from dev.collector.event.v1
 *   - Redis SET NX EX 604800 dedup (D-3)
 *   - INSERT INTO bronze_events under brain_app + set_config GUC (D-8)
 *   - commit offset ONLY after Bronze write confirmed (D-7)
 *   - DLQ after MAX_RETRY=5 failures per (partition, offset)
 *
 * Connects as brain_app (not brain) so RLS is enforced on bronze_events (F-4).
 * Dev DB connects as superuser 'brain' which BYPASSES RLS — NEVER use
 * DATABASE_URL=postgres://brain@... for this service. Use BRAIN_APP_DATABASE_URL.
 */
import { Kafka } from 'kafkajs';
import { Pool, Pool as PgPool } from 'pg';
import { assertRoleEnforcesRls } from '@brain/db';
import { DbAuditWriter, type AuditDbClient } from '@brain/audit';
import {
  buildTopic,
  IDENTITY_MERGED_TOPIC_SUFFIX,
  IDENTITY_SUPPRESSED_TOPIC_SUFFIX,
} from '@brain/contracts';
import { RedisDedupAdapter } from './infrastructure/redis/RedisDedupAdapter.js';
import { RetryCounterAdapter } from './infrastructure/redis/RetryCounterAdapter.js';
import { BronzeRepository } from './infrastructure/pg/BronzeRepository.js';
import { Neo4jIdentityRepository } from './infrastructure/neo4j/Neo4jIdentityRepository.js';
import { createIdempotentProducer } from './infrastructure/kafka/idempotent-producer.js';
import { KafkaIdentityEventPublisher } from './infrastructure/kafka/KafkaIdentityEventPublisher.js';
import { IdentityChangeRecomputeConsumer } from './interfaces/consumers/IdentityChangeRecomputeConsumer.js';
import { PgScopedRecomputeRepository } from './infrastructure/pg/ScopedRecomputeRepository.js';
import { CacheInvalidatePublisher } from './infrastructure/kafka/CacheInvalidatePublisher.js';
import { AnalyticsCacheInvalidateConsumer } from './interfaces/consumers/AnalyticsCacheInvalidateConsumer.js';
import { Redis } from 'ioredis';
import { createSaltProvider } from './infrastructure/secrets/SaltProvider.js';
import { initObservability, initSentry, createLogger } from '@brain/observability';
import { loadStreamWorkerConfig } from '@brain/config';

/** Structured logger for stream-worker lifecycle/error logs. */
const log = createLogger({ serviceName: 'stream-worker' });
import {
  DevVaultKeyProvider,
  KmsVaultKeyProvider,
  AwsKmsDecryptAdapter,
  type VaultKeyProvider,
} from '@brain/pii-vault';
import { ProcessEventUseCase } from './application/ProcessEventUseCase.js';
import { ResolveIdentityUseCase } from './application/ResolveIdentityUseCase.js';
import { ConfidenceEngine } from './domain/identity/confidence/index.js';
import { createDefaultMatcherRegistry } from './domain/identity/matchers/MatcherRegistry.js';
import { DecisionEngine } from './domain/identity/decisions/DecisionEngine.js';
import { IdentityAuditDecisionLog } from './infrastructure/identity/IdentityAuditDecisionLog.js';
import { CollectorEventConsumer } from './interfaces/consumers/CollectorEventConsumer.js';
import { IdentityBridgeConsumer } from './identity-bridge/IdentityBridgeConsumer.js';
import { ConsentSuppressorConsumer } from './interfaces/consumers/ConsentSuppressorConsumer.js';
import { ProjectConsentUseCase } from './application/ProjectConsentUseCase.js';
import { ConsentRepository } from './infrastructure/pg/ConsentRepository.js';
import { CapiDeletionConsumer } from './interfaces/consumers/CapiDeletionConsumer.js';
import { RequestCapiDeletionUseCase } from './application/RequestCapiDeletionUseCase.js';
import { CapiDeletionRepository } from './infrastructure/pg/CapiDeletionRepository.js';
import { ErasureOrchestratorConsumer } from './interfaces/consumers/ErasureOrchestratorConsumer.js';
import { EraseSubjectUseCase, type IBrainIdLookup } from './application/EraseSubjectUseCase.js';
import { ErasureRepository } from './infrastructure/pg/ErasureRepository.js';
import { BackfillOrderConsumer } from './interfaces/consumers/BackfillOrderConsumer.js';
// MEDALLION REALIGNMENT: ALL PG-ledger write paths are now REMOVED. The revenue recognition ledger
// is built FROM Bronze by dbt (silver_order_recognition → gold_revenue_ledger). Ad spend likewise
// flows spend.live.v1 → Bronze (Iceberg, server-trusted) → silver_marketing_spend. The former
// SpendLedgerConsumer (spend.live.v1 → PG billing.ad_spend_ledger) was a DUAL-WRITE that made PG a
// second, divergent SoR; it is removed so Bronze is the SOLE spend SoR (dedup = deterministic
// event_id MERGE in Bronze — no PG/Bronze count drift). PostgreSQL holds operational state only.
import { BRONZE_BRIDGES, buildBronzeBridges } from './interfaces/consumers/bronzeBridges.js';
import { startHealthServer } from './infrastructure/health/HealthServer.js';
import { startSyncRequestClaimer } from './jobs/sync-request-claimer/run.js';
import { startDqChecks } from './jobs/dq/run.js';
import { startIngestScheduler } from './jobs/ingest-scheduler/run.js';
import { ConnectorRateLimiter } from './infrastructure/redis/ConnectorRateLimiter.js';

export async function main(): Promise<void> {
  // Real OpenTelemetry export (ADR-009) — gated by OTEL_EXPORTER_OTLP_ENDPOINT (no-op in dev).
  // Keep the flush fns so graceful shutdown can export the final batch before exit (C1).
  const cfg = loadStreamWorkerConfig();
  const shutdownObservability = await initObservability({ serviceName: 'stream-worker', otlpEndpoint: cfg.OTEL_EXPORTER_OTLP_ENDPOINT });
  const closeSentry = await initSentry({ serviceName: 'stream-worker' }); // gated by SENTRY_DSN (no-op in dev)

  const brokers = cfg.KAFKA_BROKERS.split(',');
  const redisUrl = cfg.REDIS_URL;
  // IMPORTANT: must connect as brain_app to enforce RLS (not superuser 'brain')
  const dbUrl = cfg.BRAIN_APP_DATABASE_URL;
  const topic = cfg.COLLECTOR_TOPIC;
  const groupId = cfg.CONSUMER_GROUP_ID;
  const identityGroupId = cfg.IDENTITY_CONSUMER_GROUP_ID;
  // Consent-suppressor (feat-d13-consent-cancontact): separate consumer group on the
  // SAME live topic (no new topic, no new deployable — I-E05). Projects the first-class
  // consent_flags envelope field into consent_record + consent_tombstone (the SoR the
  // can_contact() chokepoint queries fail-closed). WIRED HERE: do NOT remove without
  // updating consent-suppressor.e2e.test.ts.
  const consentSuppressorGroupId = cfg.CONSENT_SUPPRESSOR_CONSUMER_GROUP_ID;
  // CAPI retroactive-deletion (feat-capi-conversion-feedback / Phase 6): a SEPARATE
  // consumer group on the SAME live topic (no new topic, no new deployable — I-E05).
  // On an 'advertising' consent withdrawal/erasure → records a capi_deletion_log request
  // within the DPDP ≤15min withdrawal-propagation SLA. WIRED HERE: do NOT remove without
  // updating capi-deletion.e2e.test.ts.
  const capiDeletionGroupId = cfg.CAPI_DELETION_CONSUMER_GROUP_ID;
  // DPDP/PDPL crypto-shred erasure orchestrator: separate consumer group on the live topic.
  // On a subject-erasure: shreds subject DEK (is_active=FALSE) + belt-and-suspenders hard delete
  // + surrogate tombstone + scoped Gold re-projection + CAPI deletion. Ordered, idempotent,
  // DLQ-after-MAX_RETRY. WIRED HERE: do NOT remove without updating erasure-orchestrator.unit.test.ts.
  const erasureOrchestratorGroupId = cfg.ERASURE_ORCHESTRATOR_CONSUMER_GROUP_ID;
  // Live-ledger bridge (ORCH-LV-H1 fix): separate consumer group on the live topic — mirrors
  // IdentityBridgeConsumer pattern. Does NOT double-write Bronze (CollectorEventConsumer handles
  // Bronze). Filters to order.live.v1 events only; routes provisional_recognition / rto_reversal.
  const liveLedgerGroupId = cfg.LIVE_LEDGER_CONSUMER_GROUP_ID;
  // Settlement ledger bridge (ADR-RZ-6 / MB-4): separate consumer group on the live topic.
  // Filters settlement.live.v1 events; does TWO-HOP JOIN → net-of-fees finalization writes.
  // WIRED HERE (MB-4 NON-NEGOTIABLE) — unwiring triggers durable-rule proposal (occurrence #3).
  const settlementLedgerGroupId = cfg.SETTLEMENT_LEDGER_CONSUMER_GROUP_ID;
  // GoKwik AWB ledger bridge (feat-gokwik-shopflo-connectors / 0030): separate consumer group on
  // the live topic. Filters gokwik.awb_status.v1; terminal RTO → cod_rto_clawback (signed-negative),
  // terminal Delivered → cod_delivery_confirmed. WIRED HERE (NON-NEGOTIABLE) — unwiring is the
  // wired-to-nothing anti-pattern (gokwik-awb-ledger-wiring.e2e.test.ts catches it).
  const gokwikAwbLedgerGroupId = cfg.GOKWIK_AWB_LEDGER_CONSUMER_GROUP_ID;
  // Backfill lane (ADR-BF-7 / D-3): separate topic + group → zero live-lane lag impact.
  // BACKFILL_TOPIC default derives from NODE_ENV inside the config loader.
  const backfillTopic = cfg.BACKFILL_TOPIC;
  const backfillGroupId = cfg.BACKFILL_CONSUMER_GROUP_ID;

  const kafka = new Kafka({
    clientId: 'stream-worker',
    brokers,
    retry: { retries: 5 },
  });

  // ── Audit writer (R3/REC-1: pixel.brand_mismatch) ───────────────────────────
  // audit_log has RLS DISABLED (cross-brand SoR); isolation is the mandatory
  // WHERE brand_id filter inside DbAuditWriter. brain_app holds INSERT+SELECT on it.
  const auditPool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000 });
  // P2.3: every worker pool uses dbUrl (must be brain_app, NOBYPASSRLS). Fail closed at startup if
  // it points at the superuser 'brain' — the worker writes Bronze/ledgers/consent under per-brand
  // GUCs and a bypassing role would silently defeat FORCE RLS on those tables (the dev footgun).
  await assertRoleEnforcesRls(auditPool, { label: 'stream-worker pool (dbUrl)' });
  const auditDbClient: AuditDbClient = {
    query: async (sql, params) => {
      const r = await auditPool.query(sql, params);
      return { rows: r.rows as never[], rowCount: r.rowCount };
    },
  };
  const auditWriter = new DbAuditWriter(auditDbClient);

  // ── Durable retry counter (T2-8) ────────────────────────────────────────────
  // ONE shared Redis-backed counter for every consumer. Replaces the per-instance in-memory
  // Maps that reset on restart (a poison message would otherwise retry forever, never reaching
  // the DLQ). Keyed by {groupId}:{topic}:{partition}:{offset} so the consumers sharing the live
  // topic under different groups never collide. Connected once here, quit on shutdown.
  const retryCounter = new RetryCounterAdapter(redisUrl);
  await retryCounter.connect();

  // ── Liveness/readiness probes (T2-10) ───────────────────────────────────────
  // Start the health port BEFORE the consumers so liveness answers during the (slow) boot
  // window — K8s must not restart a pod that is merely still wiring consumers. Readiness
  // stays false (503) until every consumer has started AND Postgres is reachable, so the
  // worker only joins rotation once it can actually do work. pingDb reuses auditPool
  // (brain_app) — a SELECT 1 needs no RLS GUC.
  let consumersReady = false;
  const healthServer = startHealthServer({
    port: cfg.HEALTH_PORT,
    isReady: () => consumersReady,
    pingDb: async () => {
      await auditPool.query('SELECT 1');
    },
    log,
  });

  // ── Bronze pipeline (LIVE collector lane — R2/R3 gate ON) ───────────────────
  const dedup = new RedisDedupAdapter(redisUrl);
  const bronze = new BronzeRepository(dbUrl);
  // Slice 6 (ADR-0002): the PG Bronze write switch — default ENABLED. Set BRONZE_PG_WRITE_ENABLED=false
  // ONLY to retire the PG write (Spark→Iceberg becomes the sole Bronze SoR). Do NOT flip until readers
  // are on Iceberg (Slice 5) AND the Spark writer enforces R2/R3 + quarantine (it does not yet) AND a
  // parity soak is green — see ProcessEventUseCase.pgWriteEnabled.
  // DB-AUDIT C4: PG bronze write is RETIRED — default OFF (opt-in). Spark→Iceberg is the sole Bronze SoR
  // and data_plane.bronze_events is dropped (0070). Set BRONZE_PG_WRITE_ENABLED=true only as a legacy escape.
  const pgWriteEnabled = cfg.BRONZE_PG_WRITE_ENABLED;
  if (!pgWriteEnabled) log.info('PG bronze_events write RETIRED (default) — Iceberg (Spark) is the sole Bronze SoR');
  // enforceTenantDerivation defaults TRUE: derive brand_id from install_token, quarantine
  // on unresolved/mismatch/absent-consent; audit writes pixel.brand_mismatch (R2/R3).
  const useCase = new ProcessEventUseCase(dedup, bronze, auditWriter, true, pgWriteEnabled);
  const consumer = new CollectorEventConsumer(kafka, useCase, topic, groupId, retryCounter);

  // ── Bronze bridges (P0 — restore severed server-trusted-event landings) ──────
  // Shopflo checkout-abandoned + GoKwik RTO-Predict events carry NO install_token; the pixel lane
  // above quarantines them, so they never reached Bronze and their read seams were permanent
  // no_data. These separate consumer groups land them in Bronze with enforceTenantDerivation=FALSE
  // (brand_id is already server-trusted — the webhook/emit derived it from the connector row, MT-1).
  // One shared ProcessEventUseCase + dedup + bronze (stateless). WIRED: do NOT remove without
  // updating the corresponding *-bronze-wiring.e2e.test.ts.
  const bridgeProcessEvent = new ProcessEventUseCase(
    dedup, bronze, undefined, /* enforceTenantDerivation */ false, pgWriteEnabled,
  );
  // Registry-driven Bronze bridges (re-platform Phase B). One EventBronzeBridgeConsumer per entry in
  // BRONZE_BRIDGES (shopflo checkout, gokwik rto-predict, gokwik awb-status, shiprocket shipment,
  // order.live) — each lands a server-trusted event_name into Bronze on its own consumer group
  // (enforceTenantDerivation=false). Built, started, and stopped as ONE array below, so a new
  // connector's Bronze landing is a single registry entry, never three hand-edits (kills the
  // "wired-to-nothing" anti-pattern). See bronzeBridges.ts + bronzeBridges.test.ts.
  const bronzeBridgeConsumers = buildBronzeBridges({
    kafka,
    processEvent: bridgeProcessEvent,
    topic,
    retryCounter,
  });

  // ── Identity bridge (D-7: same process, no new deployable) ──────────────────
  // SaltProvider: dev uses LocalSecretsProvider (env var holds 64-hex salt directly).
  // Prod: swap LocalSecretsProvider for AwsSecretsProvider (ARN in env var).
  // saltArnFn maps brand UUID → env var name or AWS Secrets Manager ARN.
  // Salt resolution: DEV uses the deterministic dev salt (resolveSaltHex, shared with apps/core so the
  // same email hashes identically). PROD reads the per-brand salt from the DB identity-salt store
  // (KMS-unwrapped) — a RUNTIME-created brand has no IDENTITY_SALT env, so the env path can't serve it.
  // One resolver, every salt site (§3.1). D-2 guard still fires on any fetch/length failure.
  const saltProvider = createSaltProvider(dbUrl);
  // PII vault DEK provider (P0-C): dev derives a deterministic per-brand DEK; prod unwraps
  // the brand_keyring DEK via AWS KMS. The contact_pii write-population encrypts with this key
  // (the SAME provider apps/core's vault read path uses, via @brain/pii-vault).
  // intentional raw: NODE_ENV prod-gating selects the secret/KMS code path.
  const vaultKeyProvider: VaultKeyProvider =
    process.env['NODE_ENV'] === 'production'
      ? new KmsVaultKeyProvider(new PgPool({ connectionString: dbUrl, max: 2 }), new AwsKmsDecryptAdapter())
      : new DevVaultKeyProvider();
  // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): Neo4j is the identity SYSTEM-OF-RECORD. The graph
  // (customer / identity_link edges / merge / alias / phone-guard / merge-review) lives in Neo4j; the
  // immutable identity_audit ledger + the encrypted contact_pii vault + the brand phone-guard config
  // stay in PostgreSQL (passed via dbUrl). The pure IdentityResolver runs unchanged (IdentityStore
  // contract). Supersedes ADR-0003 (the retired PG-SoR + Neo4j-dual-write experiment).
  const identityRepo = new Neo4jIdentityRepository(
    cfg.NEO4J_URI,
    cfg.NEO4J_USER,
    cfg.NEO4J_PASSWORD,
    dbUrl,
    vaultKeyProvider,
  );
  try {
    await identityRepo.bootstrap();
    log.info('[identity] Neo4j identity SoR wired (ADR-0004); audit + contact_pii in PG.');
  } catch (err) {
    log.warn(`[identity] Neo4j bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // ── Identity domain-event publisher (identity.{minted,linked,merged,suppressed,review_queued}.v1) ──
  // One idempotent producer for the identity lane (EoS at the broker, no-event-loss). The use-case
  // publishes the outcome AFTER the Neo4j graph write (commit-after-write) with deterministic
  // event_ids → replay-safe. Partition key = brand_id (tenant-first). env prefix mirrors the rest of
  // the worker (NODE_ENV-driven, same scheme as BACKFILL_TOPIC).
  const identityEventEnvPrefix = cfg.NODE_ENV === 'production' ? 'prod' : 'dev';
  const identityEventProducer = createIdempotentProducer(kafka);
  await identityEventProducer.connect();
  const identityEventPublisher = new KafkaIdentityEventPublisher(
    identityEventProducer, identityEventEnvPrefix, log,
  );
  // ── Confidence + decision layer (F1): WIRE the probabilistic review gate into the live path ──
  // ConfidenceEngine aggregates the ENABLED matchers from createDefaultMatcherRegistry (deterministic
  // union-find + the review-gated ProbabilisticMatcher; disabled ML/household/cross-device are never
  // invoked). DecisionEngine maps a sub-exact (probabilistic) verdict to a reversible route_to_review
  // Command; IdentityAuditDecisionLog persists it ADDITIVELY into the identity_audit ledger (it is
  // BOTH the DecisionLogRepository and the EvidenceStore). A weak-signal agreement → route_to_review,
  // NEVER auto-merge (isMergeEligible stays band==='exact'); deterministic strong-key merges are
  // unchanged. All optional + fail-open: a confidence/review failure never loses the graph write.
  const matcherRegistry = createDefaultMatcherRegistry();
  const confidenceEngine = new ConfidenceEngine({ matchers: matcherRegistry.enabled() });
  const decisionEngine = new DecisionEngine();
  const identityDecisionLog = new IdentityAuditDecisionLog(new PgPool({ connectionString: dbUrl, max: 3 }));
  const resolveIdentityUseCase = new ResolveIdentityUseCase(
    saltProvider,
    identityRepo,
    identityEventPublisher,
    {
      confidenceEngine,
      decisionEngine,
      decisionLog: identityDecisionLog,
      evidenceStore: identityDecisionLog,
    },
  );
  // T2-8: pass the shared durable RetryCounterAdapter so identity-bridge retries survive
  // pod restarts and a poison message always reaches the DLQ (mirrors ConsentSuppressor /
  // Backfill / LiveLedger — every consumer that receives retryCounter here).
  const identityConsumer = new IdentityBridgeConsumer(
    kafka, resolveIdentityUseCase, topic, identityGroupId, retryCounter,
  );

  // ── Identity-change → scoped-Gold-recompute consumer (V4 / §H) ──────────────
  // Listens to identity.{merged,suppressed}.v1 — the topics KafkaIdentityEventPublisher
  // emits to. On merge/suppress:
  //   (a) FAIL-CLOSED: upserts a ScopedRecompute row to ops.scoped_recompute_request
  //       (PG ops schema — idempotent on retry via ON CONFLICT (brand_id, request_id) DO UPDATE).
  //   (b) FAIL-OPEN: publishes cache.invalidate.v1 per affected customer-grained Gold mart
  //       so the serving layer can bust its Redis cache immediately.
  // The v4-refresh-loop.sh SCOPED_RECOMPUTE=1 step drains these rows + issues targeted MV
  // SYNC refreshes; step 6 (full mv_* refresh) still runs as a safety net.
  //
  // Shares the SAME identityEventEnvPrefix + identityEventProducer as KafkaIdentityEventPublisher
  // so the consume topics EXACTLY match the produce topics (NODE_ENV-driven prefix).
  //
  // ops pool: pg, the worker's brain_app dbUrl (V4 StarRocks REMOVAL — ops moved to the PG
  // `ops` schema, migration 0116). If PG is unreachable the upsert fails → consumer retries → DLQ
  // after 5 = correct fail-closed.
  const identityRecomputeGroupId = cfg.IDENTITY_CHANGE_RECOMPUTE_CONSUMER_GROUP_ID;
  const opsPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const scopedRecomputeRepo = new PgScopedRecomputeRepository(opsPool);
  // CacheInvalidatePublisher reuses identityEventProducer (already connected, idempotent EoS).
  const cacheInvalidatePublisher = new CacheInvalidatePublisher(
    identityEventProducer, identityEventEnvPrefix, log,
  );
  const identityRecomputeTopics = [
    buildTopic(identityEventEnvPrefix, IDENTITY_MERGED_TOPIC_SUFFIX),
    buildTopic(identityEventEnvPrefix, IDENTITY_SUPPRESSED_TOPIC_SUFFIX),
  ];
  const identityRecomputeConsumer = new IdentityChangeRecomputeConsumer(
    kafka,
    scopedRecomputeRepo,
    cacheInvalidatePublisher,
    identityRecomputeTopics,
    identityRecomputeGroupId,
    retryCounter,
  );

  // ── Analytics cache-invalidation consumer (the CONSUMER side of cache.invalidate.v1) ──
  // The identity-recompute consumer EMITS cache.invalidate.v1 after an identity merge/suppress;
  // this consumer evicts the brand-scoped serving-cache keys so the serving tier never serves
  // stale Gold (no waiting for TTL). A dedicated ioredis client (mirrors RetryCounterAdapter) —
  // ioredis Redis satisfies ICacheEvictionClient structurally (del/scan), all deletes brand-gated.
  const cacheEvictionRedis = new Redis(redisUrl);
  const analyticsCacheInvalidateConsumer = new AnalyticsCacheInvalidateConsumer(
    kafka,
    cacheEvictionRedis,
    identityEventEnvPrefix,
    cfg.ANALYTICS_CACHE_INVALIDATE_CONSUMER_GROUP_ID,
  );

  // ── Consent suppressor (feat-d13-consent-cancontact) ────────────────────────
  // Same live topic, separate consumer group. Reuses the SAME SaltProvider as the
  // identity bridge (one sanctioned per-brand hasher — D-2 hard-crash on salt failure)
  // so a subject's consent_record.subject_hash equals its identity_link.identifier_value.
  // Writes consent_record + consent_tombstone under brain_app + brand GUC (RLS FORCE).
  const consentRepo = new ConsentRepository(dbUrl);
  const projectConsentUseCase = new ProjectConsentUseCase(saltProvider, consentRepo);
  const consentSuppressorConsumer = new ConsentSuppressorConsumer(
    kafka, projectConsentUseCase, topic, consentSuppressorGroupId, retryCounter,
  );

  // ── CAPI retroactive-deletion consumer (feat-capi-conversion-feedback) ───────
  // Same live topic, separate consumer group. Reuses the SAME SaltProvider (the one
  // sanctioned per-brand hasher — D-2 hard-crash on salt failure) so the deletion's
  // subject_hash equals the consent_record / capi_passback_log subject_hash and targets
  // the right prior passbacks. Default-closed: in dev (no Meta creds) the request is
  // recorded as 'would_delete_dev' — NOTHING is sent to Meta. hasMetaCreds is derived
  // from env (false in dev); prod wires the Secrets Manager fetch (platform follow-up).
  const capiHasMetaCreds = cfg.META_CAPI_CREDS_WIRED;
  const capiDeletionRepo = new CapiDeletionRepository(dbUrl);
  const requestCapiDeletionUseCase = new RequestCapiDeletionUseCase(
    saltProvider, capiDeletionRepo, capiHasMetaCreds,
  );
  const capiDeletionConsumer = new CapiDeletionConsumer(
    kafka, requestCapiDeletionUseCase, topic, capiDeletionGroupId, retryCounter,
  );

  // ── Erasure orchestrator (DPDP/PDPL crypto-shred — feat-erasure-orchestrator) ──
  // Same live topic, separate consumer group. Drives the ordered 6-step per-subject erasure
  // sequence: DEK shred (subject_keyring is_active=FALSE) → surrogate tombstone → scoped
  // Gold re-projection → disabled Iceberg compaction seam → CAPI deletion → erasure complete.
  // Reuses the SAME saltProvider, requestCapiDeletionUseCase, and identityRepo as the other
  // consumers on this topic — no new hashing logic, no duplicated CAPI deletion path.
  //
  // brainIdLookup: inline adapter over identityRepo.readState() — returns the first active
  // brain_id linked to the subject hash in the Neo4j graph. Throws on Neo4j down (→ retry).
  // Returns null on not-found (→ 'no_brain_id' skip, WARN logged, no retry).
  const brainIdLookup: IBrainIdLookup = {
    async findBrainId(lookupBrandId, subjectHash, identifierType) {
      // SEC H-1: match on the SUBJECT'S identifier type (email OR phone) — hardcoding 'email'
      // silently dropped phone-only RTBF erasures (acknowledged, never shredded = DPDP failure).
      const state = await identityRepo.readState(lookupBrandId, [
        { type: identifierType, hash: subjectHash },
      ]);
      return state.existingLinks.find((l) => l.is_active)?.brain_id ?? null;
    },
  };
  const erasureRepo = new ErasureRepository(dbUrl);
  const eraseSubjectUseCase = new EraseSubjectUseCase(
    saltProvider,
    erasureRepo,
    brainIdLookup,
    scopedRecomputeRepo,
    requestCapiDeletionUseCase,
    // SEC M-1: evict the hot subject DEK from this process's vault cache the instant it is shredded.
    (b, s) => vaultKeyProvider.invalidate(b, s),
  );
  const erasureOrchestratorConsumer = new ErasureOrchestratorConsumer(
    kafka, eraseSubjectUseCase, topic, erasureOrchestratorGroupId, retryCounter,
  );

  // ── Backfill lane (ADR-BF-7 / ADR-BF-8 / ADR-BF-9) ────────────────────────
  // Separate topic (backfillTopic) + separate consumer group (backfillGroupId)
  // → structurally impossible to lag the live consumer group (SI-3 / D-3).
  // Bronze write reuses the same ProcessEventUseCase (same code path, different lane).
  // MEDALLION REALIGNMENT (Epic 1): the backfill→PG-ledger wire is removed; backfilled orders reach
  // the recognition ledger by landing in Bronze (dbt builds gold_revenue_ledger from there).
  const backfillDedup = new RedisDedupAdapter(redisUrl);
  const backfillBronze = new BronzeRepository(dbUrl);
  // Backfill-order lane: enforceTenantDerivation=FALSE — these events carry NO install_token
  // (event_name='order.backfill.v1'); their brand_id is already server-trusted (derived from
  // the authenticated connector). The R2 browser-spoofing gate does not apply (architecture §5).
  const backfillProcessEvent = new ProcessEventUseCase(
    backfillDedup, backfillBronze, undefined, /* enforceTenantDerivation */ false, pgWriteEnabled,
  );
  const backfillConsumer = new BackfillOrderConsumer(
    kafka, backfillProcessEvent, backfillTopic, backfillGroupId, retryCounter,
  );

  // ── MEDALLION REALIGNMENT (Epic 1 / decision B) ────────────────────────────
  // REMOVED: LiveLedgerBridgeConsumer (provisional/rto), SettlementLedgerConsumer (net-of-fees),
  // GokwikAwb/ShipmentLedgerConsumer (COD delivery/RTO). All were pure PG realized_revenue_ledger
  // writers. The recognition ledger is now built from Bronze by dbt (silver_order_recognition →
  // brain_gold.gold_revenue_ledger). The live attribution clawback hook + live journey-stitch they
  // carried are backstopped by the hourly attribution-reconcile + journey-stitch-from-identity crons.

  // NOTE: the SpendLedgerConsumer (spend.live.v1 → PG billing.ad_spend_ledger) was REMOVED — ad
  // spend is analytical data, so it lands in Bronze (Iceberg) via the server-trusted lane like every
  // other event and is projected to silver_marketing_spend. PG is no longer a spend sink (it was a
  // divergent dual-write); Bronze is the sole SoR and dedups on the deterministic spend event_id.

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
  // with a FROZEN letter grade. The freshness executor is the LIVE freshness-SLA monitor
  // (Phase-7 acceptance). schema_validity REUSES the existing DLQ/quarantine signal;
  // reconciliation reads Bronze↔Trino(mv_silver_order_state) deltas. MUST use brain_app
  // (RLS enforced) — never superuser 'brain'. WIRED HERE: do not remove without updating
  // dq-checks.e2e.test.ts. Tier-0 deterministic (no model; $0/mo).
  const dqPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const dqIntervalMs = cfg.DQ_CHECK_INTERVAL_MS;
  // Silver/Gold serving config over TRINO (Brain V4 — StarRocks removed) — when TRINO_HOST is absent,
  // the Silver-tier checks emit an honest D row (never a false A+).
  const dqTrinoHost = cfg.TRINO_HOST;
  const dqSilver =
    dqTrinoHost !== undefined
      ? {
          baseUrl: `http://${dqTrinoHost}:${cfg.TRINO_PORT}`,
          user: 'brain_core',
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

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — draining consumers...`);
    // Go not-ready FIRST so the orchestrator stops routing to this instance before we tear
    // consumers down (liveness keeps answering — the process is still alive and draining).
    consumersReady = false;
    await Promise.all([
      consumer.stop(),
      identityConsumer.stop(),
      identityRecomputeConsumer.stop(),
      analyticsCacheInvalidateConsumer.stop(),
      consentSuppressorConsumer.stop(),
      capiDeletionConsumer.stop(),
      erasureOrchestratorConsumer.stop(),
      backfillConsumer.stop(),
      // All registry-driven Bronze bridges (incl. live-order, which was previously missing a stop).
      ...bronzeBridgeConsumers.map((c) => c.stop()),
      syncRequestClaimer.stop(),
      dqChecker.stop(),
      ingestScheduler.stop(),
    ]);
    await syncClaimerPool.end();
    await dqPool.end();
    await ingestSchedulerPool.end();
    await connectorRateLimiter.quit().catch(() => undefined);
    await consentRepo.end();
    await capiDeletionRepo.end();
    await erasureRepo.end();
    await retryCounter.quit();
    await dedup.quit();
    await backfillDedup.quit();
    await bronze.end();
    await backfillBronze.end();
    await auditPool.end();
    await identityEventProducer.disconnect().catch(() => undefined);
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

  log.info(`starting — topic=${topic} group=${groupId} brokers=${brokers.join(',')}`);
  await consumer.start();
  log.info('bronze consumer running');

  log.info(`starting identity bridge — topic=${topic} group=${identityGroupId}`);
  await identityConsumer.start();
  log.info('identity bridge consumer running');

  // ── Identity-change recompute consumer (V4 scoped Gold-recompute MANDATORY WIRE) ──
  // Subscribes to the SAME topics KafkaIdentityEventPublisher emits to (same env prefix).
  // Must start AFTER identityEventProducer is connected (it shares the producer for
  // cache.invalidate.v1 publishes). WIRED HERE: do NOT remove without verifying the
  // scoped-recompute-loop integration test and the ops.scoped_recompute_request drain.
  log.info(`starting identity-recompute consumer — topics=${identityRecomputeTopics.join(',')} group=${identityRecomputeGroupId}`);
  await identityRecomputeConsumer.start();

  // Cache-invalidation consumer: evict brand-scoped serving-cache keys on cache.invalidate.v1
  // (the CONSUMER side of what identityRecomputeConsumer emits). Closes LOW-1 — without it,
  // cache.invalidate events are published but never consumed → serving cache stays stale to TTL.
  log.info(`starting analytics cache-invalidate consumer — group=${cfg.ANALYTICS_CACHE_INVALIDATE_CONSUMER_GROUP_ID}`);
  await analyticsCacheInvalidateConsumer.start();
  log.info('identity-recompute consumer running');

  // ── Consent suppressor consumer (feat-d13-consent-cancontact MANDATORY WIRE) ──
  // Same live topic, independent consumer group. Projects consent_flags →
  // consent_record + consent_tombstone (the SoR can_contact() reads fail-closed).
  // WIRED HERE: do NOT remove without updating consent-suppressor.e2e.test.ts.
  log.info(`starting consent suppressor — topic=${topic} group=${consentSuppressorGroupId}`);
  await consentSuppressorConsumer.start();
  log.info('consent suppressor consumer running');

  // ── CAPI retroactive-deletion consumer (feat-capi-conversion-feedback MANDATORY WIRE) ──
  // Same live topic, independent consumer group. On an 'advertising' consent withdrawal/
  // erasure → records a capi_deletion_log request within the DPDP ≤15min SLA. Default-closed
  // (dev: 'would_delete_dev', NOTHING sent). WIRED HERE: do NOT remove without updating
  // capi-deletion.e2e.test.ts.
  log.info(`starting capi-deletion consumer — topic=${topic} group=${capiDeletionGroupId}`);
  await capiDeletionConsumer.start();
  log.info('capi-deletion consumer running');

  // ── Erasure orchestrator consumer (feat-erasure-orchestrator MANDATORY WIRE) ──────
  // Same live topic, independent consumer group. Drives the ordered DPDP/PDPL 6-step
  // crypto-shred sequence on a subject-erasure signal. WIRED HERE: do NOT remove without
  // updating erasure-orchestrator.unit.test.ts.
  log.info(`starting erasure orchestrator — topic=${topic} group=${erasureOrchestratorGroupId}`);
  await erasureOrchestratorConsumer.start();
  log.info('erasure orchestrator consumer running');

  // ── Backfill lane consumer (ADR-BF-7 / ADR-BF-8 / ADR-BF-9) ───────────────
  // Separate from live lane: backfillTopic != topic → Redpanda isolation guarantee.
  // stream-worker-backfill consumer group offset lag is independent of stream-worker-live.
  log.info(`starting backfill consumer — topic=${backfillTopic} group=${backfillGroupId}`);
  await backfillConsumer.start();
  log.info('backfill consumer running');

  // ── MEDALLION REALIGNMENT (Epic 1): live-ledger / settlement / gokwik-awb ledger bridges REMOVED.
  // The recognition ledger is built from Bronze by dbt (recognition-refresh). See the wiring note above.

  // (Spend reaches Bronze via the server-trusted lane in the Spark sink — no PG consumer here.)

  // ── Bronze bridge consumers (registry-driven — re-platform Phase B) ─────────
  // Start every bridge in BRONZE_BRIDGES on its own consumer group. The loop guarantees every
  // registry entry is started (no per-bridge hand-wiring to forget). WIRED: the set is asserted by
  // bronzeBridges.test.ts; the per-source landings are covered by *-bronze-wiring.e2e.test.ts.
  for (let i = 0; i < bronzeBridgeConsumers.length; i++) {
    const def = BRONZE_BRIDGES[i]!;
    // intentional raw: groupIdEnv is a DYNAMIC env-var name from the registry, not a fixed field.
    log.info(`starting bronze bridge ${def.eventName} — topic=${topic} group=${process.env[def.groupIdEnv] ?? def.defaultGroupId}`);
    await bronzeBridgeConsumers[i]!.start();
    log.info(`bronze bridge ${def.eventName} consumer running`);
  }

  // All consumers are up — flip readiness so the orchestrator routes work to this instance.
  consumersReady = true;
  log.info('readiness: ready (all consumers started)');
}

// Run when invoked directly (not imported in tests)
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}
