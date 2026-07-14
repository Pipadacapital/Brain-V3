/**
 * ErasureEventPublisher (AUD-OPS-036) — the canonical RTBF erasure-trigger bridge.
 *
 * BEFORE: the crypto-shred erasure orchestrator (stream-worker EraseSubjectUseCase, consumer
 *   group on {env}.collector.event.v1) was live but UNREACHABLE — no in-product producer ever
 *   emitted the consent-erasure signal it filters for. A data subject exercising RTBF through
 *   ANY entry point got only the synchronous partial erase (Neo4j tombstone + contact_pii),
 *   never the DEK shred / pii_erasure_log audit row / surrogate brain_id / Gold re-projection /
 *   CAPI (Meta) deletion.
 *
 * NOW: this is the ONE producer module (audit-prescribed) reused by all three RTBF entry points:
 *   1. POST /api/v1/consent/withdraw with reason='erasure'  (compliance consent.routes.ts)
 *   2. POST /api/v1/identity/customer/erase                 (BFF identity.routes.ts)
 *   3. Shopify customers/redact webhook                      (ShopifyWebhookStrategy)
 * Each entry point KEEPS its existing synchronous erase for immediate UX (AUD-OPS-039); the
 * event published here is the completeness guarantee that drives the full ordered sequence.
 *
 * EVENT SHAPE (must satisfy the orchestrator's trigger predicate — EraseSubjectUseCase):
 *   - top-level brand_id + event_id (strings)          → parse guard
 *   - top-level consent_flags (all-false withdrawal)   → extractFlags
 *   - event_name contains 'erasure'                    → isErasure
 *   - properties.email / properties.phone (raw)        → extractSubject → salt-hash → brain_id
 *   - properties.brain_id (already-resolved UUID)      → direct addressing for entry points that
 *     hold no raw identifier (the UI erase route knows only the brain_id; contact_pii is already
 *     hard-deleted by the synchronous path, so the raw subject cannot be re-derived).
 * The same all-false consent_flags event is also (correctly) consumed by the
 * ConsentSuppressorConsumer and CapiDeletionConsumer — an erasure IS a full withdrawal.
 *
 * PII NOTE (deliberate, audit-ratified): the raw subject email/phone rides properties when the
 * entry point holds it — this is the envelope shape the orchestrator (and the CAPI deletion
 * hasher) was DESIGNED to consume; the Bronze copy of this trigger event is itself covered by
 * the payload-path Bronze erasure + raw-lane retention machinery. Never add any OTHER raw PII.
 *
 * INVARIANTS:
 *   - Topic: {env}.collector.event.v1 via buildTopic (SAME live lane the orchestrator's consumer
 *     group reads — NO new topic, NO new deployable).
 *   - Partition key: brand_id (same as the webhook pipeline's collector produce — I-S01).
 *   - Envelope validated against CollectorEventV1Schema before send (never an invalid produce).
 *   - Tenant-first: no brandId (or no subject at all) → log-and-skip, never a tenantless event.
 *   - FAIL-OPEN: a Kafka blip must NOT fail the user-facing erase/withdraw/webhook-ack — the
 *     synchronous partial erase is already durable. Log loudly; the operator can re-issue the
 *     (idempotent) request to re-trigger, and the orchestrator itself is replay-safe (D-4).
 */
import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';
import {
  buildTopic,
  COLLECTOR_EVENT_V1_TOPIC_SUFFIX,
  CollectorEventV1Schema,
} from '@brain/contracts';

/** Minimal logger shape (Fastify's pino instance satisfies this). */
export interface ErasureEventPublisherLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** The three sanctioned RTBF entry points (recorded in properties.source for audit). */
export type ErasureTriggerSource =
  | 'consent.withdraw'
  | 'identity.erase'
  | 'shopify.customers_redact';

export interface ErasureEmit {
  brandId: string;
  /** Which RTBF entry point fired this trigger (audit trail in the event itself). */
  source: ErasureTriggerSource;
  /** Raw subject email — orchestrator salt-hashes it (never stored by this module). */
  subjectEmail?: string;
  /** Raw subject phone — orchestrator salt-hashes it (never stored by this module). */
  subjectPhone?: string;
  /** Already-resolved brain_id — direct addressing when no raw identifier exists. */
  brainId?: string;
  correlationId?: string;
  /** Region code for hash derivation parity (defaults to 'IN' downstream when absent). */
  regionCode?: string;
}

