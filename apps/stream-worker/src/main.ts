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
import { Pool } from 'pg';
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
import { LedgerWriter } from './infrastructure/pg/LedgerWriter.js';

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

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[stream-worker] ${signal} received — draining consumers...`);
    await Promise.all([
      consumer.stop(),
      identityConsumer.stop(),
      backfillConsumer.stop(),
      liveLedgerConsumer.stop(),
    ]);
    await dedup.quit();
    await backfillDedup.quit();
    await bronze.end();
    await backfillBronze.end();
    await auditPool.end();
    await identityRepo.end();
    await ledgerWriter.end();
    await liveLedgerWriter.end();
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
}

// Run when invoked directly (not imported in tests)
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((err) => {
    console.error('[stream-worker] fatal', err);
    process.exit(1);
  });
}
