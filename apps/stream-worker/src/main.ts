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
import { DbAuditWriter, type AuditDbClient } from '@brain/audit';
import { RedisDedupAdapter } from './infrastructure/redis/RedisDedupAdapter.js';
import { RetryCounterAdapter } from './infrastructure/redis/RetryCounterAdapter.js';
import { BronzeRepository } from './infrastructure/pg/BronzeRepository.js';
import { IdentityRepository } from './infrastructure/pg/IdentityRepository.js';
import { SaltProvider, LocalSecretsProvider } from './infrastructure/secrets/SaltProvider.js';
import { resolveSaltHex } from '@brain/identity-core';
import { initObservability, initSentry, createLogger } from '@brain/observability';
import { requireEnvInProd } from '@brain/config';

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
import { CollectorEventConsumer } from './interfaces/consumers/CollectorEventConsumer.js';
import { IdentityBridgeConsumer } from './identity-bridge/IdentityBridgeConsumer.js';
import { ConsentSuppressorConsumer } from './interfaces/consumers/ConsentSuppressorConsumer.js';
import { ProjectConsentUseCase } from './application/ProjectConsentUseCase.js';
import { ConsentRepository } from './infrastructure/pg/ConsentRepository.js';
import { CapiDeletionConsumer } from './interfaces/consumers/CapiDeletionConsumer.js';
import { RequestCapiDeletionUseCase } from './application/RequestCapiDeletionUseCase.js';
import { CapiDeletionRepository } from './infrastructure/pg/CapiDeletionRepository.js';
import { BackfillOrderConsumer } from './interfaces/consumers/BackfillOrderConsumer.js';
import { LiveLedgerBridgeConsumer } from './interfaces/consumers/LiveLedgerBridgeConsumer.js';
import { SettlementLedgerConsumer } from './interfaces/consumers/SettlementLedgerConsumer.js';
import { SpendLedgerConsumer } from './interfaces/consumers/SpendLedgerConsumer.js';
import { GokwikAwbLedgerConsumer } from './interfaces/consumers/GokwikAwbLedgerConsumer.js';
import { LedgerWriter } from './infrastructure/pg/LedgerWriter.js';
import mysql from 'mysql2/promise';
import { createAttributionReversalHook } from '@brain/attribution-writer';
import type { SilverPool } from '@brain/metric-engine';
import { startHealthServer } from './infrastructure/health/HealthServer.js';
import { startSyncRequestClaimer } from './jobs/sync-request-claimer/run.js';
import { startDqChecks } from './jobs/dq/run.js';
import { startIngestScheduler } from './jobs/ingest-scheduler/run.js';

