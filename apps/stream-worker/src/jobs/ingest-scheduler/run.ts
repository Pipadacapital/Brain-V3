/**
 * ingest-scheduler/run.ts — the CONTINUOUS near-real-time ingestion scheduler
 * (feat-realtime-ingestion-pipeline / architecture §3.3, Track A — data-engineer).
 *
 * NOT a new deployable / topic / envelope. An interval loop wired into the already-
 * running apps/stream-worker/src/main.ts, structurally identical to
 * startSyncRequestClaimer / startDqChecks. It turns "ingest every brand × every
 * connected connector on a short interval" into the SAME run(connectorInstanceId)
 * the on-demand claimer invokes — the "same code path", live + scheduled converge.
 *
 * Per-tick algorithm (REUSES existing primitives — re-implements NOTHING):
 *   1. enumerateConnectedConnectors(pool) — the EXACT export from the on-demand
 *      claimer. Covers shopify + razorpay + meta + google_ads across ALL brands via
 *      the three SECURITY-DEFINER enumerate fns. No GUC at this step (discovery only);
 *      fail-closed under brain_app — the fns are the ONLY way to see the rows.
 *   2. For each connector row {connector_instance_id, brand_id, provider}:
 *      loadRun(provider) → dispatch run(connector_instance_id) inside a per-connector
 *      try/catch (FAIL-ISOLATION — one throw is logged, the loop continues; run()
 *      writes connector_sync_status.state='error' itself).
 *   3. OVERLAP SAFETY IS FREE — each run() already calls acquireRepullLock
 *      (FOR UPDATE SKIP LOCKED). A tick that overlaps a still-running repull (or the
 *      manual claimer) finds the row locked and SKIPs. The scheduler adds NO new lock.
 *   4. RATE-LIMIT SAFETY — connectors are dispatched with a BOUNDED-CONCURRENCY worker pool
 *      (REPULL_DISPATCH_CONCURRENCY, default 8) — parallel for throughput (one slow vendor no
 *      longer blocks the rest, so a tick of N connectors costs ~max-chain, not the sum), but
 *      capped so we never fan an unbounded burst. The per-provider global cap (rateLimiter,
 *      atomic Redis) still gates EACH provider regardless of dispatch parallelism, and the
 *      per-page throttle inside each run() is respected. The inFlight guard means a long tick
 *      never re-enters. A >=15s interval floor prevents a misconfigured stampede.
 *
 * ISOLATION: the scheduler pool is brain_app (RLS FORCE), never superuser 'brain'. It
 * sets NO GUC itself — enumerate is GUC-less via SECURITY DEFINER; every brand-scoped
 * read/write happens INSIDE run() under that run's own GUC-after-enumerate. The
 * scheduler therefore never holds a brand context and cannot leak across brands (MT-1).
 *
 * Token / salt are NEVER logged (I-S09) — log only provider + brand + connector id.
 * Tier-0 deterministic (no model/agent/statistical call; $0/mo incremental).
 */

import { Pool } from 'pg';
import {
  claimDueRepullConnectors,
  loadRun,
} from '../sync-request-claimer/run.js';
import { incrementCounter } from '@brain/observability';
import { loadStreamWorkerConfig } from '@brain/config';
import type { IConnectorRateLimiter } from '../../infrastructure/redis/ConnectorRateLimiter.js';
import { log } from "../../log.js";

/**
 * Maximum wall-clock budget for a single connector dispatch inside the tick.
 * A connector that hangs here (e.g. a vendor whose circuit breaker has not yet opened)
 * cannot stall the entire tick for all other connectors — the per-dispatch deadline races
 * the run() call and throws, causing the loop's per-connector catch to log+skip it.
 * Default: 5 minutes (generous; individual vendor-client calls already carry AbortSignal
 * timeouts; this is the tick-level backstop against pathological hangs).
 */
export const DISPATCH_DEADLINE_MS = 5 * 60 * 1000;

/** Hard floor on the interval — prevents a misconfigured env from stampeding providers. */
export const MIN_INTERVAL_MS = 15_000;

/** Default interval — within the requirement's 30–60s near-real-time band (§3.3). */
export const DEFAULT_INTERVAL_MS = 45_000;

