/**
 * silver-identity — bounded FORWARD-SLICE watermark window (ADR-0015 open item #11).
 *
 * THE BUG CLASS THIS CLOSES (verified live 2026-07-18): the job reads Silver keystone
 * rows watermarked on the envelope `ingested_at` clock. The read is keyset-paginated
 * over the unindexed Iceberg-backed `mv_silver_collector_event` view with NO UPPER
 * BOUND on `ingested_at`. On a cold start the stored watermark is the epoch fallback,
 * so the old floor reached back the FULL catch-up gap (up to maxCatchup = 7 DAYS). For
 * a data-heavy brand that is the ENTIRE 7-day backlog (~400K+ rows, each needing per-row
 * JSON `payload` materialization) in one keyset sweep — even `LIMIT pageSize` forces
 * DuckDB to scan+sort the whole WHERE-matching set for the FIRST page. That read exceeds
 * duckdb-serving's HARD 25s server-side statement watchdog → the read aborts → the
 * brand's watermark is HELD → every subsequent run re-attempts the identical too-wide
 * read → STUCK FOREVER. Raising timeouts cannot fix it (the 25s ceiling protects
 * dashboards); the ONLY fix is bounding the per-run query cost.
 *
 * THE FIX — a bounded FORWARD-SLICE window with BOTH a floor and a per-run CEILING:
 *
 *   floor   = storedWatermark − lookbackMs   (bounded late-row re-cover margin, capped
 *                                             at now − maxCatchup so a first run / very
 *                                             stale watermark can't scan the whole world)
 *   ceiling = floor + maxSliceMs             (per-run WIDTH cap — reads at most maxSlice
 *                                             of ingested_at time per run, well under 25s)
 *   toMs    = min(now, ceiling)              (never read into the future)
 *
 * Every run reads exactly the slice `(floor, ceiling]`. On a CLEAN pass the caller
 * advances the watermark to the slice CEILING (`toIso`) — the whole (floor, ceiling]
 * window is processed, INCLUDING empty slices — so the next run's floor is
 * `ceiling − lookback`, which is FORWARD of this run's floor. The 5-min cron therefore
 * chews a cold-start backlog forward across ticks (7d ÷ 6h ≈ 28 ticks ≈ ~2.3h one-time
 * catch-up) and then settles into tiny steady-state reads. `sliced=true` signals the
 * backlog extends beyond this run's slice (ops sees it chewing forward, not stuck).
 *
 * ⚠️ WHY THE FLOOR IS `storedWm − lookback` AND NOT `storedWm − (gap + lookback)`:
 * the old self-healing floor re-covered the FULL gap since the watermark. Combined with
 * advancing the watermark to the ceiling, it would recompute the floor straight back to
 * the cap every run → re-read slice 1 forever, never progressing (a stuck-reset trap).
 * A BOUNDED `storedWm − lookback` floor means that as the watermark advances to each
 * slice's ceiling, the next run's floor advances FORWARD with it. The tradeoff: the
 * late-row re-cover window is now the bounded `lookbackMs` margin (a row that lands more
 * than `lookbackMs` behind the committed watermark still needs a manual FULL run) — and
 * a backlog older than `maxCatchup` is `clipped` and likewise needs a manual FULL run
 * (the SAME operator signal as today).
 *
 * Re-processing the slice overlap is SAFE: the whole identity stage is idempotent/
 * replay-safe (deterministic resolve, ON CONFLICT dirty-set writes, sliding-TTL cache
 * primes), so a re-read only costs read volume, never correctness.
 */

export interface WatermarkWindowInput {
  /** Wall-clock now (ms since epoch). */
  nowMs: number;
  /** Last committed per-brand watermark (ms since epoch; 0 = epoch fallback / first run). */
  storedWatermarkMs: number;
  /** Configured trailing late-row re-cover margin — SILVER_IDENTITY_LOOKBACK_MS. */
  lookbackMs: number;
  /** Catch-up cap measured back from now — SILVER_IDENTITY_MAX_CATCHUP_MS. */
  maxCatchupMs: number;
  /** Per-run slice WIDTH cap on ingested_at time — SILVER_IDENTITY_MAX_SLICE_MS. */
  maxSliceMs: number;
}

export interface WatermarkWindow {
  /** Window floor (ms since epoch, never negative). The run reads rows with ingested_at > this. */
  fromMs: number;
  /** Window floor as ISO-8601 (the serving-query keyset cursor seed). */
  fromIso: string;
  /** Window ceiling (ms since epoch) — the run reads rows with ingested_at <= this. */
  toMs: number;
  /** Window ceiling as ISO-8601 (bound into the read's `ingested_at <= ?` predicate). */
  toIso: string;
  /** How stale the watermark is vs now (ms, ≥ 0) — the catch-up gap remaining. */
  catchupGapMs: number;
  /** True when maxCatchupMs clipped the floor — operators must run a manual FULL pass. */
  clipped: boolean;
  /** True when the backlog extends beyond this run's slice ceiling (< now) — catch-up in progress. */
  sliced: boolean;
}

export function computeWatermarkWindow(input: WatermarkWindowInput): WatermarkWindow {
  const { nowMs, storedWatermarkMs, lookbackMs, maxCatchupMs, maxSliceMs } = input;
  // Clamp at 0 so clock skew (watermark ahead of now) degrades cleanly (no negative gap).
  const catchupGapMs = Math.max(0, nowMs - storedWatermarkMs);
  // Cap anchored at NOW: bounds the floor to the last maxCatchupMs even when the watermark
  // is the epoch fallback (rawFloor would be the epoch → an unbounded first-page scan).
  const capFloorMs = nowMs - maxCatchupMs;
  // BOUNDED late-row re-cover margin (NOT the whole gap — see the docstring's stuck-reset
  // trap). As the watermark advances slice by slice, this floor advances FORWARD with it.
  const rawFloorMs = storedWatermarkMs - lookbackMs;
  const clipped = rawFloorMs < capFloorMs;
  const fromMs = Math.max(0, Math.max(rawFloorMs, capFloorMs));
  // Per-run WIDTH cap: read at most maxSliceMs of ingested_at time. Never read into the future.
  const ceilingRawMs = fromMs + maxSliceMs;
  const toMs = Math.min(nowMs, ceilingRawMs);
  // Backlog remains beyond this run's slice — the cron chews it forward across ticks.
  const sliced = ceilingRawMs < nowMs;
  return {
    fromMs,
    fromIso: new Date(fromMs).toISOString(),
    toMs,
    toIso: new Date(toMs).toISOString(),
    catchupGapMs,
    clipped,
    sliced,
  };
}
