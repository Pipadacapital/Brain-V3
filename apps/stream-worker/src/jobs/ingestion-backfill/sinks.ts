/**
 * sinks.ts — the runtime IEventSink + IDeadLetterSink the ingestion framework composes.
 *
 * The framework kernel (@brain/connector-core) stays free of kafkajs/pg by declaring these as
 * interfaces; this file is the stream-worker's concrete wiring:
 *
 *   - KafkaEventSink   — wraps the EoS idempotent producer. It projects a CanonicalEvent into the
 *     CollectorEventV1 envelope (the Bronze ingest contract) and produces it to the live collector
 *     topic, keyed on (brand_id, event_id) and with OTel trace-context headers. The deterministic
 *     event_id IS the dedup key — the Bronze sink MERGEs on it, so an at-least-once retry is safe.
 *   - PgDeadLetterSink — the terminal safety net. When a delivery exhausts its retries the framework
 *     spools the event here (connectors.connector_dlq_record, migration 0094) WITH its deterministic
 *     event_id, so it is durably retained (never dropped) and replayable. The DLQ address triple is
 *     synthesised from (provider/resource topic, fixed partition, event_id-derived offset) so the
 *     existing forensic store + redrive tooling work unchanged.
 *
 * No-loss contract: if the DLQ spool ITSELF throws, the error propagates so the worker crashes
 * loudly (the upstream source is replayable). We never swallow.
 */

import { createHash } from 'node:crypto';
import type { Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext } from '@brain/observability';
import { CollectorEventV1Schema } from '@brain/contracts';
import type {
  CanonicalEvent,
  IEventSink,
  IDeadLetterSink,
  DeadLetterRecord,
} from '@brain/connector-core';
import { DlqRecordRepository } from '../../infrastructure/pg/DlqRecordRepository.js';
import { log } from '../../log.js';

/**
 * IEventSink over the idempotent Kafka producer. Produces a CanonicalEvent as a CollectorEventV1
 * envelope onto `topic`. MUST throw on a produce failure so the NoLoss retry policy engages.
 */
export class KafkaEventSink implements IEventSink {
  constructor(
    private readonly producer: Producer,
    private readonly topic: string,
    private readonly correlationPrefix: string,
  ) {}

  async deliver(event: CanonicalEvent): Promise<void> {
    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: event.provenance.event_id,
      brand_id: event.provenance.brand_id, // from the connector row (MT-1) — never from a payload
      correlation_id: `${this.correlationPrefix}:${event.provenance.event_id}`,
      event_name: event.event_name,
      occurred_at: event.occurred_at,
      ingested_at: new Date().toISOString(),
      properties: event.properties as Record<string, unknown>,
    });

    const traceHeaders: Record<string, Buffer | string> = {};
    injectKafkaTraceContext(traceHeaders);

    // producer.send throws on failure → deliverWithNoLoss retries, then DLQ-spools (never drops).
    await this.producer.send({
      topic: this.topic,
      messages: [
        {
          key: buildPartitionKey(event.provenance.brand_id, event.provenance.event_id),
          value: Buffer.from(JSON.stringify(envelope)),
          headers: traceHeaders,
        },
      ],
    });
  }
}

/** A synthetic DLQ topic name for framework-spooled events (so the redrive tooling can classify). */
export function frameworkDlqTopic(env: string, provider: string, resource: string): string {
  return `${env}.ingest.${provider}.${resource}.framework.dlq`;
}

/**
 * Derive a stable pseudo-offset from the deterministic event_id so the DlqRecordRepository's
 * (source_topic, partition, kafka_offset) idempotency key dedups a re-spool of the SAME event.
 * (The event never went through real Kafka, so there is no real offset — the event_id is the
 * idempotency identity.)
 */
function pseudoOffsetForEvent(eventId: string): bigint {
  const hex = createHash('sha256').update(eventId).digest('hex').slice(0, 15); // 60 bits — fits BIGINT
  return BigInt(`0x${hex}`);
}

/**
 * IDeadLetterSink over connectors.connector_dlq_record (migration 0094). Spools an undeliverable
 * canonical event with its deterministic event_id. If the persist throws, the error PROPAGATES
 * (the framework crashes loudly rather than lose the event — the source is replayable).
 */
export class PgDeadLetterSink implements IDeadLetterSink {
  constructor(
    private readonly repo: DlqRecordRepository,
    private readonly env: string,
  ) {}

  async spool(record: DeadLetterRecord): Promise<void> {
    const sourceTopic = frameworkDlqTopic(this.env, record.provider, record.resource);
    const offset = pseudoOffsetForEvent(record.eventId);

    log.warn(
      `[ingestion-framework] DLQ spool provider=${record.provider} resource=${record.resource} ` +
        `event_id=${record.eventId} attempts=${record.attempts}`,
    );

    // The canonical event payload is already PII-safe (hashes only) — safe to retain in the DLQ.
    await this.repo.persist({
      brandId: record.brandId,
      sourceTopic,
      partition: 0,
      kafkaOffset: offset,
      provider: record.provider,
      payload: record.event as unknown as Record<string, unknown>,
      errorClass: 'ingestion_delivery_exhausted',
      errorDetail: record.failureReason.slice(0, 500),
    });
  }
}