/** Max connectors a single replica claims per tick (bounds per-tick work; the rest drain next tick). */
export const DEFAULT_CLAIM_BATCH = 100;

/**
 * Default in-tick dispatch concurrency. The claimed batch is processed by a bounded pool of this
 * many workers instead of one serial loop, so repulls (which are dominated by live vendor-API
 * latency) run in parallel and a tick of N connectors costs ~the slowest single chain rather than
 * the SUM — the fix for TICK OVERRUN when many connectors come due at once. Bounded (not unbounded
 * Promise.all) so we never fan a huge burst; the per-provider rateLimiter still gates each provider.
 * Override via REPULL_DISPATCH_CONCURRENCY (clamped 1..32).
 */
export const DEFAULT_DISPATCH_CONCURRENCY = 8;

/** Resolve the in-tick dispatch concurrency from env (REPULL_DISPATCH_CONCURRENCY), clamped 1..32. */
export function resolveDispatchConcurrency(): number {
  const env = loadStreamWorkerConfig().REPULL_DISPATCH_CONCURRENCY;
  const parsed = env ? parseInt(env, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, 32);
  return DEFAULT_DISPATCH_CONCURRENCY;
}

interface ClaimedConnector {
  connector_instance_id: string;
  brand_id: string;
  provider: string;
}

/**
 * Dispatch ONE connector's repull: loadRun → per-provider rate-limit gate → deadline-bounded run()
 * → metrics. Returns true iff the repull was dispatched (false = no run() for provider, rate-limited,
 * or errored). FAIL-ISOLATED: an error is logged + counted and swallowed (run() persists
 * connector_sync_status.state='error' itself), so one bad connector never breaks the pool.
 */
async function dispatchOne(
  connector: ClaimedConnector,
  rateLimiter?: IConnectorRateLimiter,
): Promise<boolean> {
  const run = await loadRun(connector.provider);
  if (!run) {
    log.warn(`[ingest-scheduler] no repull run() for provider=${connector.provider} ` +
                `connector=${connector.connector_instance_id}`);
    return false;
  }

  // P1: global cross-replica per-provider cap (atomic Redis) — safe under parallel dispatch. Over the
  // provider's quota → skip (the connector stays stamped + re-pulls next interval). Fail-open.
  if (rateLimiter && !(await rateLimiter.tryAcquire(connector.provider))) {
    incrementCounter('ingest_scheduler_rate_limited_total', { provider: connector.provider });
    log.warn(`[ingest-scheduler] rate-limited provider=${connector.provider} connector=${connector.connector_instance_id} — skipped this tick`);
    return false;
  }

  log.info(`[ingest-scheduler] dispatched provider=${connector.provider} ` +
            `brand=${connector.brand_id} connector=${connector.connector_instance_id}`);
  try {
    // run()'s OWN FOR UPDATE SKIP LOCKED overlap-lock guards against a manual "sync now" racing the
    // claimed repull. A per-dispatch deadline races the call — a connector that hangs past
    // DISPATCH_DEADLINE_MS is aborted + counted as an error so it cannot stall its pool slot forever.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new Error(
          `[ingest-scheduler] dispatch deadline exceeded provider=${connector.provider} ` +
          `connector=${connector.connector_instance_id} limit=${DISPATCH_DEADLINE_MS}ms`,
        ));
      }, DISPATCH_DEADLINE_MS);
    });
    try {
      await Promise.race([run(connector.connector_instance_id), deadlinePromise]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
    incrementCounter('ingest_scheduler_dispatch_total', { provider: connector.provider });
    return true;
  } catch (err) {
    incrementCounter('ingest_scheduler_dispatch_error_total', { provider: connector.provider });
    log.error(`[ingest-scheduler] repull run failed provider=${connector.provider} ` +
                `connector=${connector.connector_instance_id}`, { err: err });
    return false;
  }
}

/**
 * One scheduler tick (P1 work-queue): CLAIM a disjoint batch of DUE connectors (FOR UPDATE SKIP
 * LOCKED via claim_due_repull_connectors, 0053) — NOT enumerate-everything — and dispatch each
 * one's existing repull run(). Because the claim is atomic + stamps next_repull_at ahead, every
 * replica claims a DIFFERENT batch: the scheduler is now PARALLEL across replicas (no ordinals),
 * naturally load-balanced, each connector dispatched at most once per interval. Fail-isolated.
 * Returns the number of connectors successfully dispatched.
 */
