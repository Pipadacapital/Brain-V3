/**
 * Tracking-health status derivation — honest, deterministic, never fabricated.
 *
 * Maps a tracking-health response into a status verdict for the UI. Status is
 * ALWAYS paired with an icon + a text label at the render layer (never colour-only,
 * accessibility skill §status-never-colour-only).
 *
 * Honesty rules:
 *   - no events at all          → 'waiting'  (no green, no fake "healthy")
 *   - events but last > STALE   → 'stale'    (amber — data was flowing, has gone quiet)
 *   - recent events             → 'healthy'  (green)
 * Pure functions; no React. Used by live-verification + tracking-health-panel.
 */

import type { AnalyticsTrackingHealthResponse } from '@/lib/api/types';

export type TrackingStatus = 'waiting' | 'healthy' | 'stale';

/** A last-event older than this is considered stale (data has gone quiet). */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * deriveTrackingStatus — the single source of truth for the at-a-glance verdict.
 * @param health - the BFF response (or undefined while loading).
 * @param now    - injectable clock for tests (defaults to Date.now()).
 */
export function deriveTrackingStatus(
  health: AnalyticsTrackingHealthResponse | undefined,
  now: number = Date.now(),
): TrackingStatus {
  if (!health || health.state === 'no_data') return 'waiting';
  // has_data ⇒ at least one Bronze event exists for this brand.
  if (!health.lastEventAt) return 'healthy'; // rows exist but no parseable ts → don't fake stale
  const lastTs = new Date(health.lastEventAt).getTime();
  if (Number.isNaN(lastTs)) return 'healthy';
  return now - lastTs > STALE_THRESHOLD_MS ? 'stale' : 'healthy';
}

/** True only when a real Bronze event has landed for the brand (drives the flip). */
export function hasFirstEvent(health: AnalyticsTrackingHealthResponse | undefined): boolean {
  return health?.state === 'has_data';
}
