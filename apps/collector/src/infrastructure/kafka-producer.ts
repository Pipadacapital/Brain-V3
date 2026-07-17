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

/** Thrown when a produce exceeds the per-request deadline — the caller routes to the WAL. */
export class ProduceDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`[kafka] produce deadline exceeded (${deadlineMs}ms) — routing to WAL fallback`);
    this.name = 'ProduceDeadlineError';
  }
}

/** Consecutive produce failures that flip isHealthy() false (auto-clears on next success). */
const PRODUCE_FAILURE_UNHEALTHY_THRESHOLD = 3;

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
   * kafkajs client requestTimeout (INGEST_PRODUCE_REQUEST_TIMEOUT_MS). Default 4000ms — the
   * kafkajs default (30s) turns a slow broker into unbounded request pileup on the hot path.
   */
  requestTimeoutMs?: number;
  /**
   * Per-produce hard deadline (INGEST_PRODUCE_DEADLINE_MS). Default 6000ms — above one full
   * requestTimeout attempt, below client-facing fetch timeouts. Expiry throws
   * ProduceDeadlineError so the caller anchors the batch to the WAL like any produce failure.
   */
  produceDeadlineMs?: number;
  /**
   * Hot-brand composite partition keying (ADR-0015 §5.3): brands in this list get key
   * `${brand_id}:${bucket}` instead of plain brand_id. DEFAULT EMPTY — plain brand_id
   * keying for every brand (zero behavior change until a brand is listed).
   */
  hotBrandIds?: string[];
  /** Bucket count for the composite key (INGEST_HOT_BRAND_BUCKETS). Default 4. */
  hotBrandBuckets?: number;
  /**
   * Producer batch compression (INGEST_PRODUCE_COMPRESSION). Default 'gzip' — ~4x on JSON
   * envelopes, which is what sizes broker disk/network for the 40K/s ramp (ingest-scale-ramp
   * runbook). 'none' is the escape hatch if broker-side CPU or a codec regression ever
   * demands it. zstd is deliberately NOT offered: kafkajs has no built-in zstd — the only
   * community codec (@kafkajs/zstd 0.1.x) is an immature native-binding dep we will not put
   * on the ingest hot path; revisit only if CPU profiling at ≥20K/s shows gzip cost.
   */
  compression?: 'gzip' | 'none';
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
  /** Batch compression codec resolved once from config ('gzip' default → GZIP). */
  private readonly compression: CompressionTypes;
  private producer: Producer | null = null;
  /** Single-flight connect guard: the accept path + fallback flusher must never race two connects. */
  private connecting: Promise<void> | null = null;
  /** Per-produce hard deadline (ms) — expiry routes the batch to the WAL (H3). */
  private readonly produceDeadlineMs: number;
  /**
   * Honest post-boot health (H3). isConnected() alone LIES after boot: this.producer stays
   * non-null through a broker outage (it is nulled only by explicit disconnect()), so a
   * post-boot outage was invisible to the back-pressure gate and /readyz. Two signals fix it:
   *   • consecutiveProduceFailures — the PRIMARY signal: ≥ threshold flips isHealthy() false;
   *     the next successful produce auto-clears it.
   *   • eventDisconnected — secondary fast-path from kafkajs instrumentation events. NOTE:
   *     kafkajs reliably emits producer.disconnect only on explicit disconnect(); a broker
   *     socket breaking mid-flight does NOT dependably fire it — which is exactly why the
   *     failure counter, not the event, is the primary signal.
   */
  private consecutiveProduceFailures = 0;
  private eventDisconnected = false;

  constructor(config: KafkaProducerConfig) {
    const kafkaConfig: KafkaConfig = {
      clientId: config.clientId,
      brokers: config.brokers,
      // Bounded per-request timeout (H3): the kafkajs default (30s) lets a slow/hung broker
      // pile up 30s-per-attempt requests behind maxInFlightRequests=1. enforceRequestTimeout
      // defaults to true in kafkajs 2.x, so setting the value is sufficient.
      requestTimeout: config.requestTimeoutMs ?? 4_000,
      // Bounded client-level retry: the accept path must FAIL within a small window when the
      // log is down so it can fall back to the disk WAL — never hang the HTTP request. The
      // no-event-loss invariant is held by produce-ack OR fallback-append, not infinite retry.
      // retries>=1 also keeps the idempotent-producer requirement satisfied (kafkajs retries
      // within send(); broker-side idempotence dedups those retries).
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
    this.produceDeadlineMs = config.produceDeadlineMs ?? 6_000;
    this.compression =
      (config.compression ?? 'gzip') === 'none' ? CompressionTypes.None : CompressionTypes.GZIP;
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
      // H3 secondary health signal: kafkajs instrumentation events, subscribed for the cases
      // they DO fire (explicit disconnect, reconnect CONNECT after a broken socket heals).
      // They are NOT the primary signal — see the eventDisconnected field comment.
      producer.on(producer.events.CONNECT, () => {
        this.eventDisconnected = false;
      });
      producer.on(producer.events.DISCONNECT, () => {
        this.eventDisconnected = true;
      });
      try {
        await producer.connect();
      } catch (err) {
        // Best-effort teardown of the half-open client; this.producer stays null (not connected).
        await producer.disconnect().catch(() => undefined);
        throw err;
      }
      this.producer = producer;
      // Fresh connection = fresh health slate (a stale unhealthy bit must not shed traffic).
      this.consecutiveProduceFailures = 0;
      this.eventDisconnected = false;
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

    // Per-request produce deadline (H3): bound the send in a race so a slow/hung broker can
    // never hold an accept past INGEST_PRODUCE_DEADLINE_MS (above one requestTimeout attempt,
    // below client fetch timeouts). On expiry ProduceDeadlineError propagates and the caller
    // routes the batch to the WAL exactly like a produce failure — that path is idempotent-safe
    // downstream: if the in-flight send later succeeds on the broker, the WAL replay is a late
    // duplicate that Bronze-compaction + Silver MERGE dedup absorb (ADR-0015 D2).
    try {
      await this.withDeadline(
        this.producer.send({
          topic: this.topic,
          acks: -1, // produce-ack from ALL in-sync replicas IS the durability anchor (ADR-0015 D1)
          compression: this.compression,
          messages,
        }),
      );
      // Success auto-clears the health bit (H3) — one good produce proves the pipe works.
      this.consecutiveProduceFailures = 0;
      this.eventDisconnected = false;
    } catch (err) {
      this.consecutiveProduceFailures += 1;
      throw err;
    }
  }

  /** Race a produce against the hard deadline; the late loser's rejection is swallowed. */
  private async withDeadline<T>(send: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProduceDeadlineError(this.produceDeadlineMs)), this.produceDeadlineMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([send, deadline]);
    } finally {
      clearTimeout(timer);
      // If the deadline won, the in-flight send may still reject later — absorb it so a late
      // broker failure never surfaces as an unhandledRejection crash.
      send.catch(() => undefined);
    }
  }

  isConnected(): boolean {
    return this.producer !== null;
  }

  /**
   * Honest post-boot health (H3): connected AND no event-signaled disconnect AND fewer than
   * PRODUCE_FAILURE_UNHEALTHY_THRESHOLD consecutive produce failures. The back-pressure
   * admission gate and /readyz read THIS (not isConnected(), which stays true through any
   * post-boot broker outage). Auto-clears on the next successful produce — no manual reset.
   */
  isHealthy(): boolean {
    return (
      this.producer !== null &&
      !this.eventDisconnected &&
      this.consecutiveProduceFailures < PRODUCE_FAILURE_UNHEALTHY_THRESHOLD
    );
  }
}