export async function tick(
  pool: Pool,
  batch: number,
  intervalSeconds: number,
  rateLimiter?: IConnectorRateLimiter,
): Promise<number> {
  const connectors = await claimDueRepullConnectors(pool, batch, intervalSeconds);
  if (connectors.length === 0) {
    return 0; // nothing due — another replica took the batch, or all connectors are up to date
  }
  const brandCount = new Set(connectors.map((c) => c.brand_id)).size;
  const concurrency = Math.min(resolveDispatchConcurrency(), connectors.length);
  log.info(`tick start claimed=${connectors.length} brands=${brandCount} concurrency=${concurrency}`);

  // BOUNDED-CONCURRENCY POOL: `concurrency` workers each pull the next connector off a shared cursor
  // and dispatch it, until the claimed batch is drained. Parallel (a slow vendor no longer blocks the
  // rest — tick cost ≈ slowest single chain, not the SUM, which is the TICK OVERRUN fix), but capped
  // so we never fan an unbounded burst. Per-connector dispatchOne is fully fail-isolated; the
  // per-provider rateLimiter (atomic) still gates each provider regardless of parallelism. The
  // shared `nextIdx`/`dispatched` increments are safe on Node's single-threaded loop.
  let dispatched = 0;
  let nextIdx = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIdx;
      nextIdx += 1;
      if (i >= connectors.length) return;
      const ok = await dispatchOne(connectors[i]!, rateLimiter);
      if (ok) dispatched += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  log.info(`tick done dispatched=${dispatched}/${connectors.length}`);
  return dispatched;
}

export interface IngestScheduler {
  stop(): Promise<void>;
}

/**
 * Start the continuous ingestion scheduler (P1 work-queue). Every `intervalMs` each replica claims
 * up to `batch` DUE connectors and dispatches them — replicas process DISJOINT batches in parallel,
 * so total throughput scales with replica count (no single-leader bottleneck, no ordinals). The
 * next_repull_at spacing equals the loop interval, so each connector is re-pulled ~every interval.
 *
 * @param pool        MUST be a brain_app pool (RLS FORCE) — never superuser 'brain'.
 * @param intervalMs  Poll/repull interval; clamped to >= MIN_INTERVAL_MS (stampede floor).
 * @param batch       Max connectors claimed per tick per replica.
 */
export function startIngestScheduler(
  pool: Pool,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  batch: number = DEFAULT_CLAIM_BATCH,
  rateLimiter?: IConnectorRateLimiter,
): IngestScheduler {
  const effectiveInterval = Math.max(intervalMs, MIN_INTERVAL_MS);
  if (effectiveInterval !== intervalMs) {
    log.warn(`interval ${intervalMs}ms below floor — clamped to ${effectiveInterval}ms`);
  }
  const intervalSeconds = Math.round(effectiveInterval / 1000);

  let running = true;
  let inFlight = false;

  const loop = async (): Promise<void> => {
    while (running) {
      if (!inFlight) {
        inFlight = true;
        try {
          const started = Date.now();
          const dispatched = await tick(pool, batch, intervalSeconds, rateLimiter);
          incrementCounter('ingest_scheduler_tick_total', { role: 'worker' });
          // P1 instrumentation — tick-overrun is the canary (BrainIngestStale only fires at TOTAL
          // zero, never on degradation): a replica's claimed batch can't finish within the interval
          // → freshness slipping. Only meaningful when it actually had work.
          const durationMs = Date.now() - started;
          if (dispatched > 0 && durationMs >= effectiveInterval) {
            incrementCounter('ingest_scheduler_tick_overrun_total', {});
            log.warn(`[ingest-scheduler] TICK OVERRUN ${durationMs}ms >= interval ${effectiveInterval}ms — freshness degrading; add replicas or lower the claim batch`);
          }
        } catch (err) {
          // Tick-level guard (claim failure etc.) — never lets the loop die.
          log.error('tick error', { err: err });
        } finally {
          inFlight = false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, effectiveInterval));
    }
  };

  void loop();

  return {
    stop: async (): Promise<void> => {
      running = false;
    },
  };
}
