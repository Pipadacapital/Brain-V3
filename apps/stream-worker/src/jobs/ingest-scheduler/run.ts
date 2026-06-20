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
 *   4. RATE-LIMIT SAFETY — connectors are dispatched SEQUENTIALLY within a tick (a
 *      plain for-loop, never Promise.all) so we never fan a burst at one provider; the
 *      per-page throttle (REPULL_PAGE_SLEEP_MS) inside each run() is respected. The
 *      inFlight guard means a long tick never re-enters. A >=15s interval floor
 *      prevents a misconfigured stampede.
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
  enumerateConnectedConnectors,
  loadRun,
} from '../sync-request-claimer/run.js';
import { withTickLeaderLock, LEADER_LOCK_INGEST_SCHEDULER } from '../../infrastructure/pg/LeaderLock.js';
import { incrementCounter } from '@brain/observability';
import { log } from "../../log.js";

/** Hard floor on the interval — prevents a misconfigured env from stampeding providers. */
export const MIN_INTERVAL_MS = 15_000;

/** Default interval — within the requirement's 30–60s near-real-time band (§3.3). */
export const DEFAULT_INTERVAL_MS = 45_000;

/**
 * One scheduler tick: enumerate every connected connector across every brand and
 * dispatch each one's existing repull run() — sequential, fail-isolated, overlap-safe.
 * Returns the number of connectors successfully dispatched (a run() that threw or was
 * overlap-skipped is NOT counted as a clean dispatch but never stops the tick).
 */
export async function tick(pool: Pool): Promise<number> {
  const connectors = await enumerateConnectedConnectors(pool);
  const brandCount = new Set(connectors.map((c) => c.brand_id)).size;
  log.info(`tick start brands=${brandCount} connectors=${connectors.length}`);

  let dispatched = 0;
  // SEQUENTIAL dispatch (never Promise.all) — rate-limit-safe; one provider at a time.
  for (const connector of connectors) {
    const run = await loadRun(connector.provider);
    if (!run) {
      log.warn(`[ingest-scheduler] no repull run() for provider=${connector.provider} ` +
                  `connector=${connector.connector_instance_id}`);
      continue;
    }

    log.info(`[ingest-scheduler] dispatched provider=${connector.provider} ` +
              `brand=${connector.brand_id} connector=${connector.connector_instance_id}`);
    try {
      // Same-code-path as the on-demand claimer. run()'s OWN FOR UPDATE SKIP LOCKED
      // overlap-lock guarantees no double-run with a manual click or a previous tick.
      await run(connector.connector_instance_id);
      dispatched++;
      // P1: per-provider dispatch metric — the scale-limiting tier's throughput signal.
      incrementCounter('ingest_scheduler_dispatch_total', { provider: connector.provider });
    } catch (err) {
      // FAIL-ISOLATION: one bad/slow connector is logged and skipped — the loop
      // continues. run() persists connector_sync_status.state='error' itself.
      incrementCounter('ingest_scheduler_dispatch_error_total', { provider: connector.provider });
      log.error(`[ingest-scheduler] repull run failed provider=${connector.provider} ` +
                  `connector=${connector.connector_instance_id}`, { err: err });
    }
  }

  log.info(`tick done dispatched=${dispatched}/${connectors.length}`);
  return dispatched;
}

export interface IngestScheduler {
  stop(): Promise<void>;
}

/**
 * Start the continuous ingestion scheduler. Returns a handle with stop() for graceful
 * shutdown (mirrors startSyncRequestClaimer / startDqChecks).
 *
 * @param pool        MUST be a brain_app pool (RLS FORCE) — never superuser 'brain'.
 * @param intervalMs  Poll interval; clamped to >= MIN_INTERVAL_MS (stampede floor).
 */
export function startIngestScheduler(
  pool: Pool,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): IngestScheduler {
  const effectiveInterval = Math.max(intervalMs, MIN_INTERVAL_MS);
  if (effectiveInterval !== intervalMs) {
    log.warn(`interval ${intervalMs}ms below floor — clamped to ${effectiveInterval}ms`);
  }

  let running = true;
  let inFlight = false;

  const loop = async (): Promise<void> => {
    while (running) {
      if (!inFlight) {
        inFlight = true;
        try {
          // P1: single-leader across replicas — only the lock winner runs the dispatch tick, so the
          // connector API load is 1× (not N×). Non-leaders skip cheaply and retry next interval.
          const started = Date.now();
          const out = await withTickLeaderLock(pool, LEADER_LOCK_INGEST_SCHEDULER, () => tick(pool));
          // P1 instrumentation — the scale-limiting tier's first-to-fail signals. tick-overrun is the
          // canary the audit flagged (BrainIngestStale only fires at TOTAL zero, never on degradation):
          // once a sequential tick can't finish within its interval, ingest freshness silently slips.
          incrementCounter('ingest_scheduler_tick_total', { role: out.ranAsLeader ? 'leader' : 'follower' });
          if (out.ranAsLeader) {
            const durationMs = Date.now() - started;
            if (durationMs >= effectiveInterval) {
              incrementCounter('ingest_scheduler_tick_overrun_total', {});
              log.warn(`[ingest-scheduler] TICK OVERRUN ${durationMs}ms >= interval ${effectiveInterval}ms — ingest freshness degrading; shard/scale the worker tier`);
            }
          }
        } catch (err) {
          // Tick-level guard (enumerate failure etc.) — never lets the loop die.
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
