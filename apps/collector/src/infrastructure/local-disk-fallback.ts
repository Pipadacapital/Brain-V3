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
 *     the file → next flush RESUMES from the produced-line high-water offset (M4, sidecar
 *     .offset file, fsync'd after each produced batch) instead of replaying from the top.
 *     Replaying whole files was safe for KEYED events (Bronze-compaction + Silver dedup) but
 *     made PERMANENT physical duplicates of keyless events (no brand_id/event_id → excluded
 *     from Bronze dedup and un-MERGE-able in Silver). Residual at-least-once: a crash BETWEEN
 *     a batch produce and its offset fsync re-produces at most that ONE batch on resume —
 *     bounded, and keyed events in it are absorbed downstream (ADR-0015 D2).
 *   • A torn final line from a mid-write crash fails JSON.parse and is skipped with a warn
 *     (the client never got its ACK for that request, so the retry contract re-sends it).
 */
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { incrementCounter } from '@brain/observability';
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
  /**
   * Lines produced per broker round-trip during a flush (bounds flush memory AND the M4
   * crash-window re-produce). Internal knob — default FLUSH_PRODUCE_BATCH; tests shrink it.
   */
  flushProduceBatchLines?: number;
}

/** The producer surface the flusher needs — kept minimal so tests stub it trivially. */
export interface FlushProducer {
  isConnected(): boolean;
  connect(): Promise<void>;
  produceBatch(batch: ProduceMessage[]): Promise<void>;
}

/**
 * WAL observability snapshot (ADR-0015 WAL durability posture) — exposed as gauges on
 * GET /metrics: while pending > 0, events are ACK'd but NOT on the log yet — the durability
 * exposure window is OPEN (a hard node loss would drop them). The oldest-entry age drives
 * the BrainCollectorWalPendingAge* alerts (warning >5m, critical >30m).
 */
export interface WalStats {
  /** Total unflushed bytes (active + rotated-but-not-yet-produced). */
  pendingBytes: number;
  /** Total unflushed entries (events ACK'd off the WAL append, not yet produce-ack'd). */
  pendingEvents: number;
  /** Age (seconds) of the OLDEST unflushed entry; 0 when the WAL is empty. */
  oldestEntryAgeSeconds: number;
}

const ACTIVE_FILE = 'collector-fallback.wal';
const FLUSHING_FILE = 'collector-fallback.flushing.wal';
/**
 * Produced-line high-water sidecar for the .flushing file (M4): holds the count of raw lines
 * from the top of the .flushing file that are already produce-ack'd, fsync'd after each
 * produced batch. A flush retry (in-process or next-boot) resumes AFTER this line instead of
 * replaying the whole file — the replay was minting permanent physical duplicates for
 * KEYLESS events. Lifecycle: created/advanced during a flush; on completion the .flushing
 * file is unlinked FIRST, then the sidecar — and the rotate step defensively unlinks any
 * stale sidecar BEFORE renaming active→flushing, so a stale offset can never pair with a
 * newly-rotated file (which would skip unproduced lines = event loss; dupes are acceptable,
 * loss never is). A fileless sidecar left by a crash between the unlinks is cleaned at init().
 */
const FLUSHING_OFFSET_FILE = 'collector-fallback.flushing.wal.offset';
/** Lines produced per broker round-trip during a flush (bounds flush memory). */
const FLUSH_PRODUCE_BATCH = 200;

