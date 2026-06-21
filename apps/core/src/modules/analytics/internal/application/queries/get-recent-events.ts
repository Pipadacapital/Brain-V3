/**
 * getRecentEvents — bounded recent-rows read for the Tracking Center Event Explorer
 * (D-2 allowed exception).
 *
 * Selects the latest N bronze_events rows inside withBrandTxn (RLS-scoped). This is a
 * bounded row-read of the raw collected-event feed — NOT a metric computation (like
 * get-recent-activity). It lets a non-technical stakeholder watch data arrive.
 *
 * PII POSTURE (ADR-2 + I-S02): this read returns ONLY type/time + ANONYMIZED ids.
 *   - anonId:    payload->'properties'->>'brain_anon_id' (a client-minted uuid, not PII)
 *   - sessionId: payload->>'hashed_session_id' (an opaque session hash, never a
 *                customer identifier — ADR-2)
 * NO email/phone/name/raw identifier is ever selected. The browser never sends raw PII,
 * and this surface never reconstructs any. Anonymized ids are further truncated for
 * display at the UI layer.
 */

import { withBrandTxn, withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { type BronzeReadDeps, ICEBERG_BRONZE, useIceberg } from './_bronze-source.js';

export interface RecentEventRow {
  event_id: string;
  event_type: string;          // event_name from the envelope, e.g. 'page.viewed'
  occurred_at: string;         // ISO timestamp string
  anon_id: string | null;      // brain_anon_id (anonymized) or null
  session_id: string | null;   // hashed_session_id (anonymized) or null
  has_consent: boolean;        // analytics-consent flag present-and-true
}

export interface RecentEventsResult {
  rows: RecentEventRow[];
}

/** Hard cap on rows returned to the Event Explorer. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * getRecentEvents — returns the latest N collected events for the brand (anonymized).
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param limit   - Max rows to return (capped at MAX_LIMIT server-side).
 * @param deps    - EngineDeps with raw pg.Pool.
 */
export async function getRecentEvents(
  brandId: string,
  limit: number,
  deps: BronzeReadDeps,
): Promise<RecentEventsResult> {
  const safeLimit = Math.min(Math.max(1, limit || DEFAULT_LIMIT), MAX_LIMIT);

  // ── Iceberg Bronze source (Slice 5) — brand-isolated via the withSilverBrand seam ──────────
  if (useIceberg(deps)) {
    const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
      // safeLimit is a clamped int (never user text) — safe to interpolate. The seam appends the
      // brand predicate at ${BRAND_PREDICATE}; ORDER BY/LIMIT follow it.
      scope.runScoped<{ event_id: string; event_type: string; occurred_at: Date | string; anon_id: string | null; session_id: string | null; has_consent: boolean | number }>(
        `SELECT event_id, event_type, occurred_at,
                get_json_object(payload, '$.properties.brain_anon_id') AS anon_id,
                get_json_object(payload, '$.hashed_session_id')        AS session_id,
                CASE WHEN get_json_object(payload, '$.consent_flags.analytics') = 'true' THEN true ELSE false END AS has_consent
           FROM ${ICEBERG_BRONZE}
          WHERE ${BRAND_PREDICATE}
          ORDER BY occurred_at DESC
          LIMIT ${safeLimit}`,
      ),
    );
    return {
      rows: rows.map((row) => ({
        event_id: row.event_id,
        event_type: row.event_type,
        occurred_at: (row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at)).toISOString(),
        anon_id: row.anon_id,
        session_id: row.session_id,
        has_consent: row.has_consent === true || Number(row.has_consent) === 1,
      })),
    };
  }

  // ── Postgres Bronze source (default) ────────────────────────────────────────
  const rows = await withBrandTxn(deps.pool, brandId, async (client) => {
    // SELECT only type/time + anonymized ids. NEVER raw PII (I-S02).
    const result = await client.query<{
      event_id: string;
      event_type: string;
      occurred_at: Date;
      anon_id: string | null;
      session_id: string | null;
      has_consent: boolean;
    }>(
      `SELECT
         event_id,
         event_type,
         occurred_at,
         payload->'properties'->>'brain_anon_id' AS anon_id,
         payload->>'hashed_session_id'           AS session_id,
         COALESCE(
           (payload->'consent_flags'->>'analytics') = 'true',
           false
         )                                        AS has_consent
       FROM bronze_events
       WHERE brand_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [brandId, safeLimit],
    );
    return result.rows;
  });

  return {
    rows: rows.map((row) => ({
      event_id: row.event_id,
      event_type: row.event_type,
      occurred_at: row.occurred_at.toISOString(),
      anon_id: row.anon_id,
      session_id: row.session_id,
      has_consent: row.has_consent,
    })),
  };
}
