/**
 * @brain/metric-engine — computeAbandonedCart (Silver touchpoint cart-recovery rollup, Tier-0).
 *
 * The SOLE emitter of the abandoned-cart signal (Phase H pixel): of the sessions that added to cart,
 * how many converted (stitched back to an order, D-5) vs abandoned, over a date window — read from
 * silver_touchpoint (StarRocks brain_silver) via the withSilverBrand seam.
 *
 * DEFINITIONS (session grain):
 *   cart session      — a session_key with ≥1 cart.item_added touch in the window.
 *   converted session — a cart session whose anon was stitched to an order (stitched_order_id present).
 *   abandoned session — a cart session with NO stitched order.
 *   abandonment_rate  — abandoned ÷ cart sessions; recovery_rate — converted ÷ cart sessions.
 *
 * ── WHY HERE, NOT dbt (ADR-004): silver_touchpoint is the additive per-touch projection; this is a
 *    NON-additive aggregation (COUNT DISTINCT / rate) → metric-engine, never a dbt mart.
 * ── INTEGER-ONLY rate (no float). Honest no_data: hasData=false when zero cart sessions in the window.
 * ── ISOLATION: every read via withSilverBrand (brand predicate at the seam). brandId from session.
 *
 * @see packages/metric-engine/src/storefront-funnel.ts (sibling silver_touchpoint reader)
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

function toStarRocksTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function bi(v: unknown): bigint {
  return BigInt(String(v ?? '0'));
}

interface CartRow { cart_sessions: string | number; converted_sessions: string | number }

/**
 * computeAbandonedCart — cart-recovery rollup over [from,to] from silver_touchpoint.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @param range   - The occurred_at window [from, to] (inclusive).
 */
export async function computeAbandonedCart(
  brandId: string,
  deps: { srPool: SilverPool },
  range: AbandonedCartRange,
): Promise<AbandonedCartResult> {
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Per-session roll-up first (did it add to cart? did it convert?), then count cart sessions.
    const rows = await scope.runScoped<CartRow>(
      `SELECT
         COUNT(*) AS cart_sessions,
         SUM(converted) AS converted_sessions
       FROM (
         SELECT session_key,
                MAX(CASE WHEN stitched_order_id IS NOT NULL THEN 1 ELSE 0 END) AS converted,
                MAX(CASE WHEN event_type = 'cart.item_added' THEN 1 ELSE 0 END) AS has_cart
           FROM brain_silver.silver_touchpoint
          WHERE occurred_at >= ? AND occurred_at <= ?
            AND ${BRAND_PREDICATE}
          GROUP BY session_key
       ) s
       WHERE s.has_cart = 1`,
      [fromTs, toTs],
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
    const abandonedSessions = cartSessions - convertedSessions;

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
