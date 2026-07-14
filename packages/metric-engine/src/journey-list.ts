/**
 * @brain/metric-engine — computeJourneyList (recent-journeys list, serving read).
 *
 * The SOLE reader of the per-journey serving view brain_serving.mv_gold_journey (one row per
 * (brand_id, brain_anon_id) — the deterministic journey roll-up over the Silver spine), served
 * through withSilverBrand (I-ST01 — the engine is the only serving reader; the UI never queries
 * Trino). A THIN projection: newest-first by last_touch_at, KEYSET-paginated on the composite
 * (last_touch_at, brain_anon_id) tuple so the page boundary is stable under ties (no OFFSET drift).
 *
 * NO MONEY: a journey list is behavioral (mirrors journey-mix.ts / journey-paths.ts). brain_anon_id
 * is the opaque anon key (no PII). Counts are bigint (Trino COUNT) carried as strings (BigInt-safe
 * JSON). first_channel/last_channel are mapped to the canonical JourneyChannel set (the same closed
 * enum the first-touch mix renders — unknown/absent folds deterministically to 'direct').
 *
 * Honest-empty: hasData=false when the brand has zero journey rows (the seam degrades a missing mart
 * to []). brandId is from session (D-1; NEVER request body); the brand predicate is injected at the
 * seam (${BRAND_PREDICATE}) — the brand can never be forgotten.
 *
 * @see packages/metric-engine/src/journey-paths.ts — the aggregate path-flow sibling
 * @see packages/metric-engine/src/journey-mix.ts — the per-touch first-touch/timeline sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import type { JourneyChannel } from './journey-mix.js';

/** The canonical channel set (mirrors journey-mix.ts CHANNEL_ORDER — the closed render set). */
const CHANNEL_SET: ReadonlySet<string> = new Set<JourneyChannel>([
  'paid_meta',
  'paid_google',
  'paid_tiktok',
  'paid',
  'email',
  'organic_social',
  'referral',
  'direct',
]);

/** Map an unknown channel string to the canonical set; unknown/absent → 'direct' (deterministic). */
function toChannel(v: unknown): JourneyChannel {
  const s = String(v ?? '');
  return CHANNEL_SET.has(s) ? (s as JourneyChannel) : 'direct';
}

/** Coerce a Trino numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** Normalize a possibly-null DB string field. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

/** Normalize a Trino boolean (native boolean, or 0/1 over a legacy wire) → boolean. */
function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1';
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** One journey row (grain brand_id, brain_anon_id) for the recent-journeys list. */
export interface JourneyListRow {
  /** Opaque anon journey key (no PII); also the keyset tiebreaker. */
  brainAnonId: string;
  /** Raw Trino/Iceberg timestamp string (UTC), serialized verbatim. */
  firstTouchAt: string;
  /** Raw Trino/Iceberg timestamp string (UTC); the primary sort key. */
  lastTouchAt: string;
  /** First-touch channel, mapped to the canonical set. */
  firstChannel: JourneyChannel;
  /** Last-touch channel, mapped to the canonical set. */
  lastChannel: JourneyChannel;
  /** Total touchpoints in the journey (bigint → string). */
  touchpointCount: bigint;
  /** Distinct channels seen in the journey (bigint → string). */
  distinctChannels: bigint;
  /** Distinct sessions in the journey (bigint → string). */
  distinctSessions: bigint;
  /** True = the journey reached a converting order. */
  converted: boolean;
  /** Conversion timestamp (verbatim); null when not converted. */
  convertedAt: string | null;
  /** Days first-touch → conversion (bigint → string); null when not converted. */
  daysToConvert: bigint | null;
}

export interface JourneyListResult {
  /** True iff the brand has ANY journey row (honest no_data). */
  hasData: boolean;
  /** Total journeys for the brand (the pagination denominator; bigint → string upstream). */
  total: bigint;
  /** The page of journeys (newest-first by last_touch_at). */
  rows: JourneyListRow[];
  /** Opaque keyset cursor for the NEXT (older) page; null = this is the last page. */
  nextCursor: string | null;
}

export interface JourneyListParams {
  /** Page size (clamped 1..100; default 25). */
  limit?: number;
  /** Opaque keyset continuation from a prior page's nextCursor (invalid → first page). */
  cursor?: string | null;
}

/** Decoded keyset cursor: the (last_touch_at, brain_anon_id) of the last row on the prior page. */
interface JourneyCursor {
  t: string;
  a: string;
}

