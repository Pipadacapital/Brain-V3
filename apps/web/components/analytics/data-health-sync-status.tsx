/**
 * DataHealthSyncStatus — the honest live-vs-stale freshness verdict.
 *
 * Honesty: a source is "stale" if the last ingest is old even when sync auth is fine
 * (kpi-dashboard-design §realized-vs-placed / data-quality). We never render a confident
 * "connected" over stale ingestion — the freshness verdict is computed from lastIngestAt,
 * independent of the raw connector state string. The badges themselves are rendered by
 * the Data Health surface via StatusPill (glyph + label, never colour-only).
 */

/** Freshness verdict — derived from lastIngestAt, NOT from the connector state string. */
export type FreshnessVerdict = 'live' | 'lagging' | 'stale' | 'unknown';

/** Thresholds (hours). Tunable; honest defaults for an ingestion pipeline. */
const LAGGING_AFTER_HOURS = 6;
const STALE_AFTER_HOURS = 24;

export function freshnessFromIngest(lastIngestAt: string | null): {
  verdict: FreshnessVerdict;
  ageMs: number | null;
} {
  if (!lastIngestAt) return { verdict: 'unknown', ageMs: null };
  const ts = new Date(lastIngestAt).getTime();
  if (Number.isNaN(ts)) return { verdict: 'unknown', ageMs: null };
  const ageMs = Date.now() - ts;
  const ageHours = ageMs / 3_600_000;
  if (ageHours <= LAGGING_AFTER_HOURS) return { verdict: 'live', ageMs };
  if (ageHours <= STALE_AFTER_HOURS) return { verdict: 'lagging', ageMs };
  return { verdict: 'stale', ageMs };
}
