/**
 * OffsetCommitBatcher — batches manual Kafka offset commits per partition (AUD-PERF-009).
 *
 * The eachMessage consumers on the shared live topic previously issued one synchronous broker
 * commitOffsets request PER MESSAGE (×13 bridge groups even for skipped messages). This batches
 * commits every N messages / T ms while PRESERVING D-7 (commit-only-after-confirmed-write) at
 * batch granularity:
 *   - record(partition, offset) is called ONLY after the write/dedup/DLQ for that offset is
 *     confirmed, and eachMessage is sequential per partition, so the tracked next-offset is
 *     monotonic and NEVER commits past an unconfirmed write.
 *   - A crash between confirm and flush redelivers already-processed messages of the window —
 *     safe under at-least-once: Bronze dedup (Redis NX + PK backstop) is the durable dedup.
 *   - Commit failures (e.g. mid-rebalance generation change) are logged and the pending window
 *     is DROPPED — dropping only widens replay (safe direction), never skips a message.
 *
 * One instance per consumer. Owner calls start() (interval flush, unref'd so it never holds the
 * process open) and stop() (final flush + timer teardown) in the consumer lifecycle.
 */
import { log } from '../../log.js';

export interface CommitEntry {
  topic: string;
  partition: number;
  offset: string;
}

/** Flush after this many recorded messages… */
const DEFAULT_MAX_MESSAGES = 100;
/** …or after this much time, whichever comes first (also the idle-flush interval). */
const DEFAULT_MAX_INTERVAL_MS = 5_000;

export class OffsetCommitBatcher {
  /** partition → next offset to commit (already +1, i.e. "committed position"). */
  private readonly pending = new Map<number, string>();
  private sinceFlush = 0;
  private lastFlushAt = Date.now();
  private timer: NodeJS.Timeout | null = null;
  /** Serializes flushes (interval flush vs in-line threshold flush). */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly topic: string,
    private readonly commit: (entries: CommitEntry[]) => Promise<void>,
    private readonly maxMessages: number = DEFAULT_MAX_MESSAGES,
    private readonly maxIntervalMs: number = DEFAULT_MAX_INTERVAL_MS,
  ) {}

  /** Start the idle flush timer (bounds commit lag when traffic pauses mid-window). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.maxIntervalMs);
    this.timer.unref();
  }

  /**
   * Record a CONFIRMED message (write/dedup/DLQ done) as committable. Flushes in-line when the
   * count/time threshold is reached. Call order per partition must follow offset order (true
   * for KafkaJS eachMessage, which is sequential per partition).
   */
  async record(partition: number, offset: string): Promise<void> {
    this.pending.set(partition, String(Number(offset) + 1));
    this.sinceFlush += 1;
    if (this.sinceFlush >= this.maxMessages || Date.now() - this.lastFlushAt >= this.maxIntervalMs) {
      await this.flush();
    }
  }

  /** Flush all pending partition positions in ONE commitOffsets request. */
  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }

  /** Final flush + timer teardown. Call before the consumer disconnects. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async doFlush(): Promise<void> {
    if (this.pending.size === 0) return;
    const entries: CommitEntry[] = [...this.pending].map(([partition, offset]) => ({
      topic: this.topic,
      partition,
      offset,
    }));
    // Clear BEFORE the awaited commit: record() may run while the request is in flight and
    // must open a NEW window rather than mutate the one being committed.
    this.pending.clear();
    this.sinceFlush = 0;
    this.lastFlushAt = Date.now();
    try {
      await this.commit(entries);
    } catch (err) {
      // Drop the window (at-least-once: uncommitted-but-processed messages replay and are
      // dedup-absorbed). Retrying a stale commit (e.g. after a rebalance) could loop forever.
      log.warn(`offset commit batch failed — dropping window (replay is dedup-absorbed) topic=${this.topic}`, { err });
    }
  }
}
