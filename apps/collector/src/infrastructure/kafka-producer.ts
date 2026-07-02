/**
 * KafkaJS producer wrapper — used ONLY by the drainer, never by the HTTP handler.
 *
 * D-1 invariant: Kafka is NOT in the request path.
 * The drainer calls produce(); on Redpanda-down it throws and the drainer
 * leaves spool rows as 'pending' (back-pressure hold — no event is dropped).
 */
import { Kafka, type Producer, type KafkaConfig, type Message, CompressionTypes } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext } from '@brain/observability';

/**
 * One spool entry headed for the collector topic (built by the drainer).
 * The value is the canonical jsonb TEXT straight from the spool (AUD-PERF-012) — sent verbatim,
 * never re-stringified; brand/event ids arrive as SQL projections (null = absent/non-string).
 */
export interface DrainMessage {
  valueText: string;
  brandId: string | null;
  eventId: string | null;
  correlationId: string;
}

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

/**
 * Extract the TOP-LEVEL event_name from the spool's canonical jsonb text (AUD-PERF-005).
 * Returns null when the body is unparseable or event_name is absent/non-string — the
 * header is then simply omitted (downstream bridges fall back to body parse).
 */
function extractTopLevelEventName(valueText: string): string | null {
  try {
    const parsed = JSON.parse(valueText) as Record<string, unknown>;
    const name = parsed?.['event_name'];
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  }
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
   * Produce a whole claimed batch in ONE producer.send (AUD-PERF-002) — kafkajs groups the
   * messages per partition natively, so a 100-row drain tick is one broker round-trip instead
   * of 100. GZIP is codec-transparent to every consumer (broker + kafkajs + Spark decode it).
   * Failure granularity is the batch: on throw the drainer leaves ALL claimed rows 'pending'
   * (at-least-once; downstream event_id dedup absorbs any partial-produce replay).
   */
  async produceBatch(batch: DrainMessage[]): Promise<void> {
    if (!this.producer) {
      throw new Error('[kafka] producer not connected');
    }
    if (batch.length === 0) return;

    const messages: Message[] = batch.map(({ valueText, brandId, eventId, correlationId }) => {
      // key = brand_id:event_id (partition key — brand-routed). The ids may not exist yet
      // (pre-validation): null falls back to 'unknown'; stream-worker validates downstream.
      const partitionKey = buildPartitionKey(brandId ?? 'unknown', eventId ?? 'unknown');

      // OTel W3C trace-context propagation across the Kafka boundary (OBS-1/OBS-2):
      // inject traceparent/tracestate so the stream-worker consumer resumes this trace
      // instead of starting an orphan root span. Carried alongside correlation_id.
      const headers: Record<string, string> = {
        correlation_id: correlationId,
        source: 'collector-drainer',
      };
      // AUD-PERF-005: stamp event_name (and brand_id when projected) as Kafka headers so the
      // 13 Bronze-bridge consumer groups on this shared topic can skip-fast on the header
      // instead of JSON.parsing every pixel event 13 times (connector-lane producers already
      // stamp it). ADDITIVE: absent header (malformed/legacy in-flight messages) keeps the
      // bridges' full-body-parse fallback. The extraction MUST be exact — a wrong header value
      // would make a bridge silently skip an event it owns — so we JSON.parse (one parse here
      // saves 13 downstream); a top-level-only regex over jsonb canonical text is not safe
      // (a nested payload key named event_name can precede the top-level one).
      const eventName = extractTopLevelEventName(valueText);
      if (eventName !== null) headers['event_name'] = eventName;
      if (brandId !== null) headers['brand_id'] = brandId;
      injectKafkaTraceContext(headers);

      return {
        key: partitionKey,
        value: valueText, // canonical jsonb text passthrough (AUD-PERF-012) — no re-stringify
        headers,
      };
    });

    await this.producer.send({
      topic: this.topic,
      compression: CompressionTypes.GZIP,
      messages,
    });
  }

  isConnected(): boolean {
    return this.producer !== null;
  }
}