/** Encode the keyset tuple as an opaque base64url token (BigInt-free — plain strings). */
function encodeCursor(c: JourneyCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode an opaque cursor; any malformed/partial token degrades to null (→ first page, honest). */
function decodeCursor(raw: string | null | undefined): JourneyCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as JourneyCursor).t === 'string' &&
      typeof (parsed as JourneyCursor).a === 'string' &&
      (parsed as JourneyCursor).t.length > 0
    ) {
      return { t: (parsed as JourneyCursor).t, a: (parsed as JourneyCursor).a };
    }
  } catch {
    // fall through
  }
  return null;
}

interface JourneyListDbRow {
  brain_anon_id: string;
  first_touch_at: string;
  last_touch_at: string;
  first_channel: string | null;
  last_channel: string | null;
  touchpoint_count: string | number;
  distinct_channels: string | number;
  distinct_sessions: string | number;
  converted: number | boolean;
  converted_at: string | null;
  days_to_convert: string | number | null;
}

interface JourneyTotalRow {
  total: string | number;
}

/**
 * computeJourneyList — one page of a brand's recent customer journeys, newest-first.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - the Trino serving pool (createTrinoPool) injected at the root.
 * @param params  - page size + optional keyset continuation (opaque cursor).
 */
export async function computeJourneyList(
  brandId: string,
  deps: { srPool: SilverPool },
  params: JourneyListParams = {},
): Promise<JourneyListResult> {
  const lim = Math.min(Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const cursor = decodeCursor(params.cursor);

  const { rows, total } = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Brand-wide total (the pagination denominator) — one COUNT over the brand's rows.
    const totalRows = await scope.runScoped<JourneyTotalRow>(
      `SELECT COUNT(*) AS total
         FROM brain_serving.mv_gold_journey
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally after the cursor params.
    // LIMIT lim+1 = look-ahead row: its presence means a further page exists (it is not returned).
    // Keyset over (last_touch_at DESC, brain_anon_id DESC): strictly-older tuple than the cursor.
    let dbRows: JourneyListDbRow[];
    if (cursor) {
      dbRows = await scope.runScoped<JourneyListDbRow>(
        `SELECT brain_anon_id, first_touch_at, last_touch_at, first_channel, last_channel,
                touchpoint_count, distinct_channels, distinct_sessions,
                converted, converted_at, days_to_convert
           FROM brain_serving.mv_gold_journey
          WHERE (last_touch_at < ? OR (last_touch_at = ? AND brain_anon_id < ?))
            AND ${BRAND_PREDICATE}
          ORDER BY last_touch_at DESC, brain_anon_id DESC
          LIMIT ${lim + 1}`,
        [cursor.t, cursor.t, cursor.a],
      );
    } else {
      dbRows = await scope.runScoped<JourneyListDbRow>(
        `SELECT brain_anon_id, first_touch_at, last_touch_at, first_channel, last_channel,
                touchpoint_count, distinct_channels, distinct_sessions,
                converted, converted_at, days_to_convert
           FROM brain_serving.mv_gold_journey
          WHERE ${BRAND_PREDICATE}
          ORDER BY last_touch_at DESC, brain_anon_id DESC
          LIMIT ${lim + 1}`,
        [],
      );
    }

    const totalRow = totalRows[0];
    return { rows: dbRows, total: totalRow ? toBig(totalRow.total) : 0n };
  });

  if (rows.length === 0) {
    return { hasData: false, total, rows: [], nextCursor: null };
  }

  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;

  const mapped: JourneyListRow[] = page.map((r) => ({
    brainAnonId: String(r.brain_anon_id),
    firstTouchAt: String(r.first_touch_at),
    lastTouchAt: String(r.last_touch_at),
    firstChannel: toChannel(r.first_channel),
    lastChannel: toChannel(r.last_channel),
    touchpointCount: toBig(r.touchpoint_count),
    distinctChannels: toBig(r.distinct_channels),
    distinctSessions: toBig(r.distinct_sessions),
    converted: asBool(r.converted),
    convertedAt: str(r.converted_at),
    daysToConvert: r.days_to_convert == null ? null : toBig(r.days_to_convert),
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ t: String(last.last_touch_at), a: String(last.brain_anon_id) }) : null;

  return { hasData: true, total, rows: mapped, nextCursor };
}
