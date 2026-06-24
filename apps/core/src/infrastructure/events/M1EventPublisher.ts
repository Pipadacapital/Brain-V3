/**
 * M1EventPublisher (EV-2) — the real domain-lifecycle event publisher.
 *
 * BEFORE: every emitEvent / emitConnectorEvent call site in main.ts was a log-only stub
 *   (`app.log.info({ event, payload }, '[core] domain event emitted')`). The M1 domain
 *   lifecycle events were never actually placed on the bus.
 *
 * NOW: this publisher produces the versioned M1 events to Kafka via the SAME kafkajs
 *   Producer pattern the webhook pipeline + collector use (producer.send with a partition
 *   key + JSON Buffer value). It reuses the already-connected webhook producer so there is
 *   ONE producer per process (no extra connection).
 *
 * INVARIANTS (mirror packages/contracts/src/events/m1.events.v1.ts):
 *   - Topic: {env}.{suffix} via buildTopic — versioned names (pixel.installed.v1,
 *     connector.connected.v1, brand.created.v1, user.registered.v1, …).
 *   - Partition key: `${brand_id}:${event_id}` (tenant-leading — I-S01).
 *   - Envelope: { schema_version, event_id, brand_id, correlation_id, event_name,
 *     occurred_at, payload } (doc-07 / EventEnvelopeBaseSchema).
 *   - No raw token/secret in any payload (I-S02 / I-S09) — the caller is responsible for
 *     the payload contents; this publisher does not add PII.
 *
 * Behavior preservation: the emit call sites pass `(eventName, payload)` exactly as before.
 *   The publisher maps the dotted event name → versioned topic suffix. An UNKNOWN event name
 *   falls back to the original log-only behavior (no throw) so no existing path regresses.
 */

import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import {
  buildTopic,
  USER_REGISTERED_TOPIC_SUFFIX,
  BRAND_CREATED_TOPIC_SUFFIX,
  CONNECTOR_CONNECTED_TOPIC_SUFFIX,
  PIXEL_INSTALLED_TOPIC_SUFFIX,
} from '@brain/contracts';

/** Minimal logger shape (Fastify's pino instance satisfies this). */
export interface EventPublisherLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** The emit signature every command callback in main.ts already uses. */
export type EmitEvent = (eventName: string, payload: Record<string, unknown>) => Promise<void>;

/**
 * Map dotted domain-event name → versioned M1 topic suffix.
 * Only the names the task scopes (pixel.installed, connector.connected, brand.created,
 * user.registered) are published; others fall through to log-only (no regression).
 */
const EVENT_NAME_TO_TOPIC_SUFFIX: Record<string, string> = {
  'pixel.installed': PIXEL_INSTALLED_TOPIC_SUFFIX,
  'connector.connected': CONNECTOR_CONNECTED_TOPIC_SUFFIX,
  'brand.created': BRAND_CREATED_TOPIC_SUFFIX,
  'user.registered': USER_REGISTERED_TOPIC_SUFFIX,
};

export interface M1EventPublisherDeps {
  producer: Producer;
  /** Kafka env prefix (config.kafkaEnv — e.g. 'dev' / 'prod'). */
  env: string;
  log: EventPublisherLog;
}

/**
 * Build the real emitEvent function. The returned fn is drop-in for the prior log-only
 * stubs: `async (eventName, payload) => { … }`.
 *
 * brand_id resolution: the payload carries the tenant key under one of `brand_id` /
 * `brandId` / `organization_id` (pre-brand events). We never fabricate a tenant key — if
 * none is present we log-and-skip rather than emit a tenantless event (I-S01).
 */
export function createM1EventPublisher(deps: M1EventPublisherDeps): EmitEvent {
  const { producer, env, log } = deps;

  return async (eventName: string, payload: Record<string, unknown>): Promise<void> => {
    const suffix = EVENT_NAME_TO_TOPIC_SUFFIX[eventName];

    // Unknown / out-of-scope event → preserve the original log-only behavior (no throw).
    if (!suffix) {
      log.info({ event: eventName, payload }, '[core] domain event emitted (log-only)');
      return;
    }

    // Tenant key — never fabricated (I-S01). Pre-brand events carry organization_id.
    const brandId =
      (payload['brand_id'] as string | undefined) ??
      (payload['brandId'] as string | undefined) ??
      (payload['organization_id'] as string | undefined);
    if (!brandId) {
      log.warn(
        { event: eventName, payload },
        '[core] domain event NOT emitted — no tenant key (brand_id/organization_id) in payload',
      );
      return;
    }

    const correlationId =
      (payload['correlation_id'] as string | undefined) ??
      (payload['correlationId'] as string | undefined) ??
      'system';

    const eventId = randomUUID();
    const topic = buildTopic(env, suffix);
    const envelope = {
      schema_version: '1' as const,
      event_id: eventId,
      brand_id: brandId,
      correlation_id: correlationId,
      event_name: eventName,
      occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      payload,
    };

    try {
      await producer.send({
        topic,
        messages: [
          {
            // Partition key: brand_id:event_id (tenant-leading — mirrors m1.events.v1 doc).
            key: `${brandId}:${eventId}`,
            value: Buffer.from(JSON.stringify(envelope)),
            headers: {
              correlation_id: Buffer.from(correlationId),
              event_name: Buffer.from(eventName),
            },
          },
        ],
      });
      log.info({ event: eventName, topic, event_id: eventId, brand_id: brandId }, '[core] domain event published');
    } catch (err) {
      // FAIL-OPEN for lifecycle events: a Kafka blip must NOT break the user-facing write
      // (connect / install already committed in PG). Log and continue — the PG SoR is intact.
      log.error(
        { event: eventName, topic, brand_id: brandId, err },
        '[core] domain event publish failed (continuing — PG state is the SoR)',
      );
    }
  };
}
