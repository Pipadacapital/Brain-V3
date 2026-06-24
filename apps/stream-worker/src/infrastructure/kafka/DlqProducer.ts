/**
 * DlqProducer — produces failed messages to the DLQ topic (D-7).
 *
 * After MAX_RETRY=5 consecutive write failures for the same (partition, offset),
 * the stream-worker routes the message to the DLQ, then commits the Kafka offset
 * so the consumer group advances. This prevents the consumer from being stuck
 * indefinitely on a poisoned message.
 *
 * DLQ topic: dev.collector.event.v1.dlq (created by redpanda-init; 30d retention)
 */
import { Kafka, Producer } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';

export class DlqProducer {
  private readonly producer: Producer;
  private connected = false;

  constructor(kafka: Kafka) {
    // Idempotent producer (exactly-once Kafka semantics at the broker layer):
    // idempotent=true causes KafkaJS to enforce acks=-1 and maxInFlightRequests=1
    // internally. Prevents duplicate DLQ entries on transient broker retries
    // (no-event-loss invariant — a DLQ double-write is operationally harmful).
    this.producer = kafka.producer({ idempotent: true });
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
