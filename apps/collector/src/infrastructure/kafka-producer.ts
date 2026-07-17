/**
 * KafkaJS producer wrapper — the ACCEPT hot path (ADR-0015 D1).
 *
 * Direct-to-log ingest: the HTTP accept path calls produce()/produceBatch() and the
 * produce-ack (acks=-1 on an idempotent producer) IS the durability anchor. The old
 * Postgres spool + drainer are DELETED — when the log is unreachable the caller falls
 * back to the bounded local-disk WAL (local-disk-fallback.ts), never to Postgres.
 *
 * Idempotence: `idempotent: true` + `acks: -1` + bounded retries de-duplicates
 * broker-side delivery retries (ADR-0015 D2a). kafkajs requires maxInFlightRequests=1
 * and retries >= 1 for an idempotent producer; retries stay SMALL so a dead broker
 * fails the produce within a bounded window and the accept path can fall back to disk
 * instead of hanging the HTTP request.
 */
import { Kafka, type Producer, type KafkaConfig, type Message, CompressionTypes } from 'kafkajs';
import { injectKafkaTraceContext } from '@brain/observability';

/**
 * One accepted envelope headed for the collector topic (built by AcceptEventUseCase).
 * The value is the stamped envelope serialized ONCE at accept time — sent verbatim.
 * brand/event ids are projected pre-validation (null = absent/non-string in the raw body).
 */
export interface ProduceMessage {
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
  /**
   * Hot-brand composite partition keying (ADR-0015 §5.3): brands in this list get key
   * `${brand_id}:${bucket}` instead of plain brand_id. DEFAULT EMPTY — plain brand_id
   * keying for every brand (zero behavior change until a brand is listed).
   */
  hotBrandIds?: string[];
  /** Bucket count for the composite key (INGEST_HOT_BRAND_BUCKETS). Default 4. */
  hotBrandBuckets?: number;
}

/** The envelope fields the producer projects from ONE JSON.parse of the serialized body. */
interface EnvelopeFields {
  /** TOP-LEVEL event_name (AUD-PERF-005 skip-fast header); null = absent/non-string. */
  eventName: string | null;
  /** properties.brain_anon_id (the raw-only visitor signal) — the hot-brand bucket input. */
  anonId: string | null;
}

/**
 * Extract the TOP-LEVEL event_name + properties.brain_anon_id from the serialized envelope
 * text in a SINGLE parse (AUD-PERF-005: one parse here saves N downstream; adding a second
 * parse for the hot-brand bucket would double the hot-path cost for nothing).
 * Unparseable body → both null: the event_name header is omitted (bridges fall back to body
 * parse) and the hot-brand bucket falls back to event_id/correlation_id.
 */
function extractEnvelopeFields(valueText: string): EnvelopeFields {
  try {
    const parsed = JSON.parse(valueText) as Record<string, unknown>;
    const name = parsed?.['event_name'];
    const properties = parsed?.['properties'];
    const anon =
      properties !== null && typeof properties === 'object'
        ? (properties as Record<string, unknown>)['brain_anon_id']
        : undefined;
    return {
      eventName: typeof name === 'string' && name.length > 0 ? name : null,
      anonId: typeof anon === 'string' && anon.length > 0 ? anon : null,
    };
  } catch {
    return { eventName: null, anonId: null };
  }
}

