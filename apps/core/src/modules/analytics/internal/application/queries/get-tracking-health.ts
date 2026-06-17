/**
 * getTrackingHealth — bounded pixel-collection health read (D-2 allowed exception).
 *
 * Mirrors get-data-health.ts exactly, but scoped to the *pixel collection* surface
 * (the Tracking Center). Surfaces — for the active brand only, RLS-enforced — the
 * signals a business stakeholder needs to see the pixel working:
 *   - firstEventReceived: has ANY bronze_events row landed for this brand (the honest
 *     "✅ first event received" flip — true ONLY when a real Bronze row exists).
 *   - eventVolume:        per-day bronze_events counts over a bounded recent window.
 *   - lastEventAt:        MAX(occurred_at) — last-event freshness.
 *   - totalEvents:        bounded-window total count.
 *   - consentGrantedCount / consentTotalCount: how many recent events carried a
 *     consent_flags.analytics=true bag (consent capture, NOT enforcement — I-ST05).
 *
 * PII POSTURE (ADR-2 + I-S02): this read NEVER selects raw PII. Only anonymized
 * ids (brain_anon_id / hashed_session_id) and aggregate counts leave the query.
 * The browser sends no raw PII, and this surface never reconstructs any.
 *
 * QUARANTINE NOTE: quarantined events are routed to the `.quarantine` Kafka topic
 * (Track A), NOT to a Postgres table — there is no per-brand quarantine row store in
 * Phase 1. This read therefore reports accepted-event health only; quarantine volume
 * is a Kafka/metric concern, surfaced as an honest "—" (not a fabricated 0) in the UI.
 *
 * F-SEC-02: all reads happen inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 * Honest-empty: state:'no_data' only when the brand has NO bronze_events at all.
 */

import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

export interface TrackingHealthVolumeBucket {
  bucket: string; // 'YYYY-MM-DD'
  count: string;  // bigint serialized to string (D-1)
}

export type TrackingHealthResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      firstEventReceived: true; // has_data ⇒ at least one Bronze row exists
      eventVolume: TrackingHealthVolumeBucket[];
      lastEventAt: string | null;   // ISO timestamp — last-event freshness
      totalEvents: string;          // bigint string — bounded-window total
      consentGrantedCount: string;  // bigint string — events with analytics consent
      consentTotalCount: string;    // bigint string — events carrying a consent_flags bag
    };

/** Bounded window for the volume histogram + counts (matches data-health). */
const VOLUME_WINDOW_DAYS = 30;

/**
 * getTrackingHealth — returns pixel-collection health for the brand.
 *
 * @param brandId - Brand UUID (from session — D-1, NEVER from request body).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getTrackingHealth(
  brandId: string,
  deps: EngineDeps,
): Promise<TrackingHealthResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    // EXISTS check — honest-empty (D-2). No bronze rows → no_data → "waiting for
    // your first event…" stays honest (never faked).
    const existsResult = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM bronze_events WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    if (existsResult.rows[0]?.exists !== true) {
      return { state: 'no_data' };
    }

    // Per-day event volume over a bounded window (VOLUME_WINDOW_DAYS is a constant,
    // never user-interpolated). occurred_at is the event timestamp.
    const volumeResult = await client.query<{ bucket: Date; count: string }>(
      `SELECT date_trunc('day', occurred_at)::date AS bucket,
              COUNT(*)::text AS count
       FROM bronze_events
       WHERE brand_id = $1
         AND occurred_at >= (now() - ($2::int * INTERVAL '1 day'))
       GROUP BY 1
       ORDER BY 1 ASC`,
      [brandId, VOLUME_WINDOW_DAYS],
    );

    // Last-event freshness across all bronze rows (not window-bounded).
    const lastResult = await client.query<{ last_event_at: Date | null }>(
      `SELECT MAX(occurred_at) AS last_event_at FROM bronze_events WHERE brand_id = $1`,
      [brandId],
    );

    // Bounded-window total + consent capture aggregates.
    // Consent is read from the anonymized payload bag (payload->'properties'->'consent_flags').
    // NO raw PII is touched — only boolean consent flags + counts.
    const aggResult = await client.query<{
      total: string;
      consent_total: string;
      consent_granted: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (
           WHERE payload->'properties' ? 'consent_flags'
         )::text AS consent_total,
         COUNT(*) FILTER (
           WHERE (payload->'properties'->'consent_flags'->>'analytics') = 'true'
         )::text AS consent_granted
       FROM bronze_events
       WHERE brand_id = $1
         AND occurred_at >= (now() - ($2::int * INTERVAL '1 day'))`,
      [brandId, VOLUME_WINDOW_DAYS],
    );

    const agg = aggResult.rows[0];

    return {
      state: 'has_data',
      firstEventReceived: true,
      eventVolume: volumeResult.rows.map((row) => ({
        bucket: row.bucket.toISOString().split('T')[0] as string,
        count: row.count,
      })),
      lastEventAt: lastResult.rows[0]?.last_event_at?.toISOString() ?? null,
      totalEvents: agg?.total ?? '0',
      consentGrantedCount: agg?.consent_granted ?? '0',
      consentTotalCount: agg?.consent_total ?? '0',
    };
  });
}
