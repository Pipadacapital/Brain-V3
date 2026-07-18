/**
 * silver-identity watermark window — unit tests (ADR-0015 open item #11).
 *
 * Proves the BOUNDED FORWARD-SLICE math: each run reads at most a maxSlice-wide slice
 * `(from, to]` with a BOUNDED lookback floor, bounded above by min(now, floor + maxSlice)
 * and below by now − maxCatchup (a cold-start / very-stale floor is clipped, flagged
 * `clipped=true` so the caller warns + counts silver_identity_catchup_clipped_total).
 *
 * THE ANTI-REGRESSION TEST is `forward progress`: advancing the watermark to the slice
 * ceiling must move the NEXT run's window FORWARD (floor + ceiling both increase), never
 * reset it back to the cap — the stuck-reset trap the pre-fix full-gap floor caused.
 *
 * Pure function — no clock, no IO. Follows the silver-identity suites' fake-free
 * pattern (see silver-identity-side-effects.unit.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { computeWatermarkWindow } from '../jobs/silver-identity/watermark-window.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const LOOKBACK = 30 * MIN; // SILVER_IDENTITY_LOOKBACK_MS default
const MAX_CATCHUP = 7 * DAY; // SILVER_IDENTITY_MAX_CATCHUP_MS default
const SLICE = 6 * HOUR; // SILVER_IDENTITY_MAX_SLICE_MS default
const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function win(storedWatermarkMs: number, nowMs = NOW) {
  return computeWatermarkWindow({
    nowMs,
    storedWatermarkMs,
    lookbackMs: LOOKBACK,
    maxCatchupMs: MAX_CATCHUP,
    maxSliceMs: SLICE,
  });
}

describe('computeWatermarkWindow (bounded forward-slice)', () => {
  it('cold start (wm=0): floor clips to now − maxCatchup, ceiling = floor + slice, sliced', () => {
    const w = win(0); // EPOCH_ISO parses to 0
    expect(w.fromMs).toBe(NOW - MAX_CATCHUP); // cap anchored at NOW bounds the first-page scan
    expect(w.toMs).toBe(w.fromMs + SLICE); // per-run WIDTH cap → not the whole 7d backlog
    expect(w.clipped).toBe(true); // rows below the cap need a manual FULL pass
    expect(w.sliced).toBe(true); // backlog extends beyond this run's slice
    expect(w.toMs).toBeLessThan(NOW);
    expect(w.fromIso).toBe(new Date(w.fromMs).toISOString());
    expect(w.toIso).toBe(new Date(w.toMs).toISOString());
  });

  it('FORWARD PROGRESS: advancing wm to the ceiling moves the next window forward, not reset (anti-regression)', () => {
    // Run 1: cold start.
    const run1 = win(0);
    expect(run1.fromMs).toBe(NOW - MAX_CATCHUP);

    // Operator/clean pass advances the watermark to the slice CEILING (window.toIso in run.ts).
    // Feed that as run 2's stored watermark.
    const run2 = win(run1.toMs);
    // The window MOVED FORWARD — it did NOT reset to the cap (the stuck-reset trap).
    expect(run2.fromMs).toBeGreaterThan(run1.fromMs);
    expect(run2.toMs).toBeGreaterThan(run1.toMs);
    // Concretely: floor = ceiling − lookback, ceiling = floor + slice.
    expect(run2.fromMs).toBe(run1.toMs - LOOKBACK);
    expect(run2.toMs).toBe(run2.fromMs + SLICE);

    // Chain a third: still marching forward toward now.
    const run3 = win(run2.toMs);
    expect(run3.fromMs).toBeGreaterThan(run2.fromMs);
    expect(run3.toMs).toBeGreaterThan(run2.toMs);

    // Convergence: iterate to steady state — advancing to the ceiling each time reaches now
    // in a bounded number of ticks (7d ÷ 6h slices ≈ 28), then stops slicing.
    let wm = 0;
    let ticks = 0;
    let last = win(wm);
    while (last.sliced && ticks < 100) {
      wm = last.toMs; // clean pass advances to the ceiling
      const next = win(wm);
      expect(next.fromMs).toBeGreaterThan(last.fromMs); // strictly forward every tick
      last = next;
      ticks += 1;
    }
    expect(last.sliced).toBe(false); // reached now — steady state, no more backlog
    expect(ticks).toBeLessThanOrEqual(30); // ~28 ticks for a 7d backlog at 6h slices
    expect(ticks).toBeGreaterThan(20);
  });

  it('steady state (wm ≈ now): degrades to a small [now − lookback, now] window, not sliced', () => {
    const wm = NOW - 5 * MIN; // healthy pipeline, watermark ~5min behind
    const w = win(wm);
    expect(w.catchupGapMs).toBe(5 * MIN);
    expect(w.fromMs).toBe(wm - LOOKBACK); // BOUNDED lookback floor (not the full gap)
    // ceiling = floor + slice would overshoot now → clamped to now.
    expect(w.toMs).toBe(NOW);
    expect(w.sliced).toBe(false); // no backlog beyond this run
    expect(w.clipped).toBe(false);
  });

  it('clipped when rawFloor (wm − lookback) < capFloor (now − maxCatchup)', () => {
    const wm = NOW - 10 * DAY; // stale beyond the cap
    const w = win(wm);
    expect(w.catchupGapMs).toBe(10 * DAY);
    expect(w.fromMs).toBe(NOW - MAX_CATCHUP); // floor clipped to the cap
    expect(w.clipped).toBe(true); // caller must warn + bump silver_identity_catchup_clipped_total
    expect(w.sliced).toBe(true); // and it's still slicing forward from the clipped floor
  });

  it('NOT clipped when the bounded floor sits inside the cap', () => {
    const wm = NOW - DAY; // 1d stale — floor = wm − 30m is well inside now − 7d
    const w = win(wm);
    expect(w.fromMs).toBe(wm - LOOKBACK);
    expect(w.clipped).toBe(false);
    expect(w.sliced).toBe(true); // 1d backlog > 6h slice
  });

  it('clock skew (watermark ahead of now): floor clamps sanely, gap is 0', () => {
    const wm = NOW + 10 * MIN;
    const w = win(wm);
    expect(w.catchupGapMs).toBe(0); // never negative
    expect(w.fromMs).toBe(wm - LOOKBACK); // floor is wm − lookback (still ahead of now − maxCatchup)
    expect(w.toMs).toBe(NOW); // ceiling clamps to now — never reads into the future
    expect(w.sliced).toBe(false); // floor + slice overshoots now
    expect(w.clipped).toBe(false);
  });

  it('floor never goes below 0 even with a tiny now', () => {
    const w = computeWatermarkWindow({
      nowMs: 1_000,
      storedWatermarkMs: 0,
      lookbackMs: LOOKBACK,
      maxCatchupMs: MAX_CATCHUP,
      maxSliceMs: SLICE,
    });
    expect(w.fromMs).toBe(0);
    expect(w.toMs).toBe(1_000); // ceiling clamps to now
    expect(w.clipped).toBe(false); // capFloor is negative → nothing clipped, epoch floor stands
  });
});
