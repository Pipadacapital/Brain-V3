/**
 * @brain/metric-engine — journey seam (Silver touchpoint, Tier-0 deterministic).
 *
 * The SOLE emitter of the journey signals over the Silver mart silver.touchpoint
 * (brain_serving.mv_silver_touchpoint over Trino/Iceberg), read through the Silver read seam (withSilverBrand).
 * Three non-additive reads:
 *
 *   1. computeFirstTouchMix      — COUNT + integer-basis-point share of journeys by
 *                                  first-touch `channel` over a window.
 *   2. computeStitchHitRate      — stitched ÷ total distinct anon journeys (cart-stitch
 *                                  hit-rate); integer basis-point math.
 *   3. computeTouchpointTimeline — the ordered touch rows for ONE journey (no aggregation),
 *                                  still through the seam.
 *
 * ── WHY THIS LIVES HERE, NOT IN dbt (ADR-004) ──────────────────────────────────
 * dbt produced only the ADDITIVE mart silver.touchpoint (1 row per
 * (brand_id, brain_anon_id, touch_seq) — a deterministic projection of Bronze SDK
 * events). first-touch-mix and stitch-hit-rate are NON-additive aggregations
 * (COUNT + share-of-total). Non-additive math lives in the metric-engine, never in
 * a dbt mart. These fns are the GROUP BY / ratio over the additive mart.
 *
 * ── INTEGER-ONLY SHARE ─────────────────────────────────────────────────────────
 * Share math is INTEGER-ONLY (the ratePct basis-point pattern from order-status-mix.ts) —
 * no float ever touches a percentage. There is NO money column on silver.touchpoint
 * (touchpoints are not monetary); counts are derived here, never stored.
 *
 * ── HONEST NO_DATA ─────────────────────────────────────────────────────────────
 * hasData=false when the brand has zero touchpoint rows in the window (NEVER a
 * fabricated zero-row mix). Stitch-hit-rate is null when the denominator is 0.
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────────
 * Every read goes through withSilverBrand, which injects the brand predicate at the
 * seam (the brand can never be forgotten). brandId is from session (D-1; NEVER body).
 * Proven NON-INERT in tools/isolation-fuzz/src/silver-touchpoint.test.ts.
 *
 * @see packages/metric-engine/src/silver-deps.ts — the Silver read seam
 * @see packages/metric-engine/src/order-status-mix.ts — the ratePct integer-share sibling
 * @see 05-architecture.md §4
 */

import type { Pool } from 'pg';
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import { withBrandTxn } from './deps.js';

/**
 * The canonical first-touch channels (matches the dbt int_touchpoint_sessionized
 * channel CASE ladder). Deterministic — derived from click_id / utm.medium / referrer
 * / direct precedence in dbt; this is the closed set the engine renders.
 */
export type JourneyChannel =
  | 'paid_meta'
  | 'paid_google'
  | 'paid_tiktok'
  | 'paid'
  | 'email'
  | 'organic_social'
  | 'referral'
  | 'direct';

/** Canonical render order for channels (stable UI ordering). */
const CHANNEL_ORDER: readonly JourneyChannel[] = [
  'paid_meta',
  'paid_google',
  'paid_tiktok',
  'paid',
  'email',
  'organic_social',
  'referral',
  'direct',
];

const CHANNEL_SET: ReadonlySet<string> = new Set(CHANNEL_ORDER);

// ── first-touch mix ────────────────────────────────────────────────────────────

export interface FirstTouchMixBucket {
  /** The canonical first-touch channel. */
  channel: JourneyChannel;
  /** Distinct first-touch journey count for this channel within the window. */
  count: bigint;
  /** Share of the window total first-touch journeys, 2dp string; null when total ≤ 0. */
  sharePct: string | null;
}

export interface FirstTouchMixResult {
  /** True iff the brand has ANY first-touch journey in the window (honest no_data). */
  hasData: boolean;
  /** Total first-touch journeys across all channels in the window. */
  total: bigint;
  /** Per-channel counts + shares, ordered by the canonical channel order. */
  byChannel: FirstTouchMixBucket[];
}

