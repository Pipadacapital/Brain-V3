/**
 * @brain/metric-engine — computeTopProducts (Silver order-line product rollup, Tier-0).
 *
 * The SOLE emitter of the top-products signal: per-SKU units sold, line GMV and distinct
 * order count over a date range, read from the Silver mart `silver.order_line` (StarRocks
 * brain_silver) through the Silver read seam (withSilverBrand).
 *
 * ── WHY THIS LIVES HERE, NOT IN dbt (ADR-004) ──────────────────────────────────
 * dbt produced only the ADDITIVE mart silver.order_line (one row per order line — a
 * deterministic projection of Bronze order depth). "Top products" is a NON-additive
 * aggregation (SUM + COUNT DISTINCT + rank). Non-additive math lives in the metric-engine,
 * never in a dbt mart. This fn is the GROUP BY over the additive line-grain mart.
 *
 * ── GRAIN ──────────────────────────────────────────────────────────────────────
 * silver.order_line = 1 row per (brand_id, order_id, line_index). We bound by `occurred_at`
 * ∈ [from, to] (the order's latest-state event time), GROUP BY sku, and rank by line GMV.
 * Money (line_total_minor) is summed as a BIGINT minor-unit value (I-S07) with currency_code.
 *
 * Honest no_data: hasData=false when the brand has zero Silver line rows in the window
 * (NEVER a fabricated empty list). Isolation: the read goes through withSilverBrand, which
 * injects the brand predicate at the seam (the brand can never be forgotten). brandId from
 * session (D-1).
 *
 * @see packages/metric-engine/src/order-status-mix.ts — the sibling Silver read
 * @see packages/metric-engine/src/silver-deps.ts — the Silver read seam
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface TopProductRow {
  /** Product SKU (the grouping key). */
  sku: string;
  /** A representative product title (MIN over the group; null if none captured). */
  title: string | null;
  /** Total units sold across orders in the window. */
  units: bigint;
  /** Sum of line_total_minor — line GMV, BIGINT minor units (I-S07). */
  lineGmvMinor: bigint;
  /** Distinct orders this SKU appeared on in the window. */
  orderCount: bigint;
}

export interface TopProductsResult {
  /** True iff the brand has ANY Silver order line in the window (honest no_data discriminant). */
  hasData: boolean;
  /** The brand's currency for the money column; null when no data. */
  currencyCode: CurrencyCode | null;
  /** Top products ranked by line GMV desc, capped at `limit`. */
  products: TopProductRow[];
}

export interface TopProductsRange {
  /** Inclusive lower bound on occurred_at (UTC). */
  from: Date;
  /** Inclusive upper bound on occurred_at (UTC). */
  to: Date;
}

/** Hard cap on returned rows (defensive; the route passes a small N). */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

interface ProductRow {
  sku: string | null;
  title: string | null;
  units: string | number;
  line_gmv_minor: string | number;
  order_count: string | number;
  currency_code: string | null;
}

/**
 * computeTopProducts — per-SKU units + line GMV + order count over [from,to], ranked by GMV.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @param range   - The occurred_at window [from, to] (inclusive).
 * @param limit   - Max products to return (capped at MAX_LIMIT).
 * @returns TopProductsResult — hasData=false when the window has zero Silver line rows.
 */
export async function computeTopProducts(
  brandId: string,
  deps: { srPool: SilverPool },
  range: TopProductsRange,
  limit: number = DEFAULT_LIMIT,
): Promise<TopProductsResult> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // The seam substitutes ${BRAND_PREDICATE} → `brand_id = ?`. The caller NEVER writes the
    // brand filter itself. LIMIT is a server-clamped integer (not user input) — safe to inline.
    return scope.runScoped<ProductRow>(
      `SELECT sku,
              MIN(title)                          AS title,
              COALESCE(SUM(quantity), 0)          AS units,
              COALESCE(SUM(line_total_minor), 0)  AS line_gmv_minor,
              COUNT(DISTINCT order_id)            AS order_count,
              MIN(currency_code)                  AS currency_code
         FROM brain_silver.silver_order_line
        WHERE occurred_at >= ?
          AND occurred_at <= ?
          AND sku IS NOT NULL
          AND ${BRAND_PREDICATE}
        GROUP BY sku
        ORDER BY line_gmv_minor DESC, units DESC, sku ASC
        LIMIT ${safeLimit}`,
      [fromTs, toTs],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, currencyCode: null, products: [] };
  }

  let currencyCode: CurrencyCode | null = null;
  const products: TopProductRow[] = rows
    .filter((r) => r.sku !== null)
    .map((r) => {
      if (currencyCode === null && r.currency_code) currencyCode = r.currency_code as CurrencyCode;
      return {
        sku: String(r.sku),
        title: r.title ?? null,
        units: BigInt(String(r.units)),
        lineGmvMinor: BigInt(String(r.line_gmv_minor)),
        orderCount: BigInt(String(r.order_count)),
      };
    });

  return { hasData: true, currencyCode, products };
}

/** Format a Date as a StarRocks DATETIME literal 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toStarRocksTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
