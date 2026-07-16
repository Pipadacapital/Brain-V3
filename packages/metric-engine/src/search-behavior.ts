/**
 * @brain/metric-engine — computeSearchBehavior (storefront on-site SEARCH rollup, Gold tier).
 *
 * The SOLE reader of the `search` slice of the Gold mart gold_behavior, served through the
 * serving view brain_serving.mv_gold_behavior via withSilverBrand (I-ST01 — the engine is the only
 * Gold reader; the UI never queries the lakehouse directly). gold_behavior is keyed
 * (brand_id, behavior_date, page_type); this projects the page_type = 'search' bucket — the daily
 * on-site search-page-view volume + session/journey reach (what shoppers search for, by volume).
 *
 * Grain: 1 row per (brand_id, behavior_date) after the page_type='search' filter. We aggregate the
 * day rows into a brand window total (searches/sessions/journeys) plus the per-day series for a
 * Sparkline. NO MONEY (search is impression counting; every measure is a count).
 *
 * ── WHY HERE, NOT a mart: gold_behavior is the additive per-day projection; the window SUM + the
 *    series shaping are NON-additive cross-day rollups → metric-engine, never a new mart.
 * ── ISOLATION: every read via withSilverBrand (brand predicate at the seam, LAST in the WHERE).
 *    brandId from session (D-1; NEVER request body). Honest no_data: hasData=false on zero rows.
 *
 * @see db/iceberg/duckdb/gold/gold_behavior.py + db/iceberg/duckdb/views/mv_gold_behavior.sql
 * @see packages/metric-engine/src/storefront-behavior.ts — the silver_touchpoint browse sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** The page_type taxonomy value the gold_behavior mart emits for on-site search pages. */
const SEARCH_PAGE_TYPE = 'search';

export interface SearchBehaviorRange {
  /** Inclusive lower behavior_date bound (YYYY-MM-DD). */
  fromStr: string;
  /** Inclusive upper behavior_date bound (YYYY-MM-DD). */
  toStr: string;
}

/** One day of the on-site search series (drives the Sparkline). */
export interface SearchDayBucket {
  /** behavior_date, YYYY-MM-DD. */
  date: string;
  /** Search-page views in the day. */
  searches: bigint;
  /** Distinct sessions reaching a search page in the day. */
  sessions: bigint;
  /** Distinct journeys (brain_anon_id) reaching a search page in the day. */
  journeys: bigint;
}

export interface SearchBehaviorResult {
  /** True iff the brand has any search-page rows in the window (honest no_data). */
  hasData: boolean;
  /** Σ search-page views over the window. */
  searches: bigint;
  /** Σ session-day reach over the window (mart-grain: distinct per day, summed across days). */
  sessions: bigint;
  /** Σ journey-day reach over the window (mart-grain: distinct per day, summed across days). */
  journeys: bigint;
  /** Per-day series (behavior_date asc) for the Sparkline. */
  days: SearchDayBucket[];
}

interface SearchRow {
  behavior_date: string;
  searches: string | number;
  sessions: string | number;
  journeys: string | number;
}

/** Coerce a serving numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] || '0');
}

/**
 * computeSearchBehavior — on-site search volume + session/journey reach over [from,to].
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_behavior via brain_serving.mv_gold_behavior).
 * @param range   - The behavior_date window [fromStr, toStr] (inclusive).
 */
export async function computeSearchBehavior(
  brandId: string,
  deps: { srPool: SilverPool },
  range: SearchBehaviorRange,
): Promise<SearchBehaviorResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // page_type is a TS-controlled constant (no user input) — embedded as a literal; the date window
    // + ${BRAND_PREDICATE} (LAST → binds positionally to its single `?`) are parameterized.
    const rows = await scope.runScoped<SearchRow>(
      `SELECT behavior_date,
              views    AS searches,
              sessions AS sessions,
              journeys AS journeys
         FROM brain_serving.mv_gold_behavior
        WHERE page_type = '${SEARCH_PAGE_TYPE}'
          AND behavior_date BETWEEN ? AND ?
          AND ${BRAND_PREDICATE}
        ORDER BY behavior_date ASC`,
      [range.fromStr, range.toStr],
    );

    if (rows.length === 0) {
      return { hasData: false, searches: 0n, sessions: 0n, journeys: 0n, days: [] };
    }

    const days: SearchDayBucket[] = rows.map((r) => ({
      date: String(r.behavior_date).split('T')[0] as string,
      searches: toBig(r.searches),
      sessions: toBig(r.sessions),
      journeys: toBig(r.journeys),
    }));

    return {
      hasData: true,
      searches: days.reduce((acc, d) => acc + d.searches, 0n),
      sessions: days.reduce((acc, d) => acc + d.sessions, 0n),
      journeys: days.reduce((acc, d) => acc + d.journeys, 0n),
      days,
    };
  });
}
