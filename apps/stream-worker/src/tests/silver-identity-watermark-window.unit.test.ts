/**
 * silver-identity watermark window — unit tests (ADR-0015 open edge case #2).
 *
 * Proves the SELF-HEALING catch-up math: the read window always re-covers everything
 * since the last committed watermark plus the configured margin (a stalled landing /
 * paused cron auto-catches-up on the next run instead of skipping late-landed rows
 * forever), bounded by SILVER_IDENTITY_MAX_CATCHUP_MS anchored at NOW (a pathological
 * first-run / very-stale scan is clipped, flagged `clipped=true` so the caller warns +
 * counts silver_identity_catchup_clipped_total).
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
const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function win(storedWatermarkMs: number, nowMs = NOW) {
  return computeWatermarkWindow({
    nowMs,
    storedWatermarkMs,
    lookbackMs: LOOKBACK,
    maxCatchupMs: MAX_CATCHUP,
  });
}

describe('computeWatermarkWindow (self-healing catch-up)', () => {
  it('normal cadence (watermark ~5min behind now): window = watermark − (gap + lookback), unclipped', () => {
    const wm = NOW - 5 * MIN;
    const w = win(wm);
    // effectiveLookback = gap(5m) + lookback(30m) → re-covers the full since-last-run span + margin.
    expect(w.catchupGapMs).toBe(5 * MIN);
    expect(w.effectiveLookbackMs).toBe(5 * MIN + LOOKBACK);
    expect(w.fromMs).toBe(wm - (5 * MIN + LOOKBACK));
    expect(w.clipped).toBe(false);
    // Always at least as wide as the old fixed-lookback window (never narrower → never skips more).
    expect(w.fromMs).toBeLessThanOrEqual(wm - LOOKBACK);
  });

  it('stalled 2h (Connect outage / paused cron): window stretches to re-cover the whole stall + margin', () => {
    const wm = NOW - 2 * HOUR;
    const w = win(wm);
    expect(w.catchupGapMs).toBe(2 * HOUR);
    expect(w.effectiveLookbackMs).toBe(2 * HOUR + LOOKBACK);
    // Floor reaches BELOW the watermark by the stall duration + margin — rows that landed
    // late (ingested_at older than wm − lookback) are re-covered, not skipped forever.
    expect(w.fromMs).toBe(wm - (2 * HOUR + LOOKBACK));
    expect(w.fromMs).toBe(NOW - (4 * HOUR + LOOKBACK)); // == now − (2·gap + lookback) with gap=2h
    expect(w.clipped).toBe(false);
    expect(w.fromIso).toBe(new Date(w.fromMs).toISOString());
  });

  it('stalled beyond the cap (10 days): floor clips to now − maxCatchup and flags clipped', () => {
    const wm = NOW - 10 * DAY;
    const w = win(wm);
    expect(w.catchupGapMs).toBe(10 * DAY);
    expect(w.effectiveLookbackMs).toBe(10 * DAY + LOOKBACK); // pre-cap request, kept for observability
    expect(w.fromMs).toBe(NOW - MAX_CATCHUP); // cap anchored at NOW bounds the scan
    expect(w.clipped).toBe(true); // caller must warn + bump silver_identity_catchup_clipped_total
  });

  it('first run (epoch fallback watermark): scan bounded to now − maxCatchup, clipped (manual FULL run needed)', () => {
    const w = win(0); // EPOCH_ISO parses to 0
    expect(w.fromMs).toBe(NOW - MAX_CATCHUP);
    expect(w.clipped).toBe(true);
  });

  it('exactly at the cap boundary: not clipped (cap is a strict bound)', () => {
    // rawFrom == capFloor ⇒ nothing was cut off.
    const wm = NOW - (MAX_CATCHUP - LOOKBACK) / 2;
    const w = win(wm);
    expect(w.fromMs).toBe(NOW - MAX_CATCHUP);
    expect(w.clipped).toBe(false);
  });

  it('clock skew (watermark ahead of now): degrades to the plain fixed lookback, never negative gap', () => {
    const wm = NOW + 10 * MIN;
    const w = win(wm);
    expect(w.catchupGapMs).toBe(0);
    expect(w.effectiveLookbackMs).toBe(LOOKBACK);
    expect(w.fromMs).toBe(wm - LOOKBACK);
    expect(w.clipped).toBe(false);
  });

  it('floor never goes below 0 even with a tiny now', () => {
    const w = computeWatermarkWindow({
      nowMs: 1_000,
      storedWatermarkMs: 0,
      lookbackMs: LOOKBACK,
      maxCatchupMs: MAX_CATCHUP,
    });
    expect(w.fromMs).toBe(0);
    expect(w.clipped).toBe(false); // capFloor is negative → nothing clipped, epoch floor stands
  });
});
