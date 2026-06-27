/**
 * KafkaIdentityEventPublisher — the Kafka ADAPTER for the IdentityEventPublisher port.
 *
 * Produces identity.{minted,linked,merged,suppressed,review_queued}.v1 on the SAME envelope +
 * producer convention as M1EventPublisher (apps/core) and the DLQ/idempotent-producer wiring here:
 *   - Topic:        buildTopic(env, IDENTITY_*_TOPIC_SUFFIX)  → '{env}.identity.{event}.v1'.
 *   - Partition key: brand_id  (tenant-first — identity.* MUST partition by brand_id, I-S01).
 *   - Envelope:     the doc-07 widened envelope (EventEnvelopeBaseSchema) with producer/partition_key/
 *                   source/schema_name/causation_id set; payload is the contract payload.
 *   - event_id:     DETERMINISTIC — uuidFromSha256(brand_id ‖ event_name ‖ dedupeKey ‖ rule_version).
 *                   A replay re-emits the SAME event_id → idempotent (consumers dedup on brand_id+event_id).
 *   - W3C trace:    injectKafkaTraceContext on headers so the consumer resumes this trace.
 *
 * FAIL-OPEN: a Kafka blip must NOT wedge the identity-bridge partition. The graph write already
 * committed (commit-after-write); we log-and-continue on a produce error rather than throw — and
 * because event_id is deterministic, a genuine reprocess re-emits an identical (dedupable) event.
 *
 * Each envelope is validated against IDENTITY_EVENT_SCHEMAS before produce (drift guard); a schema
 * miss is logged and skipped (never a silent malformed wire record), consistent with fail-open.
 */
import type { Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';
import {
  buildTopic,
  IDENTITY_MINTED_TOPIC_SUFFIX,
  IDENTITY_LINKED_TOPIC_SUFFIX,
  IDENTITY_MERGED_TOPIC_SUFFIX,
  IDENTITY_SUPPRESSED_TOPIC_SUFFIX,
  IDENTITY_REVIEW_QUEUED_TOPIC_SUFFIX,
  IDENTITY_EVENT_SCHEMAS,
} from '@brain/contracts';
import { RULE_VERSION } from '../../domain/identity/IdentityResolver.js';
import {
  deterministicUuid,
  type IdentityEventPublisher,
  type IdentityPublishMeta,
  type PreparedIdentityEvent,
} from '../../domain/identity/IdentityEventPublisher.js';

/**
 * Minimal logger shape — the message-first convention of @brain/observability's BrainLogger
 * (createLogger), so the worker's `log` is assignable here. info(msg, fields).
 */
export interface IdentityPublisherLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** event_name → versioned topic suffix (the 5 identity events). */
const SUFFIX_BY_EVENT: Record<PreparedIdentityEvent['eventName'], string> = {
  'identity.minted': IDENTITY_MINTED_TOPIC_SUFFIX,
  'identity.linked': IDENTITY_LINKED_TOPIC_SUFFIX,
  'identity.merged': IDENTITY_MERGED_TOPIC_SUFFIX,
  'identity.suppressed': IDENTITY_SUPPRESSED_TOPIC_SUFFIX,
  'identity.review_queued': IDENTITY_REVIEW_QUEUED_TOPIC_SUFFIX,
};

const PRODUCER_NAME = 'stream-worker';
const SOURCE = 'identity-resolver';

/**
 * Minimal structural view of a Zod schema's `safeParse` — lets us validate against the union of the
 * 5 IDENTITY_EVENT_SCHEMAS values without importing zod (not a direct stream-worker dep) and without
 * a union-of-call-signatures typing problem. Each schema is structurally assignable to this.
 */
type SafeParser = {
  safeParse(data: unknown):
    | { success: true }
    | { success: false; error: { issues: unknown[] } };
};

/**
 * Derive a deterministic UUID event_id from the dedupe key set. Same inputs → same id → replay-safe.
 * Reuses the domain `deterministicUuid` (same v5-like scheme as the resolver's merge_id), folding in
 * the rule version so an event_id is pinned to the rule-set that produced the decision.
 */
export function deterministicEventId(
  brandId: string,
  eventName: string,
  dedupeKey: string,
): string {
  return deterministicUuid(`${brandId}||${eventName}||${dedupeKey}||${RULE_VERSION}`);
}

export class KafkaIdentityEventPublisher implements IdentityEventPublisher {
  /**
   * @param producer  an already-connected (idempotent) KafkaJS producer.
   * @param env       Kafka env prefix ('dev' | 'prod') — the first topic segment.
   * @param log       optional structured logger.
   */
  constructor(
    private readonly producer: Producer,
    private readonly env: string,
    private readonly log?: IdentityPublisherLog,
  ) {}

  async publish(
    brandId: string,
    events: PreparedIdentityEvent[],
    meta?: IdentityPublishMeta,
  ): Promise<void> {
    for (const evt of events) {
      const suffix = SUFFIX_BY_EVENT[evt.eventName];
      const topic = buildTopic(this.env, suffix);
      const eventId = deterministicEventId(brandId, evt.eventName, evt.dedupeKey);
      const correlationId = meta?.correlationId ?? 'system';

      const envelope = {
        schema_version: '1' as const,
        event_id: eventId,
        brand_id: brandId,
        correlation_id: correlationId,
        event_name: evt.eventName,
        occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        producer: PRODUCER_NAME,
        partition_key: brandId, // tenant-first — identity.* partitions by brand_id (I-S01).
        causation_id: meta?.causationId ?? null,
        source: SOURCE,
        schema_name: evt.eventName,
        payload: evt.payload,
      };

      // Drift guard: the wire record MUST satisfy its contract schema. A miss is logged + skipped
      // (never produce a malformed record), consistent with fail-open.
      const schema: SafeParser = IDENTITY_EVENT_SCHEMAS[evt.eventName];
      const parsed = schema.safeParse(envelope);
      if (!parsed.success) {
        this.log?.error(
          '[identity-publisher] envelope failed contract validation — skipped (not produced)',
          { event: evt.eventName, brand_id: brandId, issues: parsed.error.issues },
        );
        continue;
      }

      const headers: Record<string, string | Buffer> = {
        correlation_id: Buffer.from(correlationId),
        event_name: Buffer.from(evt.eventName),
      };
      injectKafkaTraceContext(headers);

      try {
        await this.producer.send({
          topic,
          messages: [
            {
              key: brandId, // partition key = brand_id (tenant-first).
              value: Buffer.from(JSON.stringify(envelope)),
              headers,
            },
          ],
        });
        this.log?.info(
          '[identity-publisher] identity event published',
          { event: evt.eventName, topic, event_id: eventId, brand_id: brandId },
        );
      } catch (err) {
        // FAIL-OPEN: the graph is already written (commit-after-write). Do NOT throw — a Kafka blip
        // must not force the consumer to reprocess. event_id is deterministic, so a real reprocess
        // re-emits an identical, dedupable record.
        this.log?.error(
          '[identity-publisher] publish failed (continuing — graph SoR is intact, event_id is deterministic)',
          { event: evt.eventName, topic, brand_id: brandId, err },
        );
      }
    }
  }
}
