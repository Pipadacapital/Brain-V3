/**
 * DlqProducer — produces failed messages to the DLQ topic (D-7).
 *
 * POST-ADR-0015 ROLE: the streaming Bronze/identity consumers are gone, so this producer's ONE
 * live caller is the ErasureOrchestratorConsumer — the sanctioned consumer group left on the live
 * collector topic. It dead-letters a poison erasure message to `<topic>.dlq`
 * (collector.event.v1.dlq) after MAX_RETRY, and DlqRedriver / jobs/dlq-redrive replays it back to
 * the origin topic. The old `.quarantine` suffix path is RETIRED — parsed-but-failed-gate events
 * quarantine in Silver (silver_collector_event.py → brain_silver.silver_quarantine). Do not remove
 * this class while the erasure lane consumes from Kafka.
 *
 * After MAX_RETRY=5 consecutive write failures for the same (partition, offset),
 * the stream-worker routes the message to the DLQ, then commits the Kafka offset
 * so the consumer group advances. This prevents the consumer from being stuck
 * indefinitely on a poisoned message.
 *
 * DLQ topic: dev.collector.event.v1.dlq (created by kafka-init; 30d retention)
 */
import { Kafka, Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';
import { createIdempotentProducer } from './idempotent-producer.js';

export class DlqProducer {
  private readonly producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    // Idempotent producer (exactly-once Kafka semantics at the broker layer):
    // idempotent=true causes KafkaJS to enforce acks=-1 and maxInFlightRequests=1
    // internally. Prevents duplicate DLQ entries on transient broker retries
    // (no-event-loss invariant — a DLQ double-write is operationally harmful).
    // EoS requires unbounded produce retries; see createIdempotentProducer.
    this.producer = createIdempotentProducer(kafka);
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  /**
   * Send a message to the DLQ topic.
   * The original message value + key + headers are preserved for forensics.
   */
  async send(
    topic: string,
    key: string | null,
    value: Buffer | null,
    errorReason: string,
  ): Promise<void> {
    // OTel trace-context propagation (OBS-1/OBS-2): inject traceparent so a DLQ
    // redrive/inspection resumes the trace across the Kafka boundary.
    const headers: Record<string, Buffer | string> = {
      'x-dlq-reason': Buffer.from(errorReason),
      'x-dlq-original-topic': Buffer.from(topic.replace('.dlq', '')),
      'x-dlq-ts': Buffer.from(new Date().toISOString()),
    };
    injectKafkaTraceContext(headers);
    await this.producer.send({
      topic,
      messages: [
        {
          key: key ?? undefined,
          value,
          headers,
        },
      ],
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }
}