export async function main(): Promise<void> {
  // Real OpenTelemetry export (ADR-009) — gated by OTEL_EXPORTER_OTLP_ENDPOINT (no-op in dev).
  // Keep the flush fns so graceful shutdown can export the final batch before exit (C1).
  const shutdownObservability = await initObservability({ serviceName: 'stream-worker', otlpEndpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] });
  const closeSentry = await initSentry({ serviceName: 'stream-worker' }); // gated by SENTRY_DSN (no-op in dev)

  const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  // IMPORTANT: must connect as brain_app to enforce RLS (not superuser 'brain')
  const dbUrl =
    process.env['BRAIN_APP_DATABASE_URL'] ??
    'postgres://brain_app:brain_app@localhost:5432/brain';
  const topic = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';
  const groupId = process.env['CONSUMER_GROUP_ID'] ?? 'stream-worker-live';
  const identityGroupId = process.env['IDENTITY_CONSUMER_GROUP_ID'] ?? 'identity-bridge-live';
  // Consent-suppressor (feat-d13-consent-cancontact): separate consumer group on the
  // SAME live topic (no new topic, no new deployable — I-E05). Projects the first-class
  // consent_flags envelope field into consent_record + consent_tombstone (the SoR the
  // can_contact() chokepoint queries fail-closed). WIRED HERE: do NOT remove without
  // updating consent-suppressor.e2e.test.ts.
  const consentSuppressorGroupId =
    process.env['CONSENT_SUPPRESSOR_CONSUMER_GROUP_ID'] ?? 'stream-worker-consent-suppressor';
  // CAPI retroactive-deletion (feat-capi-conversion-feedback / Phase 6): a SEPARATE
  // consumer group on the SAME live topic (no new topic, no new deployable — I-E05).
  // On an 'advertising' consent withdrawal/erasure → records a capi_deletion_log request
  // within the DPDP ≤15min withdrawal-propagation SLA. WIRED HERE: do NOT remove without
  // updating capi-deletion.e2e.test.ts.
  const capiDeletionGroupId =
    process.env['CAPI_DELETION_CONSUMER_GROUP_ID'] ?? 'stream-worker-capi-deletion';
  // Live-ledger bridge (ORCH-LV-H1 fix): separate consumer group on the live topic — mirrors
  // IdentityBridgeConsumer pattern. Does NOT double-write Bronze (CollectorEventConsumer handles
  // Bronze). Filters to order.live.v1 events only; routes provisional_recognition / rto_reversal.
  const liveLedgerGroupId = process.env['LIVE_LEDGER_CONSUMER_GROUP_ID'] ?? 'live-ledger-bridge';
  // Settlement ledger bridge (ADR-RZ-6 / MB-4): separate consumer group on the live topic.
  // Filters settlement.live.v1 events; does TWO-HOP JOIN → net-of-fees finalization writes.
  // WIRED HERE (MB-4 NON-NEGOTIABLE) — unwiring triggers durable-rule proposal (occurrence #3).
  const settlementLedgerGroupId =
    process.env['SETTLEMENT_LEDGER_CONSUMER_GROUP_ID'] ?? 'settlement-ledger-bridge';
  // Spend ledger bridge (feat-ad-connectors / ADR-AD-6): separate consumer group on the live
  // topic. Filters spend.live.v1 events; writes ad_spend_ledger (ON CONFLICT DO NOTHING).
  // WIRED HERE (NON-NEGOTIABLE) — unwiring triggers the wired-to-nothing bounce.
  const spendLedgerGroupId =
    process.env['SPEND_LEDGER_CONSUMER_GROUP_ID'] ?? 'spend-ledger-bridge';
  // GoKwik AWB ledger bridge (feat-gokwik-shopflo-connectors / 0030): separate consumer group on
  // the live topic. Filters gokwik.awb_status.v1; terminal RTO → cod_rto_clawback (signed-negative),
  // terminal Delivered → cod_delivery_confirmed. WIRED HERE (NON-NEGOTIABLE) — unwiring is the
  // wired-to-nothing anti-pattern (gokwik-awb-ledger-wiring.e2e.test.ts catches it).
  const gokwikAwbLedgerGroupId =
    process.env['GOKWIK_AWB_LEDGER_CONSUMER_GROUP_ID'] ?? 'gokwik-awb-ledger-bridge';
  // Backfill lane (ADR-BF-7 / D-3): separate topic + group → zero live-lane lag impact
  const backfillTopic = process.env['BACKFILL_TOPIC'] ?? `${(process.env['APP_ENV'] ?? 'dev')}.collector.order.backfill.v1`;
  const backfillGroupId = process.env['BACKFILL_CONSUMER_GROUP_ID'] ?? 'stream-worker-backfill';

  const kafka = new Kafka({
    clientId: 'stream-worker',
    brokers,
    retry: { retries: 5 },
  });

  // ── Audit writer (R3/REC-1: pixel.brand_mismatch) ───────────────────────────
  // audit_log has RLS DISABLED (cross-brand SoR); isolation is the mandatory
  // WHERE brand_id filter inside DbAuditWriter. brain_app holds INSERT+SELECT on it.
  const auditPool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000 });
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
    port: parseInt(process.env['HEALTH_PORT'] ?? '8090', 10),
    isReady: () => consumersReady,
    pingDb: async () => {
      await auditPool.query('SELECT 1');
    },
    log,
  });

  // ── Bronze pipeline (LIVE collector lane — R2/R3 gate ON) ───────────────────
  const dedup = new RedisDedupAdapter(redisUrl);
  const bronze = new BronzeRepository(dbUrl);
  // enforceTenantDerivation defaults TRUE: derive brand_id from install_token, quarantine
  // on unresolved/mismatch/absent-consent; audit writes pixel.brand_mismatch (R2/R3).
  const useCase = new ProcessEventUseCase(dedup, bronze, auditWriter);
  const consumer = new CollectorEventConsumer(kafka, useCase, topic, groupId, retryCounter);

  // ── Identity bridge (D-7: same process, no new deployable) ──────────────────
  // SaltProvider: dev uses LocalSecretsProvider (env var holds 64-hex salt directly).
  // Prod: swap LocalSecretsProvider for AwsSecretsProvider (ARN in env var).
  // saltArnFn maps brand UUID → env var name or AWS Secrets Manager ARN.
  const saltSecrets = new LocalSecretsProvider();
  // Salt resolution: explicit IDENTITY_SALT_<brand> override → else deterministic dev salt
  // (resolveSaltHex, shared with apps/core so the same email hashes identically) → prod path
  // untouched (D-2 guard fires on empty). One resolver, every salt site (§3.1).
  const saltProvider = new SaltProvider(saltSecrets, resolveSaltHex);
  // PII vault DEK provider (P0-C): dev derives a deterministic per-brand DEK; prod unwraps
  // the brand_keyring DEK via AWS KMS. The contact_pii write-population encrypts with this key
  // (the SAME provider apps/core's vault read path uses, via @brain/pii-vault).
  const vaultKeyProvider: VaultKeyProvider =
    process.env['NODE_ENV'] === 'production'
      ? new KmsVaultKeyProvider(new PgPool({ connectionString: dbUrl, max: 2 }), new AwsKmsDecryptAdapter())
      : new DevVaultKeyProvider();
  const identityRepo = new IdentityRepository(dbUrl, vaultKeyProvider);
  const resolveIdentityUseCase = new ResolveIdentityUseCase(saltProvider, identityRepo);
  const identityConsumer = new IdentityBridgeConsumer(
    kafka, resolveIdentityUseCase, topic, identityGroupId,
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
  const capiHasMetaCreds = process.env['META_CAPI_CREDS_WIRED'] === 'true';
  const capiDeletionRepo = new CapiDeletionRepository(dbUrl);
  const requestCapiDeletionUseCase = new RequestCapiDeletionUseCase(
    saltProvider, capiDeletionRepo, capiHasMetaCreds,
  );
  const capiDeletionConsumer = new CapiDeletionConsumer(
    kafka, requestCapiDeletionUseCase, topic, capiDeletionGroupId, retryCounter,
  );

  // ── Backfill lane (ADR-BF-7 / ADR-BF-8 / ADR-BF-9) ────────────────────────
  // Separate topic (backfillTopic) + separate consumer group (backfillGroupId)
  // → structurally impossible to lag the live consumer group (SI-3 / D-3).
  // Bronze write reuses the same ProcessEventUseCase (same code path, different lane).
  // LedgerWriter wires Bronze order.backfill.v1 → provisional_recognition (ADR-BF-9).
  const ledgerWriter = new LedgerWriter(dbUrl);
  const backfillDedup = new RedisDedupAdapter(redisUrl);
  const backfillBronze = new BronzeRepository(dbUrl);
  // Backfill-order lane: enforceTenantDerivation=FALSE — these events carry NO install_token
  // (event_name='order.backfill.v1'); their brand_id is already server-trusted (derived from
  // the authenticated connector). The R2 browser-spoofing gate does not apply (architecture §5).
  const backfillProcessEvent = new ProcessEventUseCase(
    backfillDedup, backfillBronze, undefined, /* enforceTenantDerivation */ false,
  );
  const backfillConsumer = new BackfillOrderConsumer(
    kafka, backfillProcessEvent, ledgerWriter, backfillTopic, backfillGroupId, retryCounter,
  );

  // ── Live-ledger bridge (ORCH-LV-H1 fix) ────────────────────────────────────
  // Separate consumer group (liveLedgerGroupId) on the same live topic as
  // CollectorEventConsumer (topic) and IdentityBridgeConsumer. This mirrors
  // IdentityBridgeConsumer: same topic, independent offset, distinct group.
  // Responsibility: filter order.live.v1 events → routeLiveOrderToLedger
  //   → provisional_recognition (new sale) or rto_reversal (cancelled order).
  // Does NOT touch Bronze (CollectorEventConsumer already writes Bronze).
  // Brand GUC is set inside LiveLedgerBridgeConsumer before every ledger write (E-4).
  const liveLedgerWriter = new LedgerWriter(dbUrl);

  // ── D1: live attribution clawback hook (shared @brain/attribution-writer) ───
  // On a confirmed live rto_reversal, fan out the SAME clawback the hourly reconcile job writes
  // — real-time instead of ≤1h-lagged, no dual-writer. Gated on StarRocks (the writer's Silver
  // seam; same gate as the reconcile job + dq). Absent → the hourly job remains the sole path.
  // The hook is invoked BEST-EFFORT inside the consumer (cannot block the offset commit).
  const attrSrHost = process.env['STARROCKS_HOST'];
  const attributionPool = attrSrHost !== undefined ? new Pool({ connectionString: dbUrl, max: 3 }) : undefined;
  const attributionSrPool =
    attrSrHost !== undefined
      ? mysql.createPool({
          host: attrSrHost,
          port: parseInt(process.env['STARROCKS_PORT'] ?? '9030', 10),
          user: process.env['STARROCKS_ANALYTICS_USER'] ?? 'brain_analytics',
          password: requireEnvInProd('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev'),
          connectionLimit: 3,
        })
      : undefined;
  const liveAttributionHook =
    attributionPool && attributionSrPool
      ? createAttributionReversalHook(attributionPool, attributionSrPool as unknown as SilverPool)
      : undefined;
  log.info(`live attribution clawback hook ${liveAttributionHook ? 'ON' : 'off (no StarRocks; hourly job backstops)'}`);

  const liveLedgerConsumer = new LiveLedgerBridgeConsumer(
    kafka, liveLedgerWriter, topic, liveLedgerGroupId, retryCounter, liveAttributionHook,
  );

  // ── Settlement ledger bridge (ADR-RZ-6 / MB-4 WIRED) ───────────────────────
  // Same live topic (topic) but separate consumer group (settlementLedgerGroupId).
  // Filters settlement.live.v1; does TWO-HOP JOIN + net-of-fees finalization writes.
  // The mapPool reads connector_razorpay_order_map under brain_app + GUC (RLS enforced).
  // MB-4: NOT wiring this is occurrence #3 of the wired-to-nothing anti-pattern.
  // The mandatory e2e wiring test (settlement-ledger-wiring.e2e.test.ts) catches unwiring.
  const settlementMapPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const settlementLedgerWriter = new LedgerWriter(dbUrl);
  const settlementLedgerConsumer = new SettlementLedgerConsumer(
    kafka,
    settlementLedgerWriter,
    settlementMapPool,
    topic,
    settlementLedgerGroupId,
    retryCounter,
  );

  // ── Spend ledger bridge (feat-ad-connectors / ADR-AD-6 WIRED) ──────────────
  // Same live topic, separate consumer group (spendLedgerGroupId). Filters spend.live.v1;
  // writes the append-only ad_spend_ledger fact (ON CONFLICT DO NOTHING — idempotent re-read).
  // Brand GUC is set inside LedgerWriter.writeAdSpend before every INSERT (NN-1 / RLS).
  // WIRED HERE: do NOT remove this block without updating spend-ledger-wiring.e2e.test.ts.
  const spendLedgerWriter = new LedgerWriter(dbUrl);
  const spendLedgerConsumer = new SpendLedgerConsumer(
    kafka,
    spendLedgerWriter,
    topic,
    spendLedgerGroupId,
    retryCounter,
  );

  // ── GoKwik AWB ledger bridge (feat-gokwik-shopflo-connectors / 0030 WIRED) ──
  // Same live topic, separate consumer group (gokwikAwbLedgerGroupId). Filters gokwik.awb_status.v1;
  // terminal RTO → cod_rto_clawback (looks up the recognized CoD amount, writes signed-negative),
  // terminal Delivered → cod_delivery_confirmed. Idempotent restatement via the ledger dedup key.
  // Brand GUC is set inside LedgerWriter before every INSERT (NN-1 / RLS). WIRED HERE: do NOT remove
  // without updating gokwik-awb-ledger-wiring.e2e.test.ts (wired-to-nothing bounce trigger).
  const gokwikAwbLedgerWriter = new LedgerWriter(dbUrl);
  const gokwikAwbLedgerConsumer = new GokwikAwbLedgerConsumer(
    kafka,
    gokwikAwbLedgerWriter,
    topic,
    gokwikAwbLedgerGroupId,
    retryCounter,
  );

  // ── On-demand "Sync now" claimer (feat-connector-sync-now) ──────────────────
  // NOT a new deployable: an interval loop in THIS process. Claims sentinel
  // connector_cursor sync-request rows (written by core POST .../sync) and dispatches
  // the SAME repull run() the scheduler invokes (same code path). run()'s own
  // FOR UPDATE SKIP LOCKED overlap-lock guarantees no double-run. MUST use brain_app
  // (RLS enforced) — never superuser 'brain'. WIRED HERE: do not remove without
  // updating sync-request-claimer.live.test.ts.
  const syncClaimerPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const syncRequestClaimerIntervalMs = parseInt(
    process.env['SYNC_REQUEST_CLAIMER_INTERVAL_MS'] ?? '5000',
    10,
  );
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
  // reconciliation reads Bronze↔StarRocks(silver_order_state) deltas. MUST use brain_app
  // (RLS enforced) — never superuser 'brain'. WIRED HERE: do not remove without updating
  // dq-checks.e2e.test.ts. Tier-0 deterministic (no model; $0/mo).
  const dqPool = new PgPool({ connectionString: dbUrl, max: 3 });
  const dqIntervalMs = parseInt(process.env['DQ_CHECK_INTERVAL_MS'] ?? '300000', 10);
  // Silver (StarRocks) config — when absent, the Silver-tier checks emit an honest D row
  // (never a false A+). Reuses the same brain_analytics SELECT-only credentials as core.
  const dqSilverHost = process.env['STARROCKS_HOST'];
  const dqSilver =
    dqSilverHost !== undefined
      ? {
          host: dqSilverHost,
          port: parseInt(process.env['STARROCKS_PORT'] ?? '9030', 10),
          user: process.env['STARROCKS_ANALYTICS_USER'] ?? 'brain_analytics',
          password: requireEnvInProd('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev'),
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
  const ingestSchedulerIntervalMs = parseInt(
    process.env['SYNC_SCHEDULER_INTERVAL_MS'] ?? '45000',
    10,
  );
  const ingestScheduler = startIngestScheduler(ingestSchedulerPool, ingestSchedulerIntervalMs);
  log.info(`ingest scheduler running — interval=${ingestSchedulerIntervalMs}ms`,
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
      consentSuppressorConsumer.stop(),
      capiDeletionConsumer.stop(),
      backfillConsumer.stop(),
      liveLedgerConsumer.stop(),
      settlementLedgerConsumer.stop(),
      spendLedgerConsumer.stop(),
      gokwikAwbLedgerConsumer.stop(),
      syncRequestClaimer.stop(),
      dqChecker.stop(),
      ingestScheduler.stop(),
    ]);
    await syncClaimerPool.end();
    await dqPool.end();
    await ingestSchedulerPool.end();
    await consentRepo.end();
    await capiDeletionRepo.end();
    await retryCounter.quit();
    await dedup.quit();
    await backfillDedup.quit();
    await bronze.end();
    await backfillBronze.end();
    await auditPool.end();
    await identityRepo.end();
    await ledgerWriter.end();
    await liveLedgerWriter.end();
    if (attributionPool) await attributionPool.end();
    if (attributionSrPool) await attributionSrPool.end();
    await settlementLedgerWriter.end();
    await settlementMapPool.end();
    await spendLedgerWriter.end();
    await gokwikAwbLedgerWriter.end();
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

  // ── Backfill lane consumer (ADR-BF-7 / ADR-BF-8 / ADR-BF-9) ───────────────
  // Separate from live lane: backfillTopic != topic → Redpanda isolation guarantee.
  // stream-worker-backfill consumer group offset lag is independent of stream-worker-live.
  log.info(`starting backfill consumer — topic=${backfillTopic} group=${backfillGroupId}`);
  await backfillConsumer.start();
  log.info('backfill consumer running');

  // ── Live-ledger bridge consumer (ORCH-LV-H1 fix) ────────────────────────────
  // Same live topic (topic) but separate consumer group (liveLedgerGroupId).
  // Filters to order.live.v1; routes provisional_recognition / rto_reversal.
  log.info(`starting live-ledger bridge — topic=${topic} group=${liveLedgerGroupId}`);
  await liveLedgerConsumer.start();
  log.info('live-ledger bridge consumer running');

  // ── Settlement ledger bridge consumer (ADR-RZ-6 / MB-4 MANDATORY WIRE) ──────
  // Same live topic, independent consumer group. Filters settlement.live.v1.
  // TWO-HOP JOIN (MB-1) + net-of-fees finalization (MB-3) + brand-level path (MB-1.4).
  // WIRED HERE: do NOT remove this block without updating settlement-ledger-wiring.e2e.test.ts
  // and filing a durable-rule proposal (wired-to-nothing occurrence #3 trigger).
  log.info(`starting settlement-ledger bridge — topic=${topic} group=${settlementLedgerGroupId}`);
  await settlementLedgerConsumer.start();
  log.info('settlement-ledger bridge consumer running');

  // ── Spend ledger bridge consumer (feat-ad-connectors / ADR-AD-6 MANDATORY WIRE) ──
  // Same live topic, independent consumer group. Filters spend.live.v1.
  // Writes ad_spend_ledger (ON CONFLICT DO NOTHING). WIRED HERE: do NOT remove without
  // updating spend-ledger-wiring.e2e.test.ts (wired-to-nothing bounce trigger).
  log.info(`starting spend-ledger bridge — topic=${topic} group=${spendLedgerGroupId}`);
  await spendLedgerConsumer.start();
  log.info('spend-ledger bridge consumer running');

  // ── GoKwik AWB ledger bridge consumer (feat-gokwik-shopflo-connectors / 0030 MANDATORY WIRE) ──
  // Same live topic, independent consumer group. Filters gokwik.awb_status.v1.
  // terminal RTO → cod_rto_clawback; terminal Delivered → cod_delivery_confirmed.
  // WIRED HERE: do NOT remove without updating gokwik-awb-ledger-wiring.e2e.test.ts.
  log.info(`starting gokwik-awb-ledger bridge — topic=${topic} group=${gokwikAwbLedgerGroupId}`);
  await gokwikAwbLedgerConsumer.start();
  log.info('gokwik-awb-ledger bridge consumer running');

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
