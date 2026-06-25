/**
 * NoLoss — the zero-event-loss delivery contract (Brain rule: "no event loss").
 *
 * The framework guarantees AT-LEAST-ONCE delivery of every emitted canonical event to Bronze, and
 * pairs it with the deterministic dedup id (see Dedup.ts) so at-least-once is SAFE — a redelivered
 * event is idempotently dropped on write rather than double-counted. "Zero loss" is therefore the
 * conjunction of two contracts:
 *
 *   1. NoLoss (this file)  — once the connector hands a record to the framework, it WILL reach
 *      Bronze: it is retried with bounded backoff, and if it still cannot be delivered it is
 *      spooled to a Dead-Letter sink for replay rather than dropped.
 *   2. Dedup (Dedup.ts)    — the redelivery a retry/replay causes is harmless because the id is
 *      deterministic and Bronze writes are idempotent.
 *
 * These are expressed as INTERFACES the connector/runtime implements (a Kafka idempotent producer +
 * a DLQ table behind `IEventSink` and `IDeadLetterSink`), so this kernel package stays free of
 * kafkajs/pg. The `deliverWithNoLoss` driver wires them together with the retry policy.
 */
import type { CanonicalEvent } from './CanonicalEvent.js';

/**
 * A destination the framework writes canonical events to (the Bronze ingest path — in practice a
 * Kafka idempotent producer onto the connector's ingest topic, whose Iceberg sink MERGEs on
 * event_id). The sink is expected to be effectively idempotent on `event_id`, but the framework
 * never RELIES on the sink for correctness — it relies on the deterministic id + Bronze dedup.
 */
export interface IEventSink {
  /**
   * Deliver one canonical event. MUST throw on a delivery failure (so the retry policy engages);
   * a resolved promise means the event was accepted by the sink.
   */
  deliver(event: CanonicalEvent): Promise<void>;
}

/**
 * The terminal safety net: a durable Dead-Letter sink (the dlq_record table / a DLQ topic). An
 * event that exhausts its retries is spooled here WITH its deterministic event_id, so it is never
 * lost and can be replayed later (the replay is idempotent on the same id).
 */
export interface IDeadLetterSink {
  /**
   * Durably record an undeliverable event plus the failure context. MUST be more reliable than the
   * primary sink (e.g. a local append / a separate topic) — if THIS throws, the caller should
   * crash the worker rather than swallow, so the event is not lost (the source is replayable).
   */
  spool(record: DeadLetterRecord): Promise<void>;
}

/** What gets written to the Dead-Letter sink when delivery is exhausted. */
export interface DeadLetterRecord {
  readonly brandId: string;
  readonly provider: string;
  readonly resource: string;
  /** The deterministic id — replay stays idempotent. */
  readonly eventId: string;
  readonly event: CanonicalEvent;
  /** Truncated last-error string (never the token — I-S09). */
  readonly failureReason: string;
  /** How many delivery attempts were made before giving up. */
  readonly attempts: number;
  readonly spooledAt: Date;
}

/** Bounded-retry policy for the no-loss delivery driver. */
export interface RetryPolicy {
  /** Total delivery attempts before spooling to the DLQ (>= 1). */
  readonly maxAttempts: number;
  /** Base backoff in ms; attempt N waits ~ baseDelayMs * 2^(N-1), capped at maxDelayMs. */
  readonly baseDelayMs: number;
  /** Backoff cap in ms. */
  readonly maxDelayMs: number;
}

/** A sane default: 5 attempts, exponential 200ms → 10s cap. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
};

/** Compute the backoff (ms) before a given 1-based attempt number, per a RetryPolicy. */
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  if (attempt <= 1) return 0;
  const exp = policy.baseDelayMs * 2 ** (attempt - 2);
  return Math.min(exp, policy.maxDelayMs);
}

/** Injected sleeper so the driver is unit-testable without real timers. */
export type Sleeper = (ms: number) => Promise<void>;

const realSleep: Sleeper = (ms) =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/** Outcome of a no-loss delivery: did it reach the primary sink, or was it spooled to the DLQ? */
export interface DeliveryOutcome {
  readonly delivered: boolean;
  readonly spooledToDlq: boolean;
  readonly attempts: number;
}

/**
 * deliverWithNoLoss — the reference no-loss driver.
 *
 * Attempts `sink.deliver(event)` up to `policy.maxAttempts` with exponential backoff. If every
 * attempt fails, the event is spooled to the Dead-Letter sink (never dropped) and the outcome
 * reports `spooledToDlq: true`. If the DLQ spool ITSELF throws, the error propagates so the caller
 * crashes loudly (the upstream source is replayable; a silent swallow here would be the only place
 * an event could truly be lost).
 *
 * Correctness note: because `event.provenance.event_id` is deterministic, a retry that actually
 * succeeded on the sink but whose ack was lost (so we retry again) writes the SAME id twice and
 * Bronze drops the duplicate — at-least-once is safe.
 */
export async function deliverWithNoLoss(args: {
  event: CanonicalEvent;
  resource: string;
  sink: IEventSink;
  dlq: IDeadLetterSink;
  policy?: RetryPolicy;
  sleep?: Sleeper;
}): Promise<DeliveryOutcome> {
  const policy = args.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = args.sleep ?? realSleep;
  let lastError = '';

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const wait = backoffDelayMs(policy, attempt);
    if (wait > 0) await sleep(wait);
    try {
      await args.sink.deliver(args.event);
      return { delivered: true, spooledToDlq: false, attempts: attempt };
    } catch (err) {
      lastError = String(err).slice(0, 500);
    }
  }

  // Exhausted — spool to the DLQ rather than drop. A throw here propagates (loud, not lost).
  await args.dlq.spool({
    brandId: args.event.provenance.brand_id,
    provider: args.event.provenance.source,
    resource: args.resource,
    eventId: args.event.provenance.event_id,
    event: args.event,
    failureReason: lastError,
    attempts: policy.maxAttempts,
    spooledAt: new Date(),
  });
  return { delivered: false, spooledToDlq: true, attempts: policy.maxAttempts };
}
