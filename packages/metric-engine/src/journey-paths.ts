/**
 * @brain/metric-engine — computeJourneyPaths (#32a — aggregate journey-path Sankey).
 *
 * The SOLE reader of the path-aggregate Gold mart gold_journey_paths, served through the
 * Trino serving view brain_serving.mv_gold_journey_paths via withSilverBrand (I-ST01 — the
 * engine is the only Gold reader; the UI never queries the lakehouse directly). The mart
 * pre-aggregates silver_touchpoint into the top-N most-common ORDERED channel paths per brand
 * (grain brand_id, path_signature), each carrying its journey COUNT, the consecutive
 * channel→channel edges[] the Sankey draws, and a conversion count.
 *
 * This reader does THREE brand-scoped reads in one seam round-trip:
 *   1. paths   — the top-N ranked paths verbatim (path_rank asc) for the path-flow list.
 *   2. links   — the Sankey edges: UNNEST edges[] across the brand's rows and SUM journey_count
 *                grouped by (step, from_channel, to_channel) — done in SQL so no nested ROW
 *                arrays are parsed in TS.
 *   3. totals  — Σ journey_count / Σ converted_count / distinct path COUNT across ALL paths
 *                (not just the top-N) for the honest headline + overall conversion.
 *
 * NO MONEY: a path is behavioral, not monetary (mirrors journey-mix.ts / gold_attribution_paths).
 * Every ratio is an EXACT integer-basis-point decimal string (no float); null when the denominator
 * is 0 (honest no-data, never divide-by-zero). hasData=false when the brand has zero path rows.
 *
 * @see db/iceberg/spark/gold/gold_journey_paths.py + db/trino/views/mv_gold_journey_paths.sql
 * @see packages/metric-engine/src/journey-mix.ts — the per-touch Silver journey sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on non-positive denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** Coerce a Trino numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** Normalize a Trino array<varchar> cell (already a JS array) into a clean string[]. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? ''));
}

/** One ordered channel path (grain brand_id, path_signature) with its journey + conversion counts. */
export interface JourneyPathRow {
  /** Stable signature of the ordered channel sequence (the mart grain key). */
  pathSignature: string;
  /** Number of channel nodes in the path. */
  pathLength: number;
  /** Ordered channel sequence (the Sankey node path), e.g. ['paid_meta','email','direct']. */
  channels: string[];
  firstTouchChannel: string;
  lastTouchChannel: string;
  /** Distinct journeys that took exactly this path. */
  journeyCount: bigint;
  /** Of those, how many reached a converting order. */
  convertedCount: bigint;
  /** journeyCount − convertedCount — journeys on this path that did NOT convert (drop-off). */
  droppedCount: bigint;
  /** convertedCount ÷ journeyCount, 2dp string; null when journeyCount = 0. */
  conversionPct: string | null;
  /** 1..N rank within the brand by journey_count desc (mart-assigned). */
  pathRank: number;
}

/** One aggregated Sankey link: journeys flowing from one channel to the next at a given step. */
export interface JourneyPathLink {
  /** 0-based transition index along the path (edge position). */
  step: number;
  fromChannel: string;
  toChannel: string;
  /** Σ journey_count across every path that contains this (step, from, to) edge. */
  journeys: bigint;
}

export interface JourneyPathsResult {
  /** True iff the brand has ANY path row (honest no_data). */
  hasData: boolean;
  /** Distinct paths across ALL of the brand's rows (not just the returned top-N). */
  totalPaths: number;
  /** Σ journey_count across all paths. */
  totalJourneys: bigint;
  /** Σ converted_count across all paths. */
  totalConverted: bigint;
  /** totalConverted ÷ totalJourneys, 2dp string; null when there are no journeys. */
  overallConversionPct: string | null;
  /** The top-N paths (path_rank asc) for the path-flow list. */
  paths: JourneyPathRow[];
  /** The aggregated Sankey edges (step asc, journeys desc within a step). */
  links: JourneyPathLink[];
}

interface PathRow {
  path_signature: string;
  path_length: string | number;
  channels: unknown;
  first_touch_channel: string | null;
  last_touch_channel: string | null;
  journey_count: string | number;
  converted_count: string | number;
  path_rank: string | number;
}
interface LinkRow {
  step: string | number;
  from_channel: string | null;
  to_channel: string | null;
  journeys: string | number;
}
interface TotalsRow {
  path_count: string | number;
  total_journeys: string | number;
  total_converted: string | number;
}

