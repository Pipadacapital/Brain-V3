/**
 * KafkaJS producer wrapper — used ONLY by the drainer, never by the HTTP handler.
 *
 * D-1 invariant: Kafka is NOT in the request path.
 * The drainer calls produce(); on Redpanda-down it throws and the drainer
 * leaves spool rows as 'pending' (back-pressure hold — no event is dropped).
 */
import { Kafka, type Producer, type KafkaConfig, CompressionTypes } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';

export interface KafkaProducerConfig {
  brokers: string[];
  clientId: string;
  topic: string;
  sasl?: {
    mechanism: 'plain';
    username: string;
    password: string;
  };
}

export class CollectorKafkaProducer {
  private readonly kafka: Kafka;
  private readonly topic: string;
  private producer: Producer | null = null;

  constructor(config: KafkaProducerConfig) {
    const kafkaConfig: KafkaConfig = {
      clientId: config.clientId,
      brokers: config.brokers,
      retry: {
        retries: 0, // Drainer owns retry; producer must fail fast so drainer can back-pressure
      },
    };

    if (config.sasl) {
      kafkaConfig.sasl = {
        mechanism: config.sasl.mechanism,
        username: config.sasl.username,
        password: config.sasl.password,
      };
    }

    this.kafka = new Kafka(kafkaConfig);
    this.topic = config.topic;
  }

  async connect(): Promise<void> {
    // NOT a broker-idempotent producer: KafkaJS rejects idempotent=true together with
    // retry.retries=0 ("Idempotent producer must allow retries to protect against transient
    // errors"), and retries=0 is the deliberate design here — the drainer owns retry and
    // back-pressure (fail fast → re-drain next tick). The no-event-loss invariant is held by
    // the durable spool, and the idempotency guard is spool-level dedup at the application
    // layer, so broker-level exactly-once is neither needed nor compatible with fail-fast.
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: false,
    });
    await this.producer.connect();
  }

  async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
  }

  /**
   * Produce a single spool entry to the collector topic.
   * key = brand_id:event_id (partition key — brand-routed).
   * On failure throws so the drainer leaves the spool row as 'pending'.
   */
  async produce(rawBody: Record<string, unknown>, correlationId: string): Promise<void> {
    if (!this.producer) {
      throw new Error('[kafka] producer not connected');
    }

    // Extract brand_id and event_id for partition key — these may not exist (pre-validation).
    // Fallback: use the raw body's best-effort values; stream-worker validates them.
    const brandId = typeof rawBody['brand_id'] === 'string' ? rawBody['brand_id'] : 'unknown';
    const eventId = typeof rawBody['event_id'] === 'string' ? rawBody['event_id'] : 'unknown';
    const partitionKey = buildPartitionKey(brandId, eventId);

    await this.producer.send({
      topic: this.topic,
      compression: CompressionTypes.None,
      messages: [
        {
          key: partitionKey,
          value: JSON.stringify(rawBody),
          headers: {
            correlation_id: correlationId,
            source: 'collector-drainer',
          },
        },
      ],
    });
  }

  isConnected(): boolean {
    return this.producer !== null;
  }
}
