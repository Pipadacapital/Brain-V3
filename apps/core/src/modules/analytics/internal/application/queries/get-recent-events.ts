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
import { type BronzeReadDeps, ICEBERG_BRONZE, hasSilver } from './_bronze-source.js';

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
 * The PIXEL event taxonomy — the events we receive THROUGH the pixel (browser-originated, via the
 * collector /collect endpoint). The Event Explorer is a pixel surface, so it shows ONLY these and
 * NEVER server-trusted connector events (order.live.v1, spend.live.v1, gokwik.*, shopflo.*,
 * shiprocket.*, settlement.*). Mirrors the pixel SDK (packages/pixel-sdk/src/capture.ts) + the
 * universal capture script (apps/collector/src/interfaces/rest/pixel-asset.route.ts). NB: the pixel's
 * client-side `order.placed` is distinct from the connector's server `order.live.v1`.
 */
const PIXEL_EVENT_TYPES = [
  'page.viewed', 'product.viewed', 'collection.viewed', 'search.submitted',
  'cart.item_added', 'cart.item_removed', 'cart.updated', 'cart.viewed',
  'checkout.started', 'checkout.step_viewed', 'checkout.shipping_selected',
  'payment.initiated', 'payment.succeeded', 'payment.failed',
  'coupon.applied', 'form.submitted', 'order.placed',
  'rage.click', 'dead.click', 'element.clicked', 'scroll.depth',
  'user.logged_in', 'user.signed_up', 'identify',
] as const;

/** Static, code-defined values — safe to inline into the IN list (never user input). */
const PIXEL_EVENT_IN = PIXEL_EVENT_TYPES.map((t) => `'${t}'`).join(', ');

/** Drop properties whose KEY looks like PII (defence-in-depth; the pixel sends hashed/anon ids only). */
const PII_KEY = /(^|_)(email|phone|mobile|name|firstname|lastname|fullname|address|street|city|zip|postal|dob|ssn|pan|aadhaar|ip)(_|$)/i;
/** Max detail keys + per-value length returned to the Explorer (keep the feed compact + bounded). */
const MAX_DETAIL_KEYS = 10;
const MAX_VALUE_LEN = 160;

/** Parse the event's properties JSON into a PII-safe, bounded { key: string } detail map. */
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
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) break;
    if (PII_KEY.test(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue; // only scalars in the compact detail view
    out[k] = String(v).slice(0, MAX_VALUE_LEN);
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
                get_json_object(payload, '$.properties.brain_anon_id') AS anon_id,
                get_json_object(payload, '$.hashed_session_id')        AS session_id,
                CASE WHEN get_json_object(payload, '$.consent_flags.analytics') = 'true' THEN true ELSE false END AS has_consent,
                get_json_object(payload, '$.properties')               AS properties_json
           FROM ${ICEBERG_BRONZE}
          WHERE ${BRAND_PREDICATE}
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
