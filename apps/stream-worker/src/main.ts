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
import { ProcessEventUseCase } from './application/ProcessEventUseCase.js';
import { CollectorEventConsumer } from './interfaces/consumers/CollectorEventConsumer.js';

export async function main(): Promise<void> {
  const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  // IMPORTANT: must connect as brain_app to enforce RLS (not superuser 'brain')
  const dbUrl =
    process.env['BRAIN_APP_DATABASE_URL'] ??
    'postgres://brain_app:brain_app@localhost:5432/brain';
  const topic = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';
  const groupId = process.env['CONSUMER_GROUP_ID'] ?? 'stream-worker-live';

  const kafka = new Kafka({
    clientId: 'stream-worker',
    brokers,
    retry: { retries: 5 },
  });

  const dedup = new RedisDedupAdapter(redisUrl);
  const bronze = new BronzeRepository(dbUrl);
  const useCase = new ProcessEventUseCase(dedup, bronze);
  const consumer = new CollectorEventConsumer(kafka, useCase, topic, groupId);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[stream-worker] ${signal} received — draining consumer...`);
    await consumer.stop();
    await dedup.quit();
    await bronze.end();
    console.info('[stream-worker] shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.info(`[stream-worker] starting — topic=${topic} group=${groupId} brokers=${brokers.join(',')}`);
  await consumer.start();
  console.info('[stream-worker] consumer running');
}

// Run when invoked directly (not imported in tests)
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((err) => {
    console.error('[stream-worker] fatal', err);
    process.exit(1);
  });
}
