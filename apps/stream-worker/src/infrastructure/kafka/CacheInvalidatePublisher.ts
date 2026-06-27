/**
 * CacheInvalidatePublisher — Kafka adapter that publishes cache.invalidate.v1 events
 * on the intelligence.cache.invalidate.v1 lane, one event per affected Gold mart.
 *
 * Invoked by IdentityChangeRecomputeConsumer AFTER the durable ops write so the
 * Analytics Gateway can immediately bust its Redis serving cache for the affected brand
 * + mart without waiting for the next Spark Gold recompute cycle.
 *
 * FAIL-OPEN: the ops write (the durable side of this pipeline) has already
 * succeeded before this publisher is called. A Kafka blip on the cache.invalidate
 * publish is non-fatal — the Spark scoped-recompute job will eventually recompute the
 * Gold mart and emit gold.rewritten.v1, which the Analytics Gateway also consumes to
 * bust the cache. The consumer catches publish errors and logs (does not re-throw).
 *
 * IDEMPOTENCY: each event carries a deterministic event_id keyed on
 * (brand_id, mart_name, source_event_id) so a retry re-emits the identical event_id
 * → downstream gateway dedups on (brand_id, event_id).
 *
 * PARTITION KEY: brand_id — tenant-first (I-S01). Every cache key referenced in the
 * event is brand-scoped; the Analytics Gateway MUST prefix/derive Redis keys with
 * brand_id before touching its cache (cross-tenant bust = P0 isolation breach).
 *
 * REASON: 'gold_rewritten' — the Gold mart rows for the affected brain_ids will be
 * rewritten by the scoped Spark recompute job triggered by this pipeline.
 */
import { createHash } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';
import {
  buildTopic,
  CACHE_INVALIDATE_V1_TOPIC_SUFFIX,
  CACHE_INVALIDATE_V1_EVENT_NAME,
  CacheInvalidateEventSchema,
} from '@brain/contracts';
import type { ScopedRecompute } from '../../domain/identity/ScopedRecompute.js';

export interface CacheInvalidatePublisherLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const PRODUCER_NAME = 'stream-worker';
const SOURCE = 'identity-change-recompute';

/** Deterministic UUID (v5-like SHA-256) — same scheme as identity publisher. */
function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/**
 * ICacheInvalidatePublisher — the port the consumer depends on. The concrete
 * implementation is this class; tests inject a fake.
 */
export interface ICacheInvalidatePublisher {
  /**
   * Publish one cache.invalidate.v1 per affected mart in the ScopedRecompute.
   * Fail-open: errors are caught by the caller; never re-throw to the consumer retry loop.
   */
  publishForRecompute(recompute: ScopedRecompute, causationEventId: string): Promise<void>;
}

export class CacheInvalidatePublisher implements ICacheInvalidatePublisher {
  /**
   * @param producer  An already-connected (idempotent) KafkaJS producer.
   * @param env       Kafka env prefix ('dev' | 'prod').
   * @param log       Optional structured logger.
   */
  constructor(
    private readonly producer: Producer,
    private readonly env: string,
    private readonly log?: CacheInvalidatePublisherLog,
  ) {}

  async publishForRecompute(recompute: ScopedRecompute, causationEventId: string): Promise<void> {
    const topic = buildTopic(this.env, CACHE_INVALIDATE_V1_TOPIC_SUFFIX);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    // Build one envelope per mart (CacheInvalidatePayloadSchema.gold_product is a single string).
    const envelopes = recompute.affected_marts.map((mart) => {
      const eventId = deterministicUuid(
        `${recompute.brand_id}||cache-invalidate||${mart}||${causationEventId}`,
      );
      return {
        schema_version: '1' as const,
        event_id:        eventId,
        brand_id:        recompute.brand_id,
        correlation_id:  causationEventId,
        event_name:      CACHE_INVALIDATE_V1_EVENT_NAME,
        occurred_at:     now,
        producer:        PRODUCER_NAME,
        partition_key:   recompute.brand_id, // tenant-first (I-S01)
        causation_id:    causationEventId,
        source:          SOURCE,
        schema_name:     CACHE_INVALIDATE_V1_EVENT_NAME,
        payload: {
          gold_product: mart,
          scope: { all: true, keys: [] as string[], key_prefixes: [] as string[] },
          reason: 'gold_rewritten' as const,
        },
      };
    });

    // Drift guard: validate each envelope before produce. Skip malformed (never produce junk).
    const validEnvelopes = envelopes.filter((env) => {
      const result = CacheInvalidateEventSchema.safeParse(env);
      if (!result.success) {
        this.log?.error(
          '[cache-invalidate-publisher] envelope failed contract validation — skipped',
          { mart: env.payload.gold_product, brand_id: env.brand_id, issues: result.error.issues },
        );
        return false;
      }
      return true;
    });

    if (validEnvelopes.length === 0) return;

    // Inject trace context into headers (same for all messages in this batch — they share
    // the same causation so they share the same trace).
    const headers: Record<string, Buffer | string> = {
      correlation_id: Buffer.from(causationEventId),
      event_name:     Buffer.from(CACHE_INVALIDATE_V1_EVENT_NAME),
    };
    injectKafkaTraceContext(headers);

    const messages = validEnvelopes.map((env) => ({
      key:     env.brand_id,
      value:   Buffer.from(JSON.stringify(env)),
      headers,
    }));

    try {
      await this.producer.send({ topic, messages });
      this.log?.info(
        '[cache-invalidate-publisher] cache.invalidate events published',
        {
          topic,
          brand_id:   recompute.brand_id,
          mart_count: messages.length,
          request_id: recompute.request_id,
        },
      );
    } catch (err) {
      // Fail-open: the durable ops write has already succeeded. Log and return;
      // the caller (consumer) wraps this in a try/catch and logs the warn-level outcome.
      this.log?.error(
        '[cache-invalidate-publisher] publish failed (non-fatal — ops write is durable)',
        { topic, brand_id: recompute.brand_id, err },
      );
      throw err; // re-throw so the consumer's fail-open catch block can log at warn level
    }
  }
}