export interface JourneyRange {
  /** Inclusive lower bound on occurred_at (UTC). */
  from: Date;
  /** Inclusive upper bound on occurred_at (UTC). */
  to: Date;
}

// ── stitch hit-rate ──────────────────────────────────────────────────────────

export interface StitchHitRateResult {
  /** True iff the brand has ANY journey in the window (honest no_data). */
  hasData: boolean;
  /** Distinct anon journeys in the window (the denominator). */
  total: bigint;
  /** Distinct anon journeys that deterministically stitched to a known order (numerator). */
  stitched: bigint;
  /** stitched ÷ total, 2dp string; null when total ≤ 0. */
  hitPct: string | null;
}

// ── touchpoint timeline ──────────────────────────────────────────────────────

export interface TouchpointTimelineRow {
  touchSeq: number;
  isFirstTouch: boolean;
  isLastTouch: boolean;
  occurredAt: string; // raw Trino/Iceberg timestamp string (UTC); serialized verbatim
  channel: JourneyChannel;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  fbclid: string | null;
  gclid: string | null;
  ttclid: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  eventType: string;
}

export interface TouchpointTimelineResult {
  /** True iff the resolved journey has any touchpoint rows. */
  hasData: boolean;
  /** The resolved anon journey key (echoed for UI linkage); null when no data. */
  brainAnonId: string | null;
  /** Whether this journey deterministically stitched to a known order/brain_id. */
  stitched: boolean;
  /** The ordered touch rows (touch_seq asc). */
  touches: TouchpointTimelineRow[];
}

/** Selector for the timeline: by order (resolved via the stitch map) or directly by anon. */
export type TimelineSelector =
  | { orderId: string }
  | { brainAnonId: string };

// ── helpers ──────────────────────────────────────────────────────────────────

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on non-positive denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** Format a Date as a serving timestamp literal 'YYYY-MM-DD HH:MM:SS' (UTC) for Trino comparisons. */
function toServingTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** Normalize a possibly-null DB string field. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

/** Map an unknown channel string to the canonical set; unknown → 'direct' (deterministic, honest). */
function toChannel(v: unknown): JourneyChannel {
  const s = String(v ?? '');
  return CHANNEL_SET.has(s) ? (s as JourneyChannel) : 'direct';
}

interface FirstTouchRow {
  channel: string;
  cnt: string | number;
}

interface StitchRow {
  stitched: string | number;
  total: string | number;
}

interface TimelineRow {
  brain_anon_id: string;
  touch_seq: string | number;
  is_first_touch: number | boolean;
  is_last_touch: number | boolean;
  occurred_at: string;
  channel: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  ttclid: string | null;
  referrer_host: string | null;
  landing_path: string | null;
  stitched_brain_id: string | null;
  event_type: string;
}

// ── compute fns ──────────────────────────────────────────────────────────────

/**
 * computeFirstTouchMix — distinct first-touch journeys + share by channel over [from,to].
 *
 * Counts DISTINCT brain_anon_id WHERE is_first_touch over the window, grouped by the
 * deterministic channel, and computes each channel's share of the total. Integer
 * basis-point share (no float). Honest no_data on zero rows.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the Trino serving pool (srPool).
 * @param range   - The occurred_at window [from, to] (inclusive).
 */