/**
 * computeJourneyPaths — top-N ordered channel paths + aggregated Sankey edges + headline (#32a).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_journey_paths via brain_serving.mv_gold_journey_paths).
 * @param opts    - { limit } — max top paths to return (default 25, clamped 1..50; the mart caps at 50).
 * @returns       Paths + Sankey links + totals; hasData=false when the brand has no path rows.
 */
export async function computeJourneyPaths(
  brandId: string,
  deps: { srPool: SilverPool },
  opts: { limit?: number } = {},
): Promise<JourneyPathsResult> {
  // Clamp the limit to a safe integer literal (1..50) — interpolated into LIMIT, never a param.
  const rawLimit = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 25;
  const limit = Math.max(1, Math.min(50, rawLimit));

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally to its single `?`.
    const pathRows = await scope.runScoped<PathRow>(
      `SELECT path_signature, path_length, channels,
              first_touch_channel, last_touch_channel,
              journey_count, converted_count, path_rank
         FROM brain_serving.mv_gold_journey_paths
        WHERE ${BRAND_PREDICATE}
        ORDER BY path_rank ASC
        LIMIT ${limit}`,
      [],
    );

    // Sankey edges — UNNEST the edges array<row(step, from_channel, to_channel)> in SQL and SUM the
    // per-path journey_count by edge. Aggregating in Trino avoids parsing nested ROW arrays in TS.
    const linkRows = await scope.runScoped<LinkRow>(
      `SELECT e.step AS step, e.from_channel AS from_channel, e.to_channel AS to_channel,
              COALESCE(SUM(journey_count), 0) AS journeys
         FROM brain_serving.mv_gold_journey_paths
         CROSS JOIN UNNEST(edges) AS e (step, from_channel, to_channel)
        WHERE ${BRAND_PREDICATE}
        GROUP BY e.step, e.from_channel, e.to_channel
        ORDER BY e.step ASC, journeys DESC`,
      [],
    );

    // Brand-wide totals over ALL paths (the headline denominator — not just the returned top-N).
    const totalsRows = await scope.runScoped<TotalsRow>(
      `SELECT COUNT(*) AS path_count,
              COALESCE(SUM(journey_count), 0) AS total_journeys,
              COALESCE(SUM(converted_count), 0) AS total_converted
         FROM brain_serving.mv_gold_journey_paths
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    if (pathRows.length === 0) {
      return {
        hasData: false,
        totalPaths: 0,
        totalJourneys: 0n,
        totalConverted: 0n,
        overallConversionPct: null,
        paths: [],
        links: [],
      };
    }

    const t = totalsRows[0];
    const totalJourneys = t ? toBig(t.total_journeys) : 0n;
    const totalConverted = t ? toBig(t.total_converted) : 0n;
    const totalPaths = t ? Number(toBig(t.path_count)) : pathRows.length;

    const paths: JourneyPathRow[] = pathRows.map((r) => {
      const journeyCount = toBig(r.journey_count);
      const convertedCount = toBig(r.converted_count);
      return {
        pathSignature: String(r.path_signature),
        pathLength: Number(r.path_length),
        channels: toStringArray(r.channels),
        firstTouchChannel: r.first_touch_channel ?? '',
        lastTouchChannel: r.last_touch_channel ?? '',
        journeyCount,
        convertedCount,
        droppedCount: journeyCount - convertedCount > 0n ? journeyCount - convertedCount : 0n,
        conversionPct: ratePct(convertedCount, journeyCount),
        pathRank: Number(r.path_rank),
      };
    });

    const links: JourneyPathLink[] = linkRows.map((r) => ({
      step: Number(r.step),
      fromChannel: r.from_channel ?? '',
      toChannel: r.to_channel ?? '',
      journeys: toBig(r.journeys),
    }));

    return {
      hasData: true,
      totalPaths,
      totalJourneys,
      totalConverted,
      overallConversionPct: ratePct(totalConverted, totalJourneys),
      paths,
      links,
    };
  });
}
