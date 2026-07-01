/**
 * getRecentEvents — bounded recent-rows read for the Tracking Center Event Explorer
 * (D-2 allowed exception).
 *
 * Selects the latest N Bronze rows from the Iceberg collector_events catalog via the
 * brand-isolated withSilverBrand seam. This is a bounded row-read of the raw collected-event
 * feed — NOT a metric computation (like get-recent-activity). It lets a non-technical
 * stakeholder watch data arrive. Honest-empty (rows:[]) when StarRocks isn't wired.
 *
 * PIXEL-ONLY: this is the Tracking-Center (pixel) Event Explorer, so it returns ONLY events we
 * received THROUGH the pixel (PIXEL_EVENT_TYPES — browser events via /collect). Server-trusted
 * connector events (order.live.v1, spend.live.v1, gokwik.*, shopflo.*, shiprocket.*, …) are
 * EXCLUDED. Each row also carries a PII-safe `details` map (the event's non-PII properties).
 *
 * PII POSTURE (ADR-2 + I-S02): this read returns ONLY type/time + ANONYMIZED ids.
 *   - anonId:    payload->'properties'->>'brain_anon_id' (a client-minted uuid, not PII)
 *   - sessionId: payload->>'hashed_session_id' (an opaque session hash, never a
 *                customer identifier — ADR-2)
 * NO email/phone/name/raw identifier is ever selected. The browser never sends raw PII,
 * and this surface never reconstructs any. Anonymized ids are further truncated for
 * display at the UI layer.
 */

import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';
import { type BronzeReadDeps, ICEBERG_BRONZE, BRONZE_COLLECTOR_PREDICATE, hasSilver } from './_bronze-source.js';
import { PIXEL_EVENT_IN } from './_pixel-events.js';

export interface RecentEventRow {
  event_id: string;
  event_type: string;          // event_name from the envelope, e.g. 'page.viewed'
  occurred_at: string;         // ISO timestamp string
  anon_id: string | null;      // brain_anon_id (anonymized) or null
  session_id: string | null;   // hashed_session_id (anonymized) or null
  has_consent: boolean;        // analytics-consent flag present-and-true
  /**
   * PII-safe, bounded view of the event's `properties` — the per-event detail (page path, product
   * id, cart value, checkout step, coupon code, click selector, scroll depth, …). PII-keyed and
   * empty values are dropped server-side (ADR-2 posture); the browser never sends raw PII anyway.
   */
  details: Record<string, string>;
}

export interface RecentEventsResult {
  rows: RecentEventRow[];
}

/** Hard cap on rows returned to the Event Explorer. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * Drop properties whose KEY looks like PII (defence-in-depth; the pixel sends hashed/anon ids only).
 * `.` and `_` are word boundaries so nested/flattened keys are caught too (e.g. utm.email, foo_email).
 */
const PII_KEY = /(^|[_.])(email|phone|mobile|name|firstname|lastname|fullname|address|street|city|zip|postal|dob|ssn|pan|aadhaar|ip)([_.]|$)/i;
/** Max detail keys + per-value length returned to the Explorer (surface the full captured context, bounded). */
const MAX_DETAIL_KEYS = 30;
const MAX_VALUE_LEN = 200;

/**
 * Parse the event's `properties` JSON into a PII-safe, bounded { key: string } detail map — surfacing
 * the FULL captured context. Nested groups (utm.*, click_ids.*, device.*) are FLATTENED one level with
 * dotted keys so UTMs, click ids (gclid/fbclid/…), and device context all show. Arrays are joined.
 * PII-keyed and empty values are dropped (ADR-2); the browser never sends raw PII anyway.
 */
function safeDetails(propertiesJson: string | null): Record<string, string> {
  if (!propertiesJson) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(propertiesJson);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, string> = {};
  const put = (key: string, val: unknown): void => {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) return;
    if (PII_KEY.test(key)) return;
    if (val === null || val === undefined || val === '') return;
    out[key] = String(val).slice(0, MAX_VALUE_LEN);
  };
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Flatten one level: utm.source, click_ids.gclid, device.viewport, … (2-levels-deep skipped).
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 !== null && typeof v2 === 'object') continue;
        put(`${k}.${k2}`, v2);
      }
    } else if (Array.isArray(v)) {
      put(k, v.filter((x) => x !== null && typeof x !== 'object').join(', '));
    } else {
      put(k, v);
    }
  }
  return out;
}

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

  // no StarRocks wired → honest no_data (PG bronze retired)
  if (!hasSilver(deps)) return { rows: [] };

  // ── Iceberg Bronze source — brand-isolated via the withSilverBrand seam ──────────
  {
    const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
      // safeLimit is a clamped int (never user text) and PIXEL_EVENT_IN is a static code-defined list
      // — both safe to interpolate. The seam appends the brand predicate at ${BRAND_PREDICATE};
      // the pixel-only filter + ORDER BY/LIMIT follow it. ONLY pixel-origin events are returned —
      // server-trusted connector events (order.live.v1, spend.*, gokwik.*, …) are excluded.
      scope.runScoped<{ event_id: string; event_type: string; occurred_at: Date | string; anon_id: string | null; session_id: string | null; has_consent: boolean | number; properties_json: string | null }>(
        `SELECT event_id, event_type, occurred_at,
                json_extract_scalar(payload, '$.properties.brain_anon_id') AS anon_id,
                json_extract_scalar(payload, '$.hashed_session_id')        AS session_id,
                CASE WHEN json_extract_scalar(payload, '$.consent_flags.analytics') = 'true' THEN true ELSE false END AS has_consent,
                json_extract(payload, '$.properties')                      AS properties_json
           FROM ${ICEBERG_BRONZE}
          WHERE ${BRONZE_COLLECTOR_PREDICATE} AND ${BRAND_PREDICATE}
            AND event_type IN (${PIXEL_EVENT_IN})
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
        details: safeDetails(row.properties_json),
      })),
    };
  }
}