export async function computeFirstTouchMix(
  brandId: string,
  deps: { srPool: SilverPool },
  range: JourneyRange,
): Promise<FirstTouchMixResult> {
  const fromTs = toServingTs(range.from);
  const toTs = toServingTs(range.to);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // The seam substitutes ${BRAND_PREDICATE} → `brand_id = ?` (parameterized to brandId).
    // ${BRAND_PREDICATE} is placed LAST in the WHERE so the brandId the seam appends to
    // the param list binds positionally to its `?` (mysql2 binds `?` strictly by order).
    return scope.runScoped<FirstTouchRow>(
      `SELECT channel,
              COUNT(DISTINCT brain_anon_id) AS cnt
         FROM brain_serving.mv_silver_touchpoint
        WHERE is_first_touch = 1
          AND occurred_at >= ?
          AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        GROUP BY channel`,
      [fromTs, toTs],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, total: 0n, byChannel: [] };
  }

  const countByChannel = new Map<string, bigint>();
  let total = 0n;
  for (const r of rows) {
    const channel = toChannel(r.channel);
    const cnt = BigInt(String(r.cnt));
    // Multiple raw channels could fold to 'direct' (the unknown bucket) — sum, never overwrite.
    countByChannel.set(channel, (countByChannel.get(channel) ?? 0n) + cnt);
    total += cnt;
  }

  const byChannel: FirstTouchMixBucket[] = CHANNEL_ORDER.filter((c) => countByChannel.has(c)).map((c) => {
    const count = countByChannel.get(c) ?? 0n;
    return { channel: c, count, sharePct: ratePct(count, total) };
  });

  return { hasData: true, total, byChannel };
}

/**
 * computeStitchHitRate — deterministic cart-stitch hit-rate over [from,to].
 *
 * total    = COUNT(DISTINCT brain_anon_id) in the window.
 * stitched = COUNT(DISTINCT brain_anon_id) WHERE stitched_brain_id IS NOT NULL.
 * hitPct   = stitched ÷ total (integer basis-point math; null when total = 0).
 *
 * Deterministic only — stitched_brain_id is populated by the read-back stitch map
 * (D-5), never inferred. Honest no_data on zero rows.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the Trino serving pool (srPool).
 * @param range   - The occurred_at window [from, to] (inclusive).
 */
export async function computeStitchHitRate(
  brandId: string,
  deps: { srPool: SilverPool },
  range: JourneyRange,
): Promise<StitchHitRateResult> {
  const fromTs = toServingTs(range.from);
  const toTs = toServingTs(range.to);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally.
    return scope.runScoped<StitchRow>(
      `SELECT COUNT(DISTINCT CASE WHEN stitched_brain_id IS NOT NULL THEN brain_anon_id END) AS stitched,
              COUNT(DISTINCT brain_anon_id) AS total
         FROM brain_serving.mv_silver_touchpoint
        WHERE occurred_at >= ?
          AND occurred_at <= ?
          AND ${BRAND_PREDICATE}`,
      [fromTs, toTs],
    );
  });

  const row = rows[0];
  const total = row ? BigInt(String(row.total)) : 0n;
  const stitched = row ? BigInt(String(row.stitched)) : 0n;

  if (total <= 0n) {
    return { hasData: false, total: 0n, stitched: 0n, hitPct: null };
  }

  return { hasData: true, total, stitched, hitPct: ratePct(stitched, total) };
}

/**
 * computeTouchpointTimeline — the ordered touch rows for ONE journey.
 *
 * Resolves the journey either directly by brain_anon_id OR by order_id (joining the
 * stitch map projection carried into Silver as stitched_brain_id is per-touch; the
 * order→anon resolution happens via the stitch map — see the orderId selector). Returns
 * the touches in touch_seq order (a read projection, no aggregation), still through the
 * brand-scoped seam. Honest no_data when the journey resolves to zero touches.
 *
 * @param brandId  - Brand UUID (from session — D-1; NEVER request body).
 * @param deps     - The Trino serving pool (srPool) + the PG pool (pool) used to resolve an
 *                   order → its stitched anon(s) from the PG-native stitch map.
 * @param selector - Either { orderId } (resolved via the stitch map) or { brainAnonId }.
 */
