/**
 * IdentityChangeRecomputeConsumer — KafkaJS consumer for the identity.* event lane.
 *
 * Consumes identity.{merged,suppressed,minted,linked,review_queued}.v1 topics.
 * For every identity.merged or identity.suppressed event it:
 *   (a) Persists a ScopedRecompute request to brain_ops.scoped_recompute_request
 *       (idempotent upsert — PRIMARY KEY table, same request_id on retry = no-op).
 *   (b) Publishes cache.invalidate.v1 for each affected customer-grained Gold mart
 *       so the Analytics Gateway can bust its Redis serving cache immediately.
 *
 * Events that do NOT require a scoped recompute (minted, linked, review_queued) are
 * consumed and committed with outcome='skipped' — no brain_ops write, no publish.
 *
 * SEAM — identity.erased: not yet a live event type in contracts v1. When
 * identity.erased.v1 is added to packages/contracts/src/events/identity.events.v1.ts,
 * add the erased topic to the topics list passed at construction, and add the parsing
 * arm to processMessage. The ScopedRecompute mapper already handles the erased arm.
 *
 * OFFSET DISCIPLINE (D-7):
 *   Commit ONLY after the brain_ops write returns without throwing. The cache.invalidate
 *   publish is FAIL-OPEN (the durable brain_ops write is sufficient for pipeline
 *   correctness). On brain_ops write error: do NOT commit; increment the durable retry
 *   counter; DLQ after MAX_RETRY=5.
 *
 * IDEMPOTENCY:
 *   - request_id is deterministicUuid(brand_id || 'scoped-recompute' || source_event_id).
 *     Re-delivering the same Kafka message → same request_id → brain_ops PK upsert = no-op.
 *   - cache.invalidate event_id is deterministic on (brand_id, mart, causation_event_id)
 *     → the Analytics Gateway dedups on (brand_id, event_id).
 *
 * TENANT ISOLATION: the consumer group is brand-agnostic but every write + publish is
 * keyed by brand_id from the event envelope. No cross-brand data is ever mixed.
 *
 * Mirrors ConsentSuppressorConsumer / CapiDeletionConsumer offset/DLQ discipline exactly.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import {
  IdentityMergedEventSchema,
  IdentitySuppressedEventSchema,
} from '@brain/contracts';
import {
  mapIdentityEventToScopedRecompute,
  type IdentityChangeInput,
  type ScopedRecompute,
} from '../../domain/identity/ScopedRecompute.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

const MAX_RETRY = 5;

// ── Ports (injected at construction — testable without real infrastructure) ────

/**
 * IScopedRecomputeRepository — the port for writing ScopedRecompute requests to ops.scoped_recompute_request.
 * Concrete implementation: PgScopedRecomputeRepository (infrastructure/pg/).
 */
export interface IScopedRecomputeRepository {
  upsert(recompute: ScopedRecompute): Promise<void>;
}

/**
 * ICacheInvalidatePublisher — the port for publishing cache.invalidate.v1 events.
 * Concrete implementation: CacheInvalidatePublisher (infrastructure/kafka/).
 */
export interface ICacheInvalidatePublisher {
  publishForRecompute(recompute: ScopedRecompute, causationEventId: string): Promise<void>;
}

// ── Per-message outcome (mirrors ConsentSuppressorConsumer's result shape) ─────

export type ProcessOutcome =
  | {
      outcome: 'recomputed';
      brandId: string;
      requestId: string;
      martCount: number;
      triggerEvent: string;
    }
  | {
      outcome: 'skipped';
      brandId?: string;
      eventName?: string;
      reason: string;
    }
  | {
      outcome: 'invalid';
      reason: string;
    };

// ── Consumer ───────────────────────────────────────────────────────────────────

export class IdentityChangeRecomputeConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;

  constructor(
    private readonly kafka: Kafka,
    private readonly repository: IScopedRecomputeRepository,
    private readonly publisher: ICacheInvalidatePublisher,
    /** All identity.* topics this consumer subscribes to (env-prefixed, e.g. 'dev.identity.merged.v1'). */
    private readonly topics: string[],
    private readonly groupId: string,
    /** Durable (Redis) retry counter — survives restarts so a poison message reaches the DLQ (T2-8). */
    private readonly retryCounter: IRetryCounter,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.dlqProducer = new DlqProducer(kafka);
  }

  /**
   * Per-message processing logic, extracted from eachMessage for unit-testability.
   *
   * CONTRACT:
   *   - Returns 'recomputed' when a brain_ops write + cache.invalidate publish succeed.
   *   - Returns 'skipped' for event types that don't require a recompute (minted, linked,
   *     review_queued) or when no identity-change fields are present.
   *   - Returns 'invalid' for unparseable / contract-violating messages (→ DLQ path).
   *   - THROWS if the brain_ops write throws (→ consumer retry path, offset not committed).
   *     The cache.invalidate publish error is caught internally (fail-open).
   */
  async processMessage(rawValue: Buffer | null, now: string): Promise<ProcessOutcome> {
    if (!rawValue || rawValue.length === 0) {
      return { outcome: 'invalid', reason: 'null_or_empty_message' };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawValue.toString('utf8'));
    } catch {
      return { outcome: 'invalid', reason: 'json_parse_error' };
    }

    const rec = raw as Record<string, unknown>;
    const eventName = rec['event_name'] as string | undefined;
    const brandId = rec['brand_id'] as string | undefined;

    // ── identity.merged ──────────────────────────────────────────────────────

    if (eventName === 'identity.merged') {
      const parsed = IdentityMergedEventSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          outcome: 'invalid',
          reason: `schema_validation_failed:identity.merged`,
        };
      }
      const { event_id, brand_id, payload } = parsed.data;
      const input: IdentityChangeInput = {
        event_name: 'identity.merged',
        event_id,
        brand_id,
        payload: {
          canonical_brain_id: payload.canonical_brain_id,
          merged_brain_id:    payload.merged_brain_id,
        },
      };
      const recompute = mapIdentityEventToScopedRecompute(input, now);

      // (a) Durable write to brain_ops — FAIL-CLOSED. Throws on error → consumer retries.
      await this.repository.upsert(recompute);

      // (b) Cache invalidation — FAIL-OPEN. Already have the durable write; a Kafka blip
      // here is non-fatal (the scoped Spark recompute will emit gold.rewritten when done).
      try {
        await this.publisher.publishForRecompute(recompute, event_id);
      } catch (err) {
        log.warn('[identity-recompute] cache.invalidate publish failed (non-fatal — brain_ops durable)', {
          brand_id, request_id: recompute.request_id, err,
        });
      }

      return {
        outcome:      'recomputed',
        brandId:      brand_id,
        requestId:    recompute.request_id,
        martCount:    recompute.affected_marts.length,
        triggerEvent: 'identity.merged',
      };
    }

    // ── identity.suppressed ──────────────────────────────────────────────────

    if (eventName === 'identity.suppressed') {
      const parsed = IdentitySuppressedEventSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          outcome: 'invalid',
          reason: `schema_validation_failed:identity.suppressed`,
        };
      }
      const { event_id, brand_id, payload } = parsed.data;
      const input: IdentityChangeInput = {
        event_name: 'identity.suppressed',
        event_id,
        brand_id,
        payload: { brain_id: payload.brain_id },
      };
      const recompute = mapIdentityEventToScopedRecompute(input, now);

      // (a) Durable write — FAIL-CLOSED.
      await this.repository.upsert(recompute);

      // (b) Cache invalidation — FAIL-OPEN.
      try {
        await this.publisher.publishForRecompute(recompute, event_id);
      } catch (err) {
        log.warn('[identity-recompute] cache.invalidate publish failed (non-fatal — brain_ops durable)', {
          brand_id, request_id: recompute.request_id, err,
        });
      }

      return {
        outcome:      'recomputed',
        brandId:      brand_id,
        requestId:    recompute.request_id,
        martCount:    recompute.affected_marts.length,
        triggerEvent: 'identity.suppressed',
      };
    }

    // ── SEAM: identity.erased ────────────────────────────────────────────────
    // NOT YET IMPLEMENTED: identity.erased.v1 does not exist in contracts v1.
    // When identity.erased.v1 is added to packages/contracts/src/events/identity.events.v1.ts:
    //   1. Add its topic to the topics[] passed at construction (in main.ts).
    //   2. Import IdentityErasedEventSchema from @brain/contracts.
    //   3. Add the parsing arm here (identical pattern to suppressed above, event_name: 'identity.erased').
    //   4. The ScopedRecompute mapper already handles the erased arm.
    // Do NOT fake output or return a partial result — the seam must stay clearly marked.
    // if (eventName === 'identity.erased') { /* SEAM */ }

    // ── identity.minted, identity.linked, identity.review_queued ─────────────
    // These events do NOT require a scoped recompute:
    //   minted:        brand-new brain_id — no existing Gold rows to invalidate yet.
    //   linked:        an identifier edge added — the brain_id's Gold rows are still correct.
    //   review_queued: a probable merge queued for human review — not auto-committed.
    // Consume and skip (commit offset without writing or publishing).

    const knownNonRecompute = new Set([
      'identity.minted',
      'identity.linked',
      'identity.review_queued',
    ]);

    return {
      outcome:   'skipped',
      brandId:   brandId,
      eventName: eventName,
      reason:    knownNonRecompute.has(eventName ?? '')
        ? 'not_a_recompute_event'
        : 'unknown_event_name',
    };
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();

    // Subscribe to all identity.* topics in this consumer group.
    for (const topic of this.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

        // Durable retry-counter scope: isolates (groupId, topic, partition, offset).
        // Topic is included because the same partition number exists across all 5 subscribed
        // topics; without the topic in the scope, retries from different topics would collide.
        const retryScope = `${this.groupId}:${topic}`;

        // Resume producer trace context across the Kafka boundary (observability skill).
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );
        const correlationId = message.headers?.['correlation_id']?.toString();
        const msgLog = correlationId ? log.child({ correlation_id: correlationId }) : log;

        return context.with(traceCtx, async () => {
          try {
            const result = await this.processMessage(message.value, now);

            if (result.outcome === 'invalid') {
              // Unparseable / contract-invalid → DLQ immediately (no retry helps).
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                result.reason,
              );
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              await this.retryCounter.reset(retryScope, partition, offset);
              msgLog.info(
                `[identity-recompute] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`,
              );
              return;
            }

            // recomputed | skipped → commit after confirmed write (or correct skip).
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            await this.retryCounter.reset(retryScope, partition, offset);

            if (result.outcome === 'recomputed') {
              msgLog.info(
                `[identity-recompute] recomputed brand=${result.brandId} ` +
                `request_id=${result.requestId} trigger=${result.triggerEvent} ` +
                `marts=${result.martCount} partition=${partition} offset=${offset}`,
              );
            } else {
              msgLog.info(
                `[identity-recompute] skipped event=${result.eventName ?? 'unknown'} ` +
                `brand=${result.brandId ?? 'unknown'} reason=${result.reason} ` +
                `partition=${partition} offset=${offset}`,
              );
            }
          } catch (err) {
            // brain_ops write error — do NOT commit. Increment durable retry counter (T2-8).
            const current = await this.retryCounter.increment(retryScope, partition, offset);

            msgLog.error(
              `[identity-recompute] write error (attempt ${current}/${MAX_RETRY}) ` +
              `partition=${partition} offset=${offset}`,
              { err },
            );

            if (current >= MAX_RETRY) {
              try {
                await this.dlqProducer.send(
                  `${topic}.dlq`,
                  message.key?.toString() ?? null,
                  message.value,
                  `max_retry_exceeded: ${String(err)}`,
                );
                await this.consumer.commitOffsets([
                  { topic, partition, offset: String(Number(offset) + 1) },
                ]);
                await this.retryCounter.reset(retryScope, partition, offset);
                msgLog.warn(`[identity-recompute] DLQ (max retry) partition=${partition} offset=${offset}`);
              } catch (dlqErr) {
                msgLog.error('[identity-recompute] DLQ produce failed — not committing offset', { err: dlqErr });
              }
            }

            if (current < MAX_RETRY) {
              throw err;
            }
          }
        }); // end context.with(traceCtx, ...)
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