/**
 * FNV-1a 32-bit — a STABLE (process/version-independent) string hash for the hot-brand
 * bucket assignment. Stability matters: the same anon_id must land in the same bucket
 * across collector replicas and restarts so a visitor's events stay partition-ordered.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class CollectorKafkaProducer {
  private readonly kafka: Kafka;
  private readonly topic: string;
  /** Hot-brand composite keying (ADR-0015 §5.3) — empty set = plain brand_id keys everywhere. */
  private readonly hotBrandIds: Set<string>;
  private readonly hotBrandBuckets: number;
  private producer: Producer | null = null;
  /** Single-flight connect guard: the accept path + fallback flusher must never race two connects. */
  private connecting: Promise<void> | null = null;

  constructor(config: KafkaProducerConfig) {
    const kafkaConfig: KafkaConfig = {
      clientId: config.clientId,
      brokers: config.brokers,
      // Bounded client-level retry: the accept path must FAIL within a small window when the
      // log is down so it can fall back to the disk WAL — never hang the HTTP request. The
      // no-event-loss invariant is held by produce-ack OR fallback-append, not infinite retry.
      retry: {
        retries: 3,
        initialRetryTime: 100,
        maxRetryTime: 2_000,
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
    this.hotBrandIds = new Set(config.hotBrandIds ?? []);
    this.hotBrandBuckets = Math.max(1, config.hotBrandBuckets ?? 4);
  }

  /**
   * Partition key for one message (ADR-0015 §5.3 hot-brand composite key).
   *   • Unlisted brand → plain brand_id (tenant-routed; unchanged behavior — and with the
   *     default-empty INGEST_HOT_BRAND_IDS every brand takes this path).
   *   • Listed hot brand → `${brand_id}:${bucket}` where bucket = fnv1a(anon_id) mod
   *     INGEST_HOT_BRAND_BUCKETS (event_id, then correlation_id, as fallbacks) — spreads one
   *     brand across N partitions instead of saturating one.
   * WHY per-(brand,bucket) ordering is safe: identity resolution is ORDER-INDEPENDENT — the
   * deterministic matcher converges on the lowest-UUID canonical brain_id regardless of the
   * order identifier observations arrive (ADR-0015 D5), so global per-brand ordering buys
   * nothing. What per-VISITOR ordering is worth having is preserved: the same anon_id always
   * hashes to the same bucket, so a visitor's events stay on one partition, in order.
   */
  private partitionKey(msg: ProduceMessage, anonId: string | null): string | null {
    const { brandId, eventId, correlationId } = msg;
    if (brandId === null) return null; // pre-validation malformed tail → round-robin (unchanged)
    if (!this.hotBrandIds.has(brandId)) return brandId;
    // correlationId is always present, so a hot brand's malformed tail still spreads across
    // buckets instead of collapsing onto one composite key.
    const bucketInput = anonId ?? eventId ?? correlationId;
    const bucket = fnv1a32(bucketInput) % this.hotBrandBuckets;
    return `${brandId}:${bucket}`;
  }

  async connect(): Promise<void> {
    if (this.producer) return;
    // Single-flight: concurrent callers (accept path + flusher) await the same attempt.
    if (this.connecting) return this.connecting;

    // Idempotent producer (ADR-0015 D2a): broker-side dedup of delivery retries. kafkajs
    // enforces maxInFlightRequests=1 + retries>=1 for idempotence; acks=-1 is set per send.
    //
    // this.producer is assigned ONLY after producer.connect() succeeds, so isConnected() is
    // truthful. The old code assigned first: a startup connect() loss (Kafka restarting while
    // the collector boots — seen live 2026-07-17) left a never-connected non-null producer, so
    // isConnected() lied true and every produce failed until a process restart.
    this.connecting = (async () => {
      const producer = this.kafka.producer({
        allowAutoTopicCreation: false,
        idempotent: true,
        maxInFlightRequests: 1,
      });
      try {
        await producer.connect();
      } catch (err) {
        // Best-effort teardown of the half-open client; this.producer stays null (not connected).
        await producer.disconnect().catch(() => undefined);
        throw err;
      }
      this.producer = producer;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
  }

  /** Produce ONE accepted envelope (the /collect + /v1/events hot path). */
  async produce(message: ProduceMessage): Promise<void> {
    await this.produceBatch([message]);
  }

  /**
   * Produce a batch in ONE producer.send (/batch hot path + fallback flusher) — kafkajs groups
   * the messages per partition natively, so a 50-event /batch is one broker round-trip. GZIP is
   * codec-transparent to every consumer. Failure granularity is the batch: on throw the CALLER
   * falls back to the disk WAL for the whole batch (at-least-once; Bronze-compaction + Silver
   * dedup absorb any partial-produce replay — ADR-0015 D2).
   */
  async produceBatch(batch: ProduceMessage[]): Promise<void> {
    if (!this.producer) {
      throw new Error('[kafka] producer not connected');
    }
    if (batch.length === 0) return;

    const messages: Message[] = batch.map((m) => {
      const { valueText, brandId, eventId, correlationId } = m;
      // OTel W3C trace-context propagation across the Kafka boundary (OBS-1/OBS-2):
      // inject traceparent/tracestate so downstream consumers resume this trace
      // instead of starting an orphan root span. Carried alongside correlation_id.
      const headers: Record<string, string> = {
        correlation_id: correlationId,
        source: 'collector',
      };
      // AUD-PERF-005: stamp event_name (and brand_id/event_id when projected) as Kafka headers
      // so the Bronze-bridge consumer groups on this shared topic can skip-fast on the header
      // instead of JSON.parsing every pixel event N times. ADDITIVE: absent header keeps the
      // bridges' full-body-parse fallback. The extraction MUST be exact — a wrong header value
      // would make a bridge silently skip an event it owns — so we JSON.parse (one parse here
      // saves N downstream); a top-level-only regex is not safe (a nested payload key named
      // event_name can precede the top-level one).
      const { eventName, anonId } = extractEnvelopeFields(valueText);
      if (eventName !== null) headers['event_name'] = eventName;
      if (brandId !== null) headers['brand_id'] = brandId;
      if (eventId !== null) headers['event_id'] = eventId;
      injectKafkaTraceContext(headers);

      // ADR-0015 D1: partition key = brand_id (tenant-routed — a brand's events land on a
      // stable partition and never interleave across tenants). ADR-0015 §5.3: a LISTED hot
      // brand gets the composite `${brand_id}:${bucket}` key instead (see partitionKey()).
      // No brand_id yet (pre-validation malformed tail) → NO key: round-robin partitioning;
      // stream tier validates downstream.
      const key = this.partitionKey(m, anonId);

      return {
        ...(key !== null ? { key } : {}),
        value: valueText, // serialized-once envelope passthrough — no re-stringify
        headers,
      };
    });

    await this.producer.send({
      topic: this.topic,
      acks: -1, // produce-ack from ALL in-sync replicas IS the durability anchor (ADR-0015 D1)
      compression: CompressionTypes.GZIP,
      messages,
    });
  }

  isConnected(): boolean {
    return this.producer !== null;
  }
}
