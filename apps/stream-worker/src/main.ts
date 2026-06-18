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
import { BronzeRepository } from './infrastructure/pg/BronzeRepository.js';
import { IdentityRepository } from './infrastructure/pg/IdentityRepository.js';
import { SaltProvider, LocalSecretsProvider } from './infrastructure/secrets/SaltProvider.js';
import { ProcessEventUseCase } from './application/ProcessEventUseCase.js';
import { ResolveIdentityUseCase } from './application/ResolveIdentityUseCase.js';
import { CollectorEventConsumer } from './interfaces/consumers/CollectorEventConsumer.js';
import { IdentityBridgeConsumer } from './identity-bridge/IdentityBridgeConsumer.js';
import { BackfillOrderConsumer } from './interfaces/consumers/BackfillOrderConsumer.js';
import { LiveLedgerBridgeConsumer } from './interfaces/consumers/LiveLedgerBridgeConsumer.js';
import { SettlementLedgerConsumer } from './interfaces/consumers/SettlementLedgerConsumer.js';
import { SpendLedgerConsumer } from './interfaces/consumers/SpendLedgerConsumer.js';
import { GokwikAwbLedgerConsumer } from './interfaces/consumers/GokwikAwbLedgerConsumer.js';
import { LedgerWriter } from './infrastructure/pg/LedgerWriter.js';
import { startSyncRequestClaimer } from './jobs/sync-request-claimer/run.js';