export interface ErasureEventPublisher {
  emitErasureRequested(evt: ErasureEmit): Promise<void>;
}

export interface ErasureEventPublisherDeps {
  producer: Producer;
  /** Kafka env prefix (config.kafkaEnv — e.g. 'dev' / 'prod'). */
  env: string;
  log: ErasureEventPublisherLog;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical erasure-trigger event name — MUST contain 'erasure' (orchestrator predicate). */
export const ERASURE_REQUESTED_EVENT_NAME = 'privacy.erasure.requested' as const;

export function createErasureEventPublisher(deps: ErasureEventPublisherDeps): ErasureEventPublisher {
  const { producer, env, log } = deps;

  return {
    async emitErasureRequested(evt: ErasureEmit): Promise<void> {
      // Tenant-first guard (I-S01): never emit a tenantless erasure trigger.
      if (!evt.brandId || !UUID_RE.test(evt.brandId)) {
        log.warn(
          { source: evt.source },
          '[core] erasure trigger NOT emitted — missing/invalid brand_id (synchronous erase already durable)',
        );
        return;
      }
      // Addressability guard: without email/phone/brain_id the orchestrator could never
      // resolve the subject — skip (and say so) rather than produce a dead event.
      const brainId = evt.brainId && UUID_RE.test(evt.brainId) ? evt.brainId : undefined;
      const email = evt.subjectEmail?.trim() || undefined;
      const phone = evt.subjectPhone?.trim() || undefined;
      if (!brainId && !email && !phone) {
        log.warn(
          { brand_id: evt.brandId, source: evt.source },
          '[core] erasure trigger NOT emitted — no subject address (email/phone/brain_id)',
        );
        return;
      }

      const correlationId = evt.correlationId ?? 'system';
      const eventId = randomUUID();
      const envelope = {
        schema_version: '1' as const,
        event_id: eventId,
        brand_id: evt.brandId,
        correlation_id: correlationId,
        event_name: ERASURE_REQUESTED_EVENT_NAME,
        occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        // All-false = full consent withdrawal: an erasure request withdraws everything. This is
        // BOTH the orchestrator's extractFlags gate and the correct signal for the suppressor.
        consent_flags: {
          analytics: false,
          marketing: false,
          personalization: false,
          ai_processing: false,
        },
        properties: {
          source: evt.source,
          reason: 'erasure',
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(brainId ? { brain_id: brainId } : {}),
        },
      };

      const parsed = CollectorEventV1Schema.safeParse(envelope);
      if (!parsed.success) {
        log.error(
          { brand_id: evt.brandId, source: evt.source, issues: parsed.error.issues },
          '[core] erasure trigger NOT emitted — envelope failed collector contract validation',
        );
        return;
      }

      const topic = buildTopic(env, COLLECTOR_EVENT_V1_TOPIC_SUFFIX);
      // Region code is not a CollectorEventV1 field but the orchestrator honours a top-level
      // region_code for hash parity — additive to the wire JSON, absent from the Zod contract.
      const wire: Record<string, unknown> = {
        ...parsed.data,
        ...(evt.regionCode ? { region_code: evt.regionCode } : {}),
      };

      const headers: Record<string, string | Buffer> = {
        correlation_id: Buffer.from(correlationId),
        event_name: Buffer.from(ERASURE_REQUESTED_EVENT_NAME),
      };
      injectKafkaTraceContext(headers);

      try {
        await producer.send({
          topic,
          // Partition key: brand_id — matches the webhook pipeline's collector produce.
          messages: [{ key: evt.brandId, value: Buffer.from(JSON.stringify(wire)), headers }],
        });
        // NO raw PII in logs (I-S02): brand_id/event_id/source + presence booleans only.
        log.info(
          {
            topic,
            event_id: eventId,
            brand_id: evt.brandId,
            source: evt.source,
            has_email: Boolean(email),
            has_phone: Boolean(phone),
            brain_id: brainId ?? null,
          },
          '[core] privacy.erasure.requested published (RTBF trigger)',
        );
      } catch (err) {
        // FAIL-OPEN — the synchronous partial erase is already durable; log LOUDLY so the miss
        // is operationally visible (the request is idempotent and can be re-issued to re-emit).
        log.error(
          { topic, brand_id: evt.brandId, source: evt.source, err },
          '[core] privacy.erasure.requested publish FAILED — full RTBF sequence NOT triggered; re-issue the erase/withdraw to retry',
        );
      }
    },
  };
}
