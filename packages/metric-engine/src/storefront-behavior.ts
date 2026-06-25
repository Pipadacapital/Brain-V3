/**
 * @brain/metric-engine — computeStorefrontBehavior (Silver touchpoint browse rollup, Tier-0).
 *
 * The SOLE emitter of the storefront-behavior signal — what shoppers actually browse, search, and
 * view — over a date window, read from the Silver mart `silver_touchpoint` (StarRocks brain_silver)
 * through the withSilverBrand seam. Surfaces the rich pixel auto-instrumentation (page.viewed /
 * product.viewed / collection.viewed / search.submitted) that the journey expansion folded into
 * silver_touchpoint (page_type / product_handle / collection_handle / search_query).
 *
 * Four non-additive reads:
 *   summary       — distinct sessions (session_key), distinct journeys (brain_anon_id), total touches.
 *   pageTypeMix   — page.viewed touches grouped by page_type (+ integer-basis-point share).
 *   topProducts   — product.viewed grouped by product_handle (views + distinct-journey reach).
 *   topSearches   — search.submitted grouped by search_query (searches + distinct-journey reach).
 *
 * ── WHY HERE, NOT dbt (ADR-004): silver_touchpoint is the additive per-touch projection; these are
 *    NON-additive aggregations (COUNT / DISTINCT / share / rank) → metric-engine, never a dbt mart.
 * ── INTEGER-ONLY share (no float). Honest no_data: hasData=false when zero touches in the window.
 * ── ISOLATION: every read via withSilverBrand (brand predicate at the seam). brandId from session.
 *
 * @see packages/metric-engine/src/journey-mix.ts (sibling silver_touchpoint reader)
 * @see packages/metric-engine/src/silver-deps.ts (the Silver read seam)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface BehaviorRange {
  from: Date;
  to: Date;
}

export interface PageTypeBucket {
  pageType: string;
  count: bigint;
  sharePct: string | null; // 2dp; null when total ≤ 0
}

export interface BrowsedItem {
  /** product_handle or search_query (the grouping key). */
  key: string;
  count: bigint;
  /** distinct brain_anon_id reach for this key. */
  reach: bigint;
}

export interface StorefrontBehaviorResult {
  hasData: boolean;
  sessions: bigint;
  journeys: bigint;
  touches: bigint;
  pageTypeMix: PageTypeBucket[];
  topProducts: BrowsedItem[];
  topSearches: BrowsedItem[];
}

const TOP_LIMIT = 15;

function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

function toStarRocksTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function bi(v: unknown): bigint {
  return BigInt(String(v ?? '0'));
}

interface SummaryRow { sessions: string | number; journeys: string | number; touches: string | number }
interface PageTypeRow { page_type: string | null; cnt: string | number }
interface ItemRow { k: string | null; cnt: string | number; reach: string | number }

/**
 * computeStorefrontBehavior — browse/search/view rollup over [from,to] from silver_touchpoint.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @param range   - The occurred_at window [from, to] (inclusive).
 */
export async function computeStorefrontBehavior(
  brandId: string,
  deps: { srPool: SilverPool },
  range: BehaviorRange,
): Promise<StorefrontBehaviorResult> {
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<SummaryRow>(
      `SELECT COUNT(DISTINCT session_key)    AS sessions,
              COUNT(DISTINCT brain_anon_id)  AS journeys,
              COUNT(*)                       AS touches
         FROM brain_serving.mv_silver_touchpoint
        WHERE occurred_at >= ? AND occurred_at <= ?
          AND ${BRAND_PREDICATE}`,
      [fromTs, toTs],
    );

    const s = summaryRows[0];
    const touches = s ? bi(s.touches) : 0n;
    if (touches <= 0n) {
      return { hasData: false, sessions: 0n, journeys: 0n, touches: 0n, pageTypeMix: [], topProducts: [], topSearches: [] };
    }

    const pageTypeRows = await scope.runScoped<PageTypeRow>(
      `SELECT page_type, COUNT(*) AS cnt
         FROM brain_serving.mv_silver_touchpoint
        WHERE event_type = 'page.viewed' AND page_type IS NOT NULL AND page_type <> ''
          AND occurred_at >= ? AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        GROUP BY page_type
        ORDER BY cnt DESC`,
      [fromTs, toTs],
    );

    const productRows = await scope.runScoped<ItemRow>(
      `SELECT product_handle AS k, COUNT(*) AS cnt, COUNT(DISTINCT brain_anon_id) AS reach
         FROM brain_serving.mv_silver_touchpoint
        WHERE event_type = 'product.viewed' AND product_handle IS NOT NULL AND product_handle <> ''
          AND occurred_at >= ? AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        GROUP BY product_handle
        ORDER BY cnt DESC
        LIMIT ${TOP_LIMIT}`,
      [fromTs, toTs],
    );

    const searchRows = await scope.runScoped<ItemRow>(
      `SELECT search_query AS k, COUNT(*) AS cnt, COUNT(DISTINCT brain_anon_id) AS reach
         FROM brain_serving.mv_silver_touchpoint
        WHERE event_type = 'search.submitted' AND search_query IS NOT NULL AND search_query <> ''
          AND occurred_at >= ? AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        GROUP BY search_query
        ORDER BY cnt DESC
        LIMIT ${TOP_LIMIT}`,
      [fromTs, toTs],
    );

    const pageTypeTotal = pageTypeRows.reduce((sum, r) => sum + bi(r.cnt), 0n);
    const pageTypeMix: PageTypeBucket[] = pageTypeRows
      .filter((r) => r.page_type)
      .map((r) => {
        const count = bi(r.cnt);
        return { pageType: String(r.page_type), count, sharePct: ratePct(count, pageTypeTotal) };
      });

    const topProducts: BrowsedItem[] = productRows
      .filter((r) => r.k)
      .map((r) => ({ key: String(r.k), count: bi(r.cnt), reach: bi(r.reach) }));

    const topSearches: BrowsedItem[] = searchRows
      .filter((r) => r.k)
      .map((r) => ({ key: String(r.k), count: bi(r.cnt), reach: bi(r.reach) }));

    return {
      hasData: true,
      sessions: s ? bi(s.sessions) : 0n,
      journeys: s ? bi(s.journeys) : 0n,
      touches,
      pageTypeMix,
      topProducts,
      topSearches,
    };
  });
}
