/**
 * produce-micro-batcher — in-process coalescing for the accept hot path (M1, ADR-0015 D1).
 *
 * THE CEILING THIS REMOVES: the idempotent producer runs maxInFlightRequests=1, so with one
 * producer.send() per HTTP accept the collector's throughput is serialized broker round-trips.
 * Coalescing N concurrent accepts into ONE produceBatch flush makes the round-trip amortized:
 * flush every `lingerMs` (INGEST_LINGER_MS, default 5ms) or at `maxEvents`
 * (INGEST_BATCH_MAX_EVENTS, default 500), whichever comes first.
 *
 * ACK CONTRACT UNCHANGED: every enqueue() resolves only after ITS batch's flush settles —
 * produce-ack (or WAL append) still happens before the HTTP 200; the latency cost is ≤ linger.
 * A failed flush settles that WHOLE batch through the flush fn's own failure path (the
 * existing produce-failure → WAL route); the per-request promises reject only when the flush
 * fn itself throws (WAL saturated → FallbackSaturatedError → 503 per request).
 *
 * ORDERING: the buffer preserves enqueue (append) order and flushes are CHAINED (never
 * concurrent), so messages reach producer.send in accept order; kafkajs partitions by key,
 * so per-brand / per-(brand,bucket) ordering holds with maxInFlightRequests=1.
 *
 * BYPASS: construct with lingerMs=0 disabled at the call site (safety valve — the caller
 * invokes the flush fn directly, restoring one-produce-per-request behavior).
 */
import type { ProduceMessage } from './kafka-producer.js';

export interface MicroBatcherConfig {
  /** Max time (ms) a message waits for co-travelers before its batch flushes. */
  lingerMs: number;
  /** Pending-batch size that triggers an immediate flush (before the linger elapses). */
  maxEvents: number;
}

interface Waiter<R> {
  resolve: (result: R) => void;
  reject: (err: unknown) => void;
}

export class ProduceMicroBatcher<R> {
  private buffer: ProduceMessage[] = [];
  private waiters: Waiter<R>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Flush chain: one flush at a time, in order — cross-batch ordering is preserved. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    /** The anchor: produce-or-WAL for one coalesced batch (AcceptEventUseCase.anchor). */
    private readonly flushFn: (messages: ProduceMessage[]) => Promise<R>,
    private readonly cfg: MicroBatcherConfig,
  ) {}

  /**
   * Add a request's messages to the pending batch; resolves with the batch flush outcome.
   * A multi-event request (/batch) enqueues as one unit and shares one outcome — atomic at
   * request granularity, exactly like the pre-batcher anchor.
   */
  enqueue(messages: ProduceMessage[]): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.buffer.push(...messages);
      this.waiters.push({ resolve, reject });
      if (this.buffer.length >= this.cfg.maxEvents) {
        this.flushNow();
        return;
      }
      if (this.timer === null) {
        // NOT unref'd: pending HTTP requests await this timer's flush — it must fire.
        this.timer = setTimeout(() => this.flushNow(), this.cfg.lingerMs);
      }
    });
  }

  /** Synchronously take the pending batch and chain its flush behind any in-flight one. */
  private flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.waiters.length === 0) return;
    const messages = this.buffer;
    const waiters = this.waiters;
    this.buffer = [];
    this.waiters = [];
    this.chain = this.chain.then(async () => {
      try {
        const result = await this.flushFn(messages);
        for (const w of waiters) w.resolve(result);
      } catch (err) {
        // Flush-fn failure (e.g. WAL saturated) fails EVERY request in this batch — the next
        // batch is independent and the chain survives (rejection consumed here).
        for (const w of waiters) w.reject(err);
      }
    });
  }
}
