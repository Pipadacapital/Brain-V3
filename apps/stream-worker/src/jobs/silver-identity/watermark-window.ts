/**
 * silver-identity — self-healing watermark catch-up window (ADR-0015 open edge case #2).
 *
 * THE BUG CLASS THIS CLOSES: the job reads Silver keystone rows watermarked on the
 * envelope `ingested_at` clock with a FIXED trailing lookback. `ingested_at` is the
 * collector ingest clock, NOT the Silver commit clock — rows land in Silver late
 * (Connect outage, paused refresh cron, backlogged transform). With a fixed lookback,
 * any row that lands more than `SILVER_IDENTITY_LOOKBACK_MS` behind the stored
 * watermark falls below the next run's window floor and is SKIPPED FOREVER.
 *
 * THE FIX: make the effective lookback self-healing —
 *
 *   effectiveLookback = max(lookbackMs, (now − storedWatermark) + lookbackMs)
 *
 * i.e. the window always re-covers everything since the last successfully committed
 * watermark PLUS the configured margin, so a stalled pipeline auto-catches-up on the
 * next run instead of skipping. (When the pipeline is healthy, now ≈ watermark and
 * this degrades to exactly the old fixed-lookback window.)
 *
 * The window is CAPPED at `maxCatchupMs` measured back from NOW (bounds a pathological
 * first-run / very-stale scan, e.g. a brand whose watermark is the epoch fallback).
 * When the cap clips the window, `clipped=true` — the caller MUST log loudly and bump
 * the `silver_identity_catchup_clipped_total` counter so operators know rows older
 * than the clipped floor are NOT covered and a manual FULL run is required.
 *
 * Re-processing overlap is SAFE: the whole identity stage is idempotent/replay-safe
 * (deterministic resolve, ON CONFLICT dirty-set writes, sliding-TTL cache primes), so
 * a wider window only costs read volume, never correctness.
 */

export interface WatermarkWindowInput {
  /** Wall-clock now (ms since epoch). */
  nowMs: number;
  /** Last committed per-brand watermark (ms since epoch; 0 = epoch fallback / first run). */
  storedWatermarkMs: number;
  /** Configured trailing margin — SILVER_IDENTITY_LOOKBACK_MS. */
  lookbackMs: number;
  /** Catch-up cap measured back from now — SILVER_IDENTITY_MAX_CATCHUP_MS. */
  maxCatchupMs: number;
}

export interface WatermarkWindow {
  /** Window floor (ms since epoch, never negative). The run reads rows with ingested_at > this. */
  fromMs: number;
  /** Window floor as ISO-8601 (the serving-query cursor seed). */
  fromIso: string;
  /** The self-healed lookback actually requested (pre-cap), for observability. */
  effectiveLookbackMs: number;
  /** How stale the watermark is vs now (ms, ≥ 0) — the catch-up gap being re-covered. */
  catchupGapMs: number;
  /** True when maxCatchupMs clipped the floor — operators must run a manual FULL pass. */
  clipped: boolean;
}

export function computeWatermarkWindow(input: WatermarkWindowInput): WatermarkWindow {
  const { nowMs, storedWatermarkMs, lookbackMs, maxCatchupMs } = input;
  // Clamp at 0 so clock skew (watermark ahead of now) degrades to the plain fixed lookback.
  const catchupGapMs = Math.max(0, nowMs - storedWatermarkMs);
  // Self-healing lookback: re-cover everything since the last committed watermark + margin.
  const effectiveLookbackMs = Math.max(lookbackMs, catchupGapMs + lookbackMs);
  const rawFromMs = storedWatermarkMs - effectiveLookbackMs;
  // Cap anchored at NOW: bounds the scan to the last maxCatchupMs even when the
  // watermark is the epoch fallback (rawFrom would be the epoch → unbounded scan).
  const capFloorMs = nowMs - maxCatchupMs;
  const clipped = rawFromMs < capFloorMs;
  const fromMs = Math.max(0, clipped ? capFloorMs : rawFromMs);
  return {
    fromMs,
    fromIso: new Date(fromMs).toISOString(),
    effectiveLookbackMs,
    catchupGapMs,
    clipped,
  };
}