export async function computeTouchpointTimeline(
  brandId: string,
  deps: { srPool: SilverPool; pool?: Pool },
  selector: TimelineSelector,
): Promise<TouchpointTimelineResult> {
  // Resolve the journey to its anon key(s). The order→anon stitch map is PG-NATIVE
  // (connectors.connector_journey_stitch_map) — it is operational state that the Trino serving
  // tier cannot see (a Trino read of brain_ops.* silently returns empty). V4 (StarRocks REMOVAL):
  // resolve the order→anon mapping from PG here, then read the touches from the Trino Silver view.
  let anonIds: string[] | null = null; // null = brainAnonId selector (single anon); [] = no stitch
  if ('orderId' in selector) {
    if (!deps.pool) {
      // No PG pool reachable → cannot resolve order → anon (the stitch map is PG-native). Degrade to
      // honest no_data rather than silently reading a non-existent brain_ops table over Trino.
      return { hasData: false, brainAnonId: null, stitched: false, touches: [] };
    }
    // Deterministic read-back (D-5), brand-scoped by RLS via the GUC inside withBrandTxn.
    const stitchRows = await withBrandTxn(deps.pool, brandId, async (client) => {
      const r = await client.query<{ stitched_anon_id: string }>(
        `SELECT DISTINCT stitched_anon_id
           FROM connectors.connector_journey_stitch_map
          WHERE order_id = $1 AND stitched_anon_id IS NOT NULL`,
        [selector.orderId],
      );
      return r.rows;
    });
    anonIds = stitchRows.map((r) => r.stitched_anon_id);
    if (anonIds.length === 0) {
      return { hasData: false, brainAnonId: null, stitched: false, touches: [] };
    }
  }

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    if (anonIds !== null) {
      // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally; the anon IN-list
      // params bind first.
      const placeholders = anonIds.map(() => '?').join(', ');
      return scope.runScoped<TimelineRow>(
        `SELECT brain_anon_id, touch_seq, is_first_touch, is_last_touch,
                occurred_at, channel, utm_source, utm_medium, utm_campaign,
                utm_term, utm_content, fbclid, gclid, ttclid,
                referrer_host, landing_path, stitched_brain_id, event_type
           FROM brain_serving.mv_silver_touchpoint
          WHERE brain_anon_id IN (${placeholders})
            AND ${BRAND_PREDICATE}
          ORDER BY touch_seq ASC`,
        [...anonIds],
      );
    }
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally.
    return scope.runScoped<TimelineRow>(
      `SELECT brain_anon_id, touch_seq, is_first_touch, is_last_touch,
              occurred_at, channel, utm_source, utm_medium, utm_campaign,
              utm_term, utm_content, fbclid, gclid, ttclid,
              referrer_host, landing_path, stitched_brain_id, event_type
         FROM brain_serving.mv_silver_touchpoint
        WHERE brain_anon_id = ?
          AND ${BRAND_PREDICATE}
        ORDER BY touch_seq ASC`,
      [(selector as { brainAnonId: string }).brainAnonId],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, brainAnonId: null, stitched: false, touches: [] };
  }

  const touches: TouchpointTimelineRow[] = rows.map((r) => ({
    touchSeq: Number(r.touch_seq),
    isFirstTouch: r.is_first_touch === true || r.is_first_touch === 1,
    isLastTouch: r.is_last_touch === true || r.is_last_touch === 1,
    occurredAt: String(r.occurred_at),
    channel: toChannel(r.channel),
    utmSource: str(r.utm_source),
    utmMedium: str(r.utm_medium),
    utmCampaign: str(r.utm_campaign),
    utmTerm: str(r.utm_term),
    utmContent: str(r.utm_content),
    fbclid: str(r.fbclid),
    gclid: str(r.gclid),
    ttclid: str(r.ttclid),
    referrerHost: str(r.referrer_host),
    landingPath: str(r.landing_path),
    eventType: String(r.event_type),
  }));

  const first = rows[0] as TimelineRow;
  const stitched = rows.some((r) => str(r.stitched_brain_id) !== null);

  return {
    hasData: true,
    brainAnonId: String(first.brain_anon_id),
    stitched,
    touches,
  };
}
