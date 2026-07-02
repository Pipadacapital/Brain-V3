/**
 * spool-backpressure — bounded admission gate for /collect (C4, R-09).
 *
 * THE FAILURE THIS PREVENTS: the collector ACKs every event by INSERTing into collector_spool
 * BEFORE returning 200 (D-1). The drainer pulls pending rows to Redpanda asynchronously. If the
 * drainer falls behind — Redpanda down, a produce stall, a traffic spike — the spool grows with
 * NO bound. Left unchecked it fills the Postgres volume, and a full disk takes down the spool
 * INSERT itself: the durability anchor fails closed for ALL tenants at once. An unbounded buffer
 * is not durability; it just moves the cliff.
 *
 * THE FIX: bound the backlog. When the pending depth crosses a high-water mark we shed load at the
 * door — 503 SPOOL_FULL + Retry-After — so clients back off and retry instead of us accepting
 * events we cannot safely persist. This is a REJECT-BEFORE-SPOOL admission gate (not validation),
 * so it does NOT violate D-1, exactly like the edge rate-limiter.
 *
 * DESIGN (solid, not a patch):
 *   • O(1) per request. The depth is sampled by a background interval (countPendingBounded), never
 *     queried on the hot path — a COUNT per request would itself pile load onto an already-struggling
 *     DB. The admission decision reads a cached boolean.
 *   • Hysteresis. We TRIP at `maxPending` and only CLEAR once depth recedes below `resumePending`
 *     (< maxPending). Without a gap the gate would flap open/closed at the boundary, alternately
 *     admitting and rejecting on every sample.
 *   • Fail-OPEN on a sampler hiccup. A transient COUNT error keeps the LAST known state rather than
 *     fabricating "full" — a real DB outage already surfaces as a 500 from the spool INSERT, so we
 *     never reject healthy traffic over a single failed gauge read.
 *
 * The pure state machine (applySample/admit/snapshot) is timer- and DB-free so it unit-tests
 * deterministically; the sampler loop only wires countPendingBounded → applySample on an interval.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { incrementCounter } from '@brain/observability';
import type { SpoolRepository } from '../../domain/ingest/repositories/spool.repository.js';
import { GUARDED_INGEST_ROUTES } from './edge-guard.js';

export interface SpoolBackpressureConfig {
  /** High-water mark: at or above this pending depth, TRIP back-pressure (start rejecting). */
  maxPending: number;
  /** Low-water mark: below this pending depth, CLEAR back-pressure. Must be < maxPending. */
  resumePending: number;
  /** Background gauge refresh cadence (ms). */
  sampleIntervalMs: number;
  /** Retry-After header value (seconds) sent on a 503 SPOOL_FULL. */
  retryAfterSeconds: number;
}

export interface SpoolBackpressureSnapshot {
  pendingDepth: number;
  tripped: boolean;
}

export class SpoolBackpressure {
  private pendingDepth = 0;
  private tripped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly spool: SpoolRepository,
    private readonly cfg: SpoolBackpressureConfig,
    private readonly onError?: (err: unknown) => void,
  ) {
    if (cfg.resumePending >= cfg.maxPending) {
      throw new Error(
        `[spool-backpressure] resumePending (${cfg.resumePending}) must be < maxPending (${cfg.maxPending}) for hysteresis`,
      );
    }
  }

  /**
   * Apply one observed depth to the hysteresis state machine. PURE (no I/O, no clock):
   *   • depth >= maxPending      → TRIP (reject new events).
   *   • depth <  resumePending   → CLEAR (admit again).
   *   • in-between (the deadband) → hold the current state (this is the anti-flap gap).
   */
  applySample(depth: number): void {
    this.pendingDepth = depth;
    if (depth >= this.cfg.maxPending) {
      this.tripped = true;
    } else if (depth < this.cfg.resumePending) {
      this.tripped = false;
    }
    // else: within the deadband — keep `tripped` as-is.
  }

  /** Admission decision — true = admit, false = shed (503). O(1), reads the cached gauge. */
  admit(): boolean {
    return !this.tripped;
  }

  get retryAfterSeconds(): number {
    return this.cfg.retryAfterSeconds;
  }

  snapshot(): SpoolBackpressureSnapshot {
    return { pendingDepth: this.pendingDepth, tripped: this.tripped };
  }

  /** Sample the spool depth once (bounded at maxPending+1 so the count is O(maxPending)). */
  async sampleOnce(): Promise<void> {
    try {
      const depth = await this.spool.countPendingBounded(this.cfg.maxPending + 1);
      this.applySample(depth);
    } catch (err) {
      // Fail-open: keep the last known state. A real DB outage surfaces as a 500 on INSERT;
      // a flaky single COUNT must not start rejecting healthy traffic.
      this.onError?.(err);
    }
  }

  /** Start the background sampler. Primes the gauge immediately, then refreshes on an interval. */
  async start(): Promise<void> {
    await this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), this.cfg.sampleIntervalMs);
    // Do not let the sampler keep the event loop alive on shutdown.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Register the back-pressure gate as a preHandler scoped to the ingest endpoints.
 * Runs reject-before-spool: a tripped gauge sheds the request with 503 SPOOL_FULL + Retry-After
 * BEFORE AcceptEventUseCase inserts (D-1 still holds — admission control, not validation).
 */
export function registerSpoolBackpressure(app: FastifyInstance, gate: SpoolBackpressure): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Route-PATTERN match (query-string-free) over the full ingest set incl. /batch — raw req.url
    // equality would let `/collect?x=1` or a /batch POST bypass the gate (AUD-PERF-001).
    if (req.method !== 'POST' || !GUARDED_INGEST_ROUTES.has(req.routeOptions.url ?? '')) return;
    if (gate.admit()) return;

    // Shed counter backs the collector SLO burn-rate + back-pressure alerts (C2 / R-05).
    incrementCounter('collector_spool_full_total');
    await reply
      .code(503)
      .header('Retry-After', String(gate.retryAfterSeconds))
      .send({ accepted: false, error: { code: 'SPOOL_FULL' } });
  });
}
