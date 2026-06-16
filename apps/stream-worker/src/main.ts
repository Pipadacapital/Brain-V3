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
import { RedisDedupAdapter } from './infrastructure/redis/RedisDedupAdapter.js';
import { BronzeRepository } from './infrastructure/pg/BronzeRepository.js';
import { IdentityRepository } from './infrastructure/pg/IdentityRepository.js';
import { SaltProvider, LocalSecretsProvider } from './infrastructure/secrets/SaltProvider.js';
import { ProcessEventUseCase } from './application/ProcessEventUseCase.js';
import { ResolveIdentityUseCase } from './application/ResolveIdentityUseCase.js';
import { CollectorEventConsumer } from './interfaces/consumers/CollectorEventConsumer.js';
import { IdentityBridgeConsumer } from './identity-bridge/IdentityBridgeConsumer.js';

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

  const kafka = new Kafka({
    clientId: 'stream-worker',
    brokers,
    retry: { retries: 5 },
  });

  // ── Bronze pipeline (existing) ──────────────────────────────────────────────
  const dedup = new RedisDedupAdapter(redisUrl);
  const bronze = new BronzeRepository(dbUrl);
  const useCase = new ProcessEventUseCase(dedup, bronze);
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

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[stream-worker] ${signal} received — draining consumers...`);
    await Promise.all([consumer.stop(), identityConsumer.stop()]);
    await dedup.quit();
    await bronze.end();
    await identityRepo.end();
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
}

// Run when invoked directly (not imported in tests)
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((err) => {
    console.error('[stream-worker] fatal', err);
    process.exit(1);
  });
}
