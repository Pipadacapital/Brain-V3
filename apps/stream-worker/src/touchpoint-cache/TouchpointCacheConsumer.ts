// SPEC: A.4
/**
 * TouchpointCacheConsumer — the new consumer group that maintains the real-time touchpoint
 * cache (SPEC: A.4). One group, TWO topics:
 *   - the LIVE collector topic (same topic the Bronze/identity consumers read — a NEW group,
 *     per the A.4 "reuse existing consumer wiring, new group id, same topic") → touchpoint append.
 *   - `{env}.identity.merged.v1` → merge invalidation (union absorbed into survivor, del absorbed).
 *
 * FAIL-SAFE (mirrors AnalyticsCacheInvalidateConsumer): the cache is best-effort (journey APIs
 * fall back to Iceberg), so eviction/write errors NEVER retry or DLQ — they log + commit. A
 * poisoned cache write must not wedge the partition; Redis TTL + the next event are the safety net.
 * autoCommit:false + explicit commit-after-process keeps offset discipline without the DLQ machinery.
 *
 * NO NEW DEPLOYABLE / TOPIC / ENVELOPE (I-E05): an added consumer group inside the existing
 * stream-worker process. Per-brand gated by identity.tp_cache (DEFAULT OFF) inside the service —
 * with no brand opted in this loop is an inert flag-check on every message.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { buildTopic, IDENTITY_MERGED_TOPIC_SUFFIX } from '@brain/contracts';
import { log } from '../log.js';
import { TouchpointCacheService } from './TouchpointCacheService.js';

export class TouchpointCacheConsumer {
  private readonly consumer: Consumer;
  private readonly mergedTopic: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly service: TouchpointCacheService,
    /** The live collector topic (touchpoint content). */
    private readonly collectorTopic: string,
    /** Kafka env prefix ('dev' | 'prod') — selects the identity.merged.v1 topic. */
    private readonly env: string,
    private readonly groupId: string,
  ) {
    this.mergedTopic = buildTopic(this.env, IDENTITY_MERGED_TOPIC_SUFFIX);
    this.consumer = kafka.consumer({ groupId });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [this.collectorTopic, this.mergedTopic],
      fromBeginning: false,
    });

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        const offset = message.offset;
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );

        return context.with(traceCtx, async () => {
          try {
            if (topic === this.mergedTopic) {
              const r = await this.service.handleIdentityMerged(message.value);
              if (r.outcome === 'merged') {
                log.info(
                  `[tp-cache] merged survivor=${r.survivorKey} absorbed=${r.absorbedKey} ` +
                  `partition=${partition} offset=${offset}`,
                );
              } else if (r.outcome === 'invalid') {
                log.warn(`[tp-cache] merge invalid reason=${r.reason} partition=${partition} offset=${offset}`);
              }
            } else {
              const r = await this.service.handleCollectorEvent(message.value);
              if (r.outcome === 'appended') {
                log.debug(
                  `[tp-cache] appended brand=${r.brandId} brain_id=${r.brainId} ` +
                  `partition=${partition} offset=${offset}`,
                );
              } else if (r.outcome === 'invalid') {
                log.warn(`[tp-cache] event invalid reason=${r.reason} partition=${partition} offset=${offset}`);
              }
            }
          } catch (err) {
            // FAIL-SAFE: a cache write/resolve failure is non-fatal — log and STILL commit.
            // Never DLQ or wedge the partition for a best-effort cache (Iceberg is truth).
            log.warn('[tp-cache] processing error (fail-safe — offset will be committed)', {
              topic, partition, offset, err,
            });
          }

          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
        });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
  }
}
