/**
 * AcceptEventUseCase — the ONLY use-case called in the HTTP request handler.
 *
 * D-1 INVARIANT, re-anchored by ADR-0015 (direct-to-log ingest):
 *   1. Stamp received_at (the only pre-produce transform).
 *   2. PRODUCE to the log (idempotent producer, acks=-1) — the produce-ack IS the
 *      durability anchor. On produce failure, APPEND to the bounded local-disk WAL
 *      (fsync'd) — the fallback append is then the durability anchor.
 *   3. Return. HTTP 200 is sent AFTER this function resolves.
 *
 * There is NO validation and NO Apicurio call in this path. The Postgres spool +
 * drainer are DELETED (ADR-0015 D1): canonicalization/dedup live downstream
 * (Connect → Bronze compaction → Silver MERGE).
 *
 * When the WAL is saturated AND the produce fails, FallbackSaturatedError propagates
 * and producer-backpressure maps it to 503 + Retry-After (bounded buffer, shed at cap).
 */
import { stampEnvelope, type IngestEnvelope } from '../domain/ingest/value-objects/envelope.js';
import type { CollectorKafkaProducer, ProduceMessage } from '../infrastructure/kafka-producer.js';
import type { LocalDiskFallback } from '../infrastructure/local-disk-fallback.js';
import { ProduceMicroBatcher, type MicroBatcherConfig } from '../infrastructure/produce-micro-batcher.js';
import { incrementCounter } from '@brain/observability';
import { log } from '../log.js';

export type AcceptDurability = 'produced' | 'fallback';

/** Default micro-batching (M1): 5ms linger / 500-event trigger — INGEST_LINGER_MS overrides. */
const DEFAULT_BATCHING: MicroBatcherConfig = { lingerMs: 5, maxEvents: 500 };

export interface AcceptResult {
  receivedAt: string;
  /** Where the event was durably anchored: log produce-ack, or the disk WAL. */
  durability: AcceptDurability;
}

export interface AcceptManyResult {
  accepted: number;
  receivedAt: string;
  durability: AcceptDurability;
}

/** Project a string field off the raw pre-validation body (null = absent/non-string). */
function stringField(rawBody: Record<string, unknown>, key: string): string | null {
  const v = rawBody[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Serialize the stamped envelope ONCE into the on-log message shape. The payload carries the
 * received_at stamp as `_received_at` — the exact body shape the deleted spool used to drain,
 * so Connect/Silver readers are unchanged.
 */
function toProduceMessage(envelope: IngestEnvelope, requestCorrelationId: string): ProduceMessage {
  const payload = { ...envelope.rawBody, _received_at: envelope.receivedAt };
  return {
    valueText: JSON.stringify(payload),
    brandId: stringField(envelope.rawBody, 'brand_id'),
    eventId: stringField(envelope.rawBody, 'event_id'),
    // Body correlation_id wins (matches the old spool projection); else the request header's.
    correlationId: stringField(envelope.rawBody, 'correlation_id') ?? requestCorrelationId,
  };
}

export class AcceptEventUseCase {
  /**
   * Micro-batcher (M1): coalesces concurrent accepts into one produceBatch through the SAME
   * anchor (produce-or-WAL) path — the ACK contract is unchanged, each request awaits its
   * batch's flush. null when lingerMs=0 (INGEST_LINGER_MS=0 safety valve): every request
   * anchors directly, restoring the one-produce-per-request behavior.
   */
  private readonly batcher: ProduceMicroBatcher<AcceptDurability> | null;

  constructor(
    private readonly producer: CollectorKafkaProducer,
    private readonly fallback: LocalDiskFallback,
    batching: MicroBatcherConfig = DEFAULT_BATCHING,
  ) {
    this.batcher =
      batching.lingerMs === 0 ? null : new ProduceMicroBatcher((m) => this.anchor(m), batching);
  }

  async execute(rawBody: Record<string, unknown>, correlationId: string): Promise<AcceptResult> {
    // Step 1: stamp received_at (the only transformation allowed pre-ACK).
    const envelope = stampEnvelope(rawBody);

    // Step 2: produce-ack or fallback-append — one of them commits before the ACK.
    const durability = await this.coalescedAnchor([toProduceMessage(envelope, correlationId)]);

    return { receivedAt: envelope.receivedAt, durability };
  }

  /**
   * Batch accept (/batch): same ordering, ONE produceBatch (one broker round-trip) — and on
   * produce failure ONE fsync'd WAL append for the whole batch. Atomic at batch granularity:
   * the batch anchors entirely or the request 5xxs entirely (the client re-sends it).
   */
  async executeMany(rawBodies: Record<string, unknown>[], correlationId: string): Promise<AcceptManyResult> {
    const envelopes = rawBodies.map(stampEnvelope);
    const messages = envelopes.map((e) => toProduceMessage(e, correlationId));
    const durability = await this.coalescedAnchor(messages);
    return {
      accepted: envelopes.length,
      receivedAt: envelopes[envelopes.length - 1]?.receivedAt ?? '',
      durability,
    };
  }

  /** Anchor via the micro-batcher when enabled; direct when bypassed (lingerMs=0). */
  private coalescedAnchor(messages: ProduceMessage[]): Promise<AcceptDurability> {
    return this.batcher ? this.batcher.enqueue(messages) : this.anchor(messages);
  }

  /** Produce first; on failure fall back to the disk WAL. Throws FallbackSaturatedError at cap. */
  private async anchor(messages: ProduceMessage[]): Promise<AcceptDurability> {
    try {
      if (!this.producer.isConnected()) {
        // Lazy reconnect on the hot path (bounded by the client's small retry window): the
        // producer may have lost the boot race against a restarting Kafka. Failure here is
        // not fatal — it routes to the WAL below.
        await this.producer.connect();
      }
      await this.producer.produceBatch(messages);
      return 'produced';
    } catch (err) {
      // Log unreachable / produce failed → the WAL append becomes the durability anchor.
      // FallbackSaturatedError from append() propagates → 503 backpressure (bounded buffer).
      log.warn('produce failed — anchoring to local-disk fallback WAL', {
        err,
        batch_size: messages.length,
      });
      await this.fallback.append(messages);
      incrementCounter('collector_fallback_appended_total', {}, messages.length);
      return 'fallback';
    }
  }
}