export class LocalDiskFallback {
  private readonly activePath: string;
  private readonly flushingPath: string;
  private readonly flushingOffsetPath: string;
  private readonly flushBatchLines: number;
  private fh: FileHandle | null = null;
  private activeBytes = 0;
  private flushingBytes = 0;
  /** Entry counts mirroring the byte accounting (WAL observability gauges). */
  private activeEvents = 0;
  private flushingEvents = 0;
  /** Epoch-ms of the OLDEST entry in each file; null = file empty (drives the age gauge). */
  private activeOldestMs: number | null = null;
  private flushingOldestMs: number | null = null;
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
    this.flushingOffsetPath = join(cfg.dir, FLUSHING_OFFSET_FILE);
    this.flushBatchLines = cfg.flushProduceBatchLines ?? FLUSH_PRODUCE_BATCH;
  }

  /** Create the dir and adopt any WAL bytes left by a previous process (crash recovery). */
  async init(): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true });
    this.activeBytes = await fileSize(this.activePath);
    this.flushingBytes = await fileSize(this.flushingPath);
    // Adopt observability state for crash-leftover files too: entry counts by a one-time line
    // scan (boot only, bounded by the WAL cap), oldest-entry age approximated by the file's
    // creation time (= its first append; mtime fallback where birthtime is unsupported).
    this.activeEvents = this.activeBytes > 0 ? await countLines(this.activePath) : 0;
    if (this.flushingBytes > 0) {
      // M4: pending = total lines minus the produced-line high-water (a crash mid-flush left
      // a sidecar; those lines are already on the log and will be SKIPPED, not replayed).
      const producedLines = await readOffsetSidecar(this.flushingOffsetPath);
      this.flushingEvents = Math.max(0, (await countLines(this.flushingPath)) - producedLines);
    } else {
      this.flushingEvents = 0;
      // A sidecar without its .flushing file (crash between the completion unlinks) is stale —
      // it must NOT survive to pair with a future rotation (that would skip unproduced lines).
      await unlink(this.flushingOffsetPath).catch(() => undefined);
    }
    this.activeOldestMs = this.activeBytes > 0 ? await fileBirthMs(this.activePath) : null;
    this.flushingOldestMs = this.flushingBytes > 0 ? await fileBirthMs(this.flushingPath) : null;
    if (this.activeBytes + this.flushingBytes > 0) {
      log.info('fallback WAL has pending bytes from a previous run — flusher will drain them', {
        active_bytes: this.activeBytes,
        flushing_bytes: this.flushingBytes,
        pending_events: this.activeEvents + this.flushingEvents,
      });
    }
  }

  /** Total unflushed bytes (active + rotated-but-not-yet-produced). */
  pendingBytes(): number {
    return this.activeBytes + this.flushingBytes;
  }

  /**
   * WAL observability gauges (scrape-time snapshot — always current with the append/flush
   * accounting above; the /metrics route reads this per scrape).
   */
  walStats(): WalStats {
    const oldestCandidates = [this.activeOldestMs, this.flushingOldestMs].filter(
      (t): t is number => t !== null,
    );
    return {
      pendingBytes: this.pendingBytes(),
      pendingEvents: this.activeEvents + this.flushingEvents,
      oldestEntryAgeSeconds:
        oldestCandidates.length === 0
          ? 0
          : Math.max(0, (Date.now() - Math.min(...oldestCandidates)) / 1000),
    };
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
      this.activeEvents += messages.length;
      // First entry into an empty active file opens the durability exposure window (age gauge).
      this.activeOldestMs ??= Date.now();
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
          // M4 defensive: a freshly-rotated file must always start at offset 0 — a stale
          // sidecar pairing with it would SKIP unproduced lines (event loss, never acceptable).
          await unlink(this.flushingOffsetPath).catch(() => undefined);
          await rename(this.activePath, this.flushingPath);
          this.flushingBytes = this.activeBytes;
          this.activeBytes = 0;
          this.flushingEvents = this.activeEvents;
          this.activeEvents = 0;
          this.flushingOldestMs = this.activeOldestMs;
          this.activeOldestMs = null;
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

      const producedCount = await this.produceFile(this.flushingPath);

      // Every line produced (produce-ack'd) — the WAL entries are now durable in the log.
      // File FIRST, sidecar second (see FLUSHING_OFFSET_FILE comment): a crash between the two
      // leaves a fileless sidecar that init()/rotate clean up — never a loss window.
      await unlink(this.flushingPath);
      await unlink(this.flushingOffsetPath).catch(() => undefined);
      const drained = this.flushingBytes;
      this.flushingBytes = 0;
      this.flushingEvents = 0;
      this.flushingOldestMs = null;
      log.info('fallback WAL flushed to the log', { bytes: drained, events: producedCount });
    } catch (err) {
      // Produce failed mid-file: keep the .flushing file; the next tick RESUMES from the
      // produced-line high-water sidecar (M4) — only unproduced lines are retried, so keyless
      // events are not physically duplicated. Residual at-least-once is bounded to one batch
      // (crash between a batch produce and its offset fsync — ADR-0015 D2 absorbs keyed events).
      incrementCounter('collector_wal_flush_failures_total');
      log.warn('fallback WAL flush failed — will retry from the produced-line offset', { err });
    } finally {
      this.flushing = false;
    }
  }

  /**
   * SIGTERM/preStop drain (ADR-0015 WAL durability posture): ONE final flushOnce() bounded by
   * `timeoutMs`. Returns 'drained' when the pass completed inside the deadline, 'timeout' when
   * the deadline elapsed first (the flush keeps running best-effort; anything unflushed stays
   * on disk and is adopted by init() on the next boot — crash-safe, alerted via the age gauge).
   */
  async drain(timeoutMs: number): Promise<'drained' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.flushOnce().then(() => 'drained' as const), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stream the file's JSONL lines and produce them in bounded batches, resuming AFTER the
   * produced-line high-water offset (M4) and advancing the fsync'd sidecar after each produced
   * batch. Throws on produce failure — produced lines up to the last sidecar write are never
   * replayed by the retry. The offset counts RAW lines consumed (produced + skipped torn/empty),
   * which is deterministic because the rotated file is immutable.
   */
  private async produceFile(path: string): Promise<number> {
    // Read the sidecar every pass: covers in-process retries AND next-boot adoption alike.
    const resumeAfterLine = await readOffsetSidecar(this.flushingOffsetPath);
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    let batch: ProduceMessage[] = [];
    let produced = 0;
    let linesConsumed = 0;
    try {
      for await (const line of rl) {
        linesConsumed += 1;
        // Already produce-ack'd in a previous pass — skip, never re-produce (the M4 fix).
        if (linesConsumed <= resumeAfterLine) continue;
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
        if (batch.length >= this.flushBatchLines) {
          produced += await this.produceBatchAndAdvance(batch, linesConsumed);
          batch = [];
        }
      }
      if (batch.length > 0) {
        // No sidecar write after the FINAL batch — completion unlinks file + sidecar next; a
        // crash in between re-produces at most this one batch (same bounded window as below).
        await this.producer.produceBatch(batch);
        produced += this.countFlushed(batch.length);
      }
      return produced;
    } finally {
      rl.close();
    }
  }

  /**
   * Produce one bounded batch, then fsync the produced-line high-water sidecar. A crash
   * BETWEEN the produce and the sidecar write re-produces at most this ONE batch on resume —
   * accepted: bounded, keyed events are absorbed by Bronze-compaction + Silver dedup, and the
   * alternative (offset before produce) would risk LOSS, which is never acceptable.
   */
  private async produceBatchAndAdvance(batch: ProduceMessage[], linesConsumed: number): Promise<number> {
    await this.producer.produceBatch(batch);
    await writeOffsetSidecar(this.flushingOffsetPath, linesConsumed);
    return this.countFlushed(batch.length);
  }

  /** Per-batch flushed accounting: exact under partial-file resume (counter + pending gauge). */
  private countFlushed(count: number): number {
    // WAL observability: entries that made it from the WAL onto the log (durability window
    // closed). Counted per produced batch — a later mid-file failure must not zero out what
    // this pass already drained.
    incrementCounter('collector_wal_flushed_total', {}, count);
    this.flushingEvents = Math.max(0, this.flushingEvents - count);
    return count;
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

/**
 * Read the produced-line high-water sidecar (M4). Absent/unreadable/garbage ⇒ 0 — the flush
 * replays from the top, which is the safe direction (bounded dupes, never loss).
 */
async function readOffsetSidecar(path: string): Promise<number> {
  try {
    const n = Number.parseInt(await readFile(path, 'utf8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Write + fsync the produced-line high-water sidecar (M4) — durable before the next batch. */
async function writeOffsetSidecar(path: string, lines: number): Promise<void> {
  const fh = await open(path, 'w');
  try {
    await fh.write(String(lines));
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0; // ENOENT — no WAL yet
  }
}

/**
 * File creation time (epoch ms) — the moment of the file's FIRST append, i.e. its oldest
 * entry. Used only for crash-adoption at init(); appends track exact timestamps in-process.
 * birthtime is 0/epoch on filesystems that don't record it → fall back to mtime (older than
 * the true oldest entry never — mtime is the LAST append — so the age gauge may under-read
 * on such filesystems, an accepted approximation for the boot-adoption path only).
 */
async function fileBirthMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    const birth = s.birthtimeMs;
    return Number.isFinite(birth) && birth > 0 ? birth : s.mtimeMs;
  } catch {
    return null;
  }
}

/** Count newline-terminated entries in a WAL file (boot-adoption only — bounded by the cap). */
async function countLines(path: string): Promise<number> {
  try {
    let count = 0;
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length > 0) count += 1;
    }
    return count;
  } catch {
    return 0; // ENOENT / unreadable — the byte accounting still drives saturation
  }
}
