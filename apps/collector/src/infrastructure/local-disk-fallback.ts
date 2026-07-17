/**
 * local-disk-fallback — bounded on-pod append-file WAL for the accept path (ADR-0015 D1).
 *
 * ROLE: the collector produces DIRECTLY to the log; when the produce fails (broker down,
 * network partition, boot race) the accepted envelope is appended HERE — a size-capped
 * JSONL file on local disk, fsync'd per append batch — and the HTTP ACK still fires.
 * A background flusher retries the produce on reconnect and truncates flushed entries.
 * This preserves the pixel fire-and-forget no-retry guarantee through a total log outage.
 *
 * BOUNDED: when the WAL is at INGEST_FALLBACK_MAX_BYTES AND the produce is failing,
 * append() throws FallbackSaturatedError and the accept path sheds 503 + Retry-After
 * (producer-backpressure.ts). An unbounded buffer is not durability — it just moves the
 * disk-full cliff, exactly the lesson of the deleted PG spool.
 *
 * CRASH SAFETY (simple by design):
 *   • Append batches are fdatasync'd before the caller ACKs.
 *   • Flush is rotate-then-produce: the active WAL is renamed to a .flushing file (appends
 *     continue on a fresh active file), its lines are produced in batches, and the .flushing
 *     file is unlinked ONLY after every line produced. A crash/produce-failure mid-flush keeps
 *     the file → next flush re-produces from the top. That is deliberate at-least-once:
 *     Bronze-compaction + Silver dedup absorb the replay (ADR-0015 D2); no event is lost.
 *   • A torn final line from a mid-write crash fails JSON.parse and is skipped with a warn
 *     (the client never got its ACK for that request, so the retry contract re-sends it).
 */
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ProduceMessage } from './kafka-producer.js';
import { log } from '../log.js';

/** Thrown by append() when the WAL is at cap — mapped to 503 by producer-backpressure. */
export class FallbackSaturatedError extends Error {
  constructor(pendingBytes: number, maxBytes: number) {
    super(`[fallback] WAL saturated: ${pendingBytes}B pending >= ${maxBytes}B cap`);
    this.name = 'FallbackSaturatedError';
  }
}

export interface LocalDiskFallbackConfig {
  /** Directory holding the WAL files (INGEST_FALLBACK_DIR). */
  dir: string;
  /** Size cap across active + flushing WAL bytes (INGEST_FALLBACK_MAX_BYTES). */
  maxBytes: number;
  /** Background flusher cadence (INGEST_FALLBACK_FLUSH_INTERVAL_MS). */
  flushIntervalMs: number;
}

/** The producer surface the flusher needs — kept minimal so tests stub it trivially. */
export interface FlushProducer {
  isConnected(): boolean;
  connect(): Promise<void>;
  produceBatch(batch: ProduceMessage[]): Promise<void>;
}

const ACTIVE_FILE = 'collector-fallback.wal';
const FLUSHING_FILE = 'collector-fallback.flushing.wal';
/** Lines produced per broker round-trip during a flush (bounds flush memory). */
const FLUSH_PRODUCE_BATCH = 200;

export class LocalDiskFallback {
  private readonly activePath: string;
  private readonly flushingPath: string;
  private fh: FileHandle | null = null;
  private activeBytes = 0;
  private flushingBytes = 0;
  /** Promise-chain mutex: appends and the flush's rotate step never interleave. */
  private lock: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  constructor(
    private readonly cfg: LocalDiskFallbackConfig,
    private readonly producer: FlushProducer,
  ) {
    this.activePath = join(cfg.dir, ACTIVE_FILE);
    this.flushingPath = join(cfg.dir, FLUSHING_FILE);
  }

