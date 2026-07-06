/**
 * SPEC: A.2.4 (WA-19, AMD-08) — IdentityEventPublisher (core side).
 *
 * The admin identity mutations that live in apps/core (merge-review resolve, unmerge) are the ONLY
 * identity-lane emissions produced OUTSIDE stream-worker. This publisher puts the ONE new
 * convention-following sibling AMD-08 sanctions — identity.unmerged.v1 — onto the live
 * {env}.identity.*.v1 lane, keyed brand_id (tenant-first, I-S01), reusing the already-connected
 * webhook producer (ONE producer per process — same pattern as M1EventPublisher).
 *
 * Downstream: the IdentityChangeRecomputeConsumer marks {survivor, restored} dirty (mart recompute);
 * the Spark journey re-version job un-reverts the affected brain_ids (batch, off silver_identity_map).
 *
 * INVARIANTS:
 *   - Topic: {env}.identity.unmerged.v1 via buildTopic.
 *   - Partition key: brand_id (identity.* MUST key on brand_id — m1.events doc / AMD-08).
 *   - Payload is validated against IdentityUnmergedPayloadSchema (never a raw-PII field, I-S02).
 *   - FAIL-OPEN: a Kafka blip must NOT fail the user-facing unmerge (the Neo4j split + PG audit are
 *     already committed — the durable SoR is intact). Log and continue; the batch re-version job
 *     still folds the change from silver_identity_map on the next refresh.
 */
import { randomUUID } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';
import {
  buildTopic,
  IDENTITY_UNMERGED_TOPIC_SUFFIX,
  IdentityUnmergedPayloadSchema,
} from '@brain/contracts';

/** Minimal logger shape (Fastify's pino instance satisfies this). */
export interface IdentityEventPublisherLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface UnmergedEmit {
  brandId: string;
  /** The identity split back OUT (former absorbed id restored to independence). */
  restoredBrainId: string;
  /** The surviving canonical the absorbed id had been folded into (AMD-09 survivor). */
  survivorBrainId?: string;
  /** The ORIGINAL merge id this reversal undoes. */
  mergeEventId?: string;
  actor: string;
  reason?: string;
  correlationId?: string;
}

export interface IdentityEventPublisher {
  emitUnmerged(evt: UnmergedEmit): Promise<void>;
}

export interface IdentityEventPublisherDeps {
  producer: Producer;
  /** Kafka env prefix (config.kafkaEnv — e.g. 'dev' / 'prod'). */
  env: string;
  log: IdentityEventPublisherLog;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createIdentityEventPublisher(deps: IdentityEventPublisherDeps): IdentityEventPublisher {
  const { producer, env, log } = deps;

  return {
    async emitUnmerged(evt: UnmergedEmit): Promise<void> {
      // A merge_id/survivor is required by the wire contract; a legacy edge may lack one, in which
      // case the reader already minted a reversal handle. If either is still absent OR malformed we
      // log-and-skip the WIRE event (the durable Neo4j split + PG audit already happened — I-S01: we
      // never emit a tenantless/invalid identity event; the batch re-version still folds the change).
      if (!evt.survivorBrainId || !UUID_RE.test(evt.survivorBrainId) || !evt.mergeEventId || !UUID_RE.test(evt.mergeEventId)) {
        log.warn(
          { brand_id: evt.brandId, restored_brain_id: evt.restoredBrainId },
          '[core] identity.unmerged.v1 NOT emitted — missing/invalid survivor or merge id (split + audit already durable)',
        );
        return;
      }

      const payload = {
        brand_id: evt.brandId,
        merge_id: evt.mergeEventId,
        canonical_brain_id: evt.survivorBrainId,
        restored_brain_id: evt.restoredBrainId,
        rule_version: 'v1-admin-unmerge',
        actor: evt.actor,
        ...(evt.reason ? { reason: evt.reason } : {}),
      };

      const parsed = IdentityUnmergedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        log.warn(
          { brand_id: evt.brandId, issues: parsed.error.issues },
          '[core] identity.unmerged.v1 NOT emitted — payload failed contract validation',
        );
        return;
      }

      const correlationId = evt.correlationId ?? 'system';
      const eventId = randomUUID();
      const topic = buildTopic(env, IDENTITY_UNMERGED_TOPIC_SUFFIX);
      const envelope = {
        schema_version: '1' as const,
        event_id: eventId,
        brand_id: evt.brandId,
        correlation_id: correlationId,
        event_name: 'identity.unmerged',
        occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        // identity.* MUST set partition_key = brand_id (AMD-08 / m1.events doc).
        partition_key: evt.brandId,
        producer: 'core',
        payload: parsed.data,
      };

      const headers: Record<string, string | Buffer> = {
        correlation_id: Buffer.from(correlationId),
        event_name: Buffer.from('identity.unmerged'),
      };
      injectKafkaTraceContext(headers);

      try {
        await producer.send({
          topic,
          messages: [{ key: evt.brandId, value: Buffer.from(JSON.stringify(envelope)), headers }],
        });
        log.info(
          { topic, event_id: eventId, brand_id: evt.brandId, restored_brain_id: evt.restoredBrainId, survivor_brain_id: evt.survivorBrainId },
          '[core] identity.unmerged.v1 published',
        );
      } catch (err) {
        // FAIL-OPEN — the durable SoR (Neo4j split + PG audit) is intact; the batch re-version folds it.
        log.error(
          { topic, brand_id: evt.brandId, err },
          '[core] identity.unmerged.v1 publish failed (continuing — Neo4j/PG state is the SoR)',
        );
      }
    },
  };
}