export async function main(): Promise<void> {
  const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  // IMPORTANT: must connect as brain_app to enforce RLS (not superuser 'brain')
  const dbUrl =
    process.env['BRAIN_APP_DATABASE_URL'] ??
    'postgres://brain_app:brain_app@localhost:5432/brain';
  const topic = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';
  const groupId = process.env['CONSUMER_GROUP_ID'] ?? 'stream-worker-live';
  const identityGroupId = process.env['IDENTITY_CONSUMER_GROUP_ID'] ?? 'identity-bridge-live';
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

  // ── Bronze pipeline (LIVE collector lane — R2/R3 gate ON) ───────────────────
  const dedup = new RedisDedupAdapter(redisUrl);
  const bronze = new BronzeRepository(dbUrl);
  // enforceTenantDerivation defaults TRUE: derive brand_id from install_token, quarantine
  // on unresolved/mismatch/absent-consent; audit writes pixel.brand_mismatch (R2/R3).
  const useCase = new ProcessEventUseCase(dedup, bronze, auditWriter);
  const consumer = new CollectorEventConsumer(kafka, useCase, topic, groupId);

  // ── Identity bridge (D-7: same process, no new deployable) ──────────────────
  // SaltProvider: dev uses LocalSecretsProvider (env var holds 64-hex salt directly).
  // Prod: swap LocalSecretsProvider for AwsSecretsProvider (ARN in env var).
  // saltArnFn maps brand UUID → env var name or AWS Secrets Manager ARN.
  const saltSecrets = new LocalSecretsProvider();
  const saltProvider = new SaltProvider(
    saltSecrets,
    (brandId: string) => {
      // Dev convention: env var IDENTITY_SALT_<BRAND_ID_NO_DASHES_UPPER> = 64-hex
      const envKey = `IDENTITY_SALT_${brandId.replace(/-/g, '').toUpperCase()}`;
      return process.env[envKey] ?? '';
    },
  );
  const identityRepo = new IdentityRepository(dbUrl);
  const resolveIdentityUseCase = new ResolveIdentityUseCase(saltProvider, identityRepo);
  const identityConsumer = new IdentityBridgeConsumer(
    kafka, resolveIdentityUseCase, topic, identityGroupId,
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
    kafka, backfillProcessEvent, ledgerWriter, backfillTopic, backfillGroupId,
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
  const liveLedgerConsumer = new LiveLedgerBridgeConsumer(
    kafka, liveLedgerWriter, topic, liveLedgerGroupId,
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
  console.info(
    `[stream-worker] sync-request claimer running — interval=${syncRequestClaimerIntervalMs}ms`,
  );

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[stream-worker] ${signal} received — draining consumers...`);
    await Promise.all([
      consumer.stop(),
      identityConsumer.stop(),
      backfillConsumer.stop(),
      liveLedgerConsumer.stop(),
      settlementLedgerConsumer.stop(),
      spendLedgerConsumer.stop(),
      gokwikAwbLedgerConsumer.stop(),
      syncRequestClaimer.stop(),
    ]);
    await syncClaimerPool.end();
    await dedup.quit();
    await backfillDedup.quit();
    await bronze.end();
    await backfillBronze.end();
    await auditPool.end();
    await identityRepo.end();
    await ledgerWriter.end();
    await liveLedgerWriter.end();
    await settlementLedgerWriter.end();
    await settlementMapPool.end();
    await spendLedgerWriter.end();
    await gokwikAwbLedgerWriter.end();
    console.info('[stream-worker] shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.info(`[stream-worker] starting — topic=${topic} group=${groupId} brokers=${brokers.join(',')}`);
  await consumer.start();
  console.info('[stream-worker] bronze consumer running');

  console.info(`[stream-worker] starting identity bridge — topic=${topic} group=${identityGroupId}`);
  await identityConsumer.start();
  console.info('[stream-worker] identity bridge consumer running');

  // ── Backfill lane consumer (ADR-BF-7 / ADR-BF-8 / ADR-BF-9) ───────────────
  // Separate from live lane: backfillTopic != topic → Redpanda isolation guarantee.
  // stream-worker-backfill consumer group offset lag is independent of stream-worker-live.
  console.info(`[stream-worker] starting backfill consumer — topic=${backfillTopic} group=${backfillGroupId}`);
  await backfillConsumer.start();
  console.info('[stream-worker] backfill consumer running');

  // ── Live-ledger bridge consumer (ORCH-LV-H1 fix) ────────────────────────────
  // Same live topic (topic) but separate consumer group (liveLedgerGroupId).
  // Filters to order.live.v1; routes provisional_recognition / rto_reversal.
  console.info(`[stream-worker] starting live-ledger bridge — topic=${topic} group=${liveLedgerGroupId}`);
  await liveLedgerConsumer.start();
  console.info('[stream-worker] live-ledger bridge consumer running');

  // ── Settlement ledger bridge consumer (ADR-RZ-6 / MB-4 MANDATORY WIRE) ──────
  // Same live topic, independent consumer group. Filters settlement.live.v1.
  // TWO-HOP JOIN (MB-1) + net-of-fees finalization (MB-3) + brand-level path (MB-1.4).
  // WIRED HERE: do NOT remove this block without updating settlement-ledger-wiring.e2e.test.ts
  // and filing a durable-rule proposal (wired-to-nothing occurrence #3 trigger).
  console.info(`[stream-worker] starting settlement-ledger bridge — topic=${topic} group=${settlementLedgerGroupId}`);
  await settlementLedgerConsumer.start();
  console.info('[stream-worker] settlement-ledger bridge consumer running');

  // ── Spend ledger bridge consumer (feat-ad-connectors / ADR-AD-6 MANDATORY WIRE) ──
  // Same live topic, independent consumer group. Filters spend.live.v1.
  // Writes ad_spend_ledger (ON CONFLICT DO NOTHING). WIRED HERE: do NOT remove without
  // updating spend-ledger-wiring.e2e.test.ts (wired-to-nothing bounce trigger).
  console.info(`[stream-worker] starting spend-ledger bridge — topic=${topic} group=${spendLedgerGroupId}`);
  await spendLedgerConsumer.start();
  console.info('[stream-worker] spend-ledger bridge consumer running');

  // ── GoKwik AWB ledger bridge consumer (feat-gokwik-shopflo-connectors / 0030 MANDATORY WIRE) ──
  // Same live topic, independent consumer group. Filters gokwik.awb_status.v1.
  // terminal RTO → cod_rto_clawback; terminal Delivered → cod_delivery_confirmed.
  // WIRED HERE: do NOT remove without updating gokwik-awb-ledger-wiring.e2e.test.ts.
  console.info(`[stream-worker] starting gokwik-awb-ledger bridge — topic=${topic} group=${gokwikAwbLedgerGroupId}`);
  await gokwikAwbLedgerConsumer.start();
  console.info('[stream-worker] gokwik-awb-ledger bridge consumer running');
}

// Run when invoked directly (not imported in tests)
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((err) => {
    console.error('[stream-worker] fatal', err);
    process.exit(1);
  });
}