  /** Create the dir and adopt any WAL bytes left by a previous process (crash recovery). */
  async init(): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true });
    this.activeBytes = await fileSize(this.activePath);
    this.flushingBytes = await fileSize(this.flushingPath);
    if (this.activeBytes + this.flushingBytes > 0) {
      log.info('fallback WAL has pending bytes from a previous run — flusher will drain them', {
        active_bytes: this.activeBytes,
        flushing_bytes: this.flushingBytes,
      });
    }
  }

  /** Total unflushed bytes (active + rotated-but-not-yet-produced). */
  pendingBytes(): number {
    return this.activeBytes + this.flushingBytes;
  }

  /** At/over cap — new appends would throw; the admission gate sheds 503 pre-handler. */
  isSaturated(): boolean {
    return this.pendingBytes() >= this.cfg.maxBytes;
  }

  /**
   * Durably append a batch of accepted envelopes: one write + one fdatasync, then the caller
   * ACKs. Throws FallbackSaturatedError at cap (accept path returns 503 backpressure).
   */
  async append(messages: ProduceMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const payload = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const bytes = Buffer.byteLength(payload);

    await this.withLock(async () => {
      if (this.pendingBytes() + bytes > this.cfg.maxBytes) {
        throw new FallbackSaturatedError(this.pendingBytes(), this.cfg.maxBytes);
      }
      if (!this.fh) {
        this.fh = await open(this.activePath, 'a');
      }
      await this.fh.write(payload);
      // fsync per append batch: the ACK that follows must survive a pod crash.
      await this.fh.datasync();
      this.activeBytes += bytes;
    });
  }

  /**
   * One flush pass: rotate the active WAL out (under the append lock), then re-produce its
   * lines and unlink on full success. Skips silently when there is nothing to flush or the
   * producer is unreachable (next tick retries). Overlap-guarded — one pass at a time.
   */
  async flushOnce(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // Adopt a leftover .flushing file first (crash mid-flush); otherwise rotate the active WAL.
      if (this.flushingBytes === 0 && this.activeBytes > 0) {
        await this.withLock(async () => {
          if (this.fh) {
            await this.fh.close();
            this.fh = null;
          }
          await rename(this.activePath, this.flushingPath);
          this.flushingBytes = this.activeBytes;
          this.activeBytes = 0;
        });
      }
      if (this.flushingBytes === 0) return;

      // Reconnect-then-produce: the flusher IS the producer's reconnect driver while Kafka is down.
      if (!this.producer.isConnected()) {
        try {
          await this.producer.connect();
        } catch {
          return; // still down — the .flushing file waits for the next tick
        }
      }

      await this.produceFile(this.flushingPath);

      // Every line produced (produce-ack'd) — the WAL entries are now durable in the log.
      await unlink(this.flushingPath);
      const drained = this.flushingBytes;
      this.flushingBytes = 0;
      log.info('fallback WAL flushed to the log', { bytes: drained });
    } catch (err) {
      // Produce failed mid-file: keep the .flushing file; next tick re-produces from the top
      // (at-least-once — Bronze-compaction + Silver dedup absorb the replay, ADR-0015 D2).
      log.warn('fallback WAL flush failed — will retry', { err });
    } finally {
      this.flushing = false;
    }
  }

  /** Stream the file's JSONL lines and produce them in bounded batches. Throws on produce failure. */
  private async produceFile(path: string): Promise<void> {
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    let batch: ProduceMessage[] = [];
    try {
      for await (const line of rl) {
        if (line.length === 0) continue;
        let msg: ProduceMessage;
        try {
          msg = JSON.parse(line) as ProduceMessage;
        } catch {
          // Torn final line from a mid-write crash — its request was never ACK'd; skip it.
          log.warn('fallback WAL: skipping unparseable line (torn write)', { line_bytes: line.length });
          continue;
        }
        batch.push(msg);
        if (batch.length >= FLUSH_PRODUCE_BATCH) {
          await this.producer.produceBatch(batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        await this.producer.produceBatch(batch);
      }
    } finally {
      rl.close();
    }
  }

  /** Start the background flusher. unref'd — never holds the process open. */
  start(): void {
    this.timer = setInterval(() => void this.flushOnce(), this.cfg.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.withLock(async () => {
      if (this.fh) {
        await this.fh.close();
        this.fh = null;
      }
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    // The chain must survive a rejected section (e.g. FallbackSaturatedError) — swallow for
    // the chain only; the caller still receives the rejection from `run`.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0; // ENOENT — no WAL yet
  }
}
