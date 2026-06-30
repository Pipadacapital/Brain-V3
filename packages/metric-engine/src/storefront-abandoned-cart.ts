/**
 * @brain/metric-engine — computeAbandonedCart (Gold abandoned-cart recovery rollup, Tier-0).
 *
 * The SOLE reader of the abandoned-cart recovery signal, REPOINTED in Brain V4 to read the
 * pre-materialized Gold mart `gold_abandoned_cart` through the Trino serving view
 * `brain_serving.mv_gold_abandoned_cart` via the withSilverBrand seam — instead of recomputing the
 * rollup ad-hoc over `mv_silver_touchpoint` at request time. This closes the "Trino-sole serving"
 * consistency gap: the cart-recovery surface now serves the SAME pre-aggregated daily mart the rest
 * of the platform reads (Spark builds it: db/iceberg/spark/gold/gold_abandoned_cart.py), rather than
 * a bespoke session-grain query. The PUBLIC shape (AbandonedCartResult) is UNCHANGED — the use-case
 * (get-abandoned-cart.ts), route, contract (AbandonedCart), and web hook are all untouched.
 *
 * MART GRAIN (db/trino/views/mv_gold_abandoned_cart.sql) — 1 row per (brand_id, cart_date,
 * currency_code), per UTC day:
 *   cart_sessions   — distinct sessions with ≥1 cart.item_added that day (silver_cart_event).
 *   abandoned_carts — distinct orders that hit a shopflo checkout_abandoned signal that day
 *                     (silver_checkout_signal) — Brain's authoritative abandonment signal.
 *   recovered_carts — the recovered/converted carts; a placeholder 0 in the mart until the
 *                     cart→order stitch column lands on Silver (fills with NO schema change). Until
 *                     then recovery_rate is an honest 0 from this serving path — never fabricated.
 * We aggregate the per-(day,currency) rows into a brand-window total. NO money is surfaced here
 * (abandoned_value_minor stays in the mart; the contract carries counts + rates only).
 *
 * ── WHY HERE, NOT a new mart: gold_abandoned_cart is the additive per-day projection; the window
 *    SUM + rate shaping are NON-additive cross-day rollups → metric-engine, never a new mart.
 * ── INTEGER-ONLY rate (no float). Honest no_data: hasData=false when zero cart sessions in the window.
 * ── ISOLATION: every read via withSilverBrand (brand predicate LAST in the WHERE). brandId from
 *    session (D-1; NEVER request body).
 *
 * @see db/iceberg/spark/gold/gold_abandoned_cart.py + db/trino/views/mv_gold_abandoned_cart.sql
 * @see packages/metric-engine/src/search-behavior.ts — the sibling gold_behavior serving reader
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface AbandonedCartRange {
  from: Date;
  to: Date;
}

export interface AbandonedCartResult {
  hasData: boolean;
  /** Sessions that added to cart in the window. */
  cartSessions: bigint;
  /** Cart sessions stitched to an order (recovered/converted). */
  convertedSessions: bigint;
  /** Cart sessions with no order (abandoned). */
  abandonedSessions: bigint;
  /** abandoned ÷ cart × 100, 2dp; null when cart sessions = 0. */
  abandonmentRatePct: string | null;
  /** converted ÷ cart × 100, 2dp; null when cart sessions = 0. */
  recoveryRatePct: string | null;
}

function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** UTC date (YYYY-MM-DD) for the cart_date BETWEEN bound — the route already pins UTC boundaries. */
function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0] as string;
}

function bi(v: unknown): bigint {
  return BigInt(String(v ?? '0').split('.')[0] || '0');
}

interface CartRow {
  cart_sessions: string | number;
  converted_sessions: string | number;
  abandoned_sessions: string | number;
}

/**
 * computeAbandonedCart — cart-recovery rollup over [from,to] from the Gold mart gold_abandoned_cart
 * (served via brain_serving.mv_gold_abandoned_cart). Sums the per-(day,currency) rows into a brand
 * window total; counts NEVER blend money, so the per-currency rows aggregate cleanly into counts.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (Trino adapter injected at the root).
 * @param range   - The cart_date window [from, to] (inclusive, UTC).
 */
export async function computeAbandonedCart(
  brandId: string,
  deps: { srPool: SilverPool },
  range: AbandonedCartRange,
): Promise<AbandonedCartResult> {
  const fromStr = toDateStr(range.from);
  const toStr = toDateStr(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // The date window + ${BRAND_PREDICATE} (LAST → binds positionally to its single `?`) are
    // parameterized; counts sum cleanly across the per-currency rows (no money blended).
    const rows = await scope.runScoped<CartRow>(
      `SELECT
         COALESCE(SUM(cart_sessions), 0)   AS cart_sessions,
         COALESCE(SUM(recovered_carts), 0) AS converted_sessions,
         COALESCE(SUM(abandoned_carts), 0) AS abandoned_sessions
       FROM brain_serving.mv_gold_abandoned_cart
       WHERE cart_date BETWEEN ? AND ?
         AND ${BRAND_PREDICATE}`,
      [fromStr, toStr],
    );

    const r = rows[0];
    const cartSessions = r ? bi(r.cart_sessions) : 0n;
    if (cartSessions <= 0n) {
      return {
        hasData: false,
        cartSessions: 0n,
        convertedSessions: 0n,
        abandonedSessions: 0n,
        abandonmentRatePct: null,
        recoveryRatePct: null,
      };
    }

    const convertedSessions = r ? bi(r.converted_sessions) : 0n;
    const abandonedSessions = r ? bi(r.abandoned_sessions) : 0n;

    return {
      hasData: true,
      cartSessions,
      convertedSessions,
      abandonedSessions,
      abandonmentRatePct: ratePct(abandonedSessions, cartSessions),
      recoveryRatePct: ratePct(convertedSessions, cartSessions),
    };
  });
}
