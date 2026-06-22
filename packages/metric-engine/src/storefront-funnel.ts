/**
 * @brain/metric-engine — computeStorefrontFunnel (Silver touchpoint conversion funnel, Tier-0).
 *
 * The SOLE emitter of the storefront conversion-funnel signal — the canonical behavioral funnel of
 * Phase H (Universal Pixel): how many sessions browse → view a product → add to cart → convert, over a
 * date window, read from silver_touchpoint (StarRocks brain_silver) via the withSilverBrand seam.
 *
 * STAGES (session reach — distinct session_key exhibiting each signal in the window):
 *   1. sessions       — all sessions (the funnel top / denominator).
 *   2. product_viewed — sessions with a product.viewed touch.
 *   3. cart_added     — sessions with a cart.item_added touch.
 *   4. purchased      — sessions whose anon was stitched back to an order (stitched_order_id present —
 *                       deterministic read-back, D-5; never inferred).
 *
 * ── WHY HERE, NOT dbt (ADR-004): silver_touchpoint is the additive per-touch projection; the funnel is
 *    a NON-additive aggregation (COUNT DISTINCT / share) → metric-engine, never a dbt mart.
 * ── INTEGER-ONLY share (no float). Honest no_data: hasData=false when zero sessions in the window.
 * ── ISOLATION: every read via withSilverBrand (brand predicate at the seam). brandId from session.
 *
 * @see packages/metric-engine/src/storefront-behavior.ts (sibling silver_touchpoint reader)
 * @see packages/metric-engine/src/silver-deps.ts (the Silver read seam)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface FunnelRange {
  from: Date;
  to: Date;
}

export interface FunnelStage {
  /** Stable stage key (sessions | product_viewed | cart_added | purchased). */
  key: string;
  /** Distinct sessions that reached this stage. */
  sessions: bigint;
  /** count ÷ top-of-funnel sessions × 100, 2dp; null when the funnel top is 0. */
  conversionPct: string | null;
  /** count ÷ previous stage × 100, 2dp; null for the first stage or when previous is 0. */
  stepPct: string | null;
}

export interface StorefrontFunnelResult {
  hasData: boolean;
  /** The four funnel stages in order, top → bottom. */
  stages: FunnelStage[];
}

/** Exact 2dp percentage from two bigint magnitudes (integer basis-point math; null on ≤0 denom). */
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

interface FunnelRow {
  sessions: string | number;
  product_viewed: string | number;
  cart_added: string | number;
  purchased: string | number;
}

/**
 * computeStorefrontFunnel — the session conversion funnel over [from,to] from silver_touchpoint.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @param range   - The occurred_at window [from, to] (inclusive).
 */
export async function computeStorefrontFunnel(
  brandId: string,
  deps: { srPool: SilverPool },
  range: FunnelRange,
): Promise<StorefrontFunnelResult> {
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // One pass: distinct-session reach per stage (COUNT DISTINCT CASE — StarRocks-supported).
    const rows = await scope.runScoped<FunnelRow>(
      `SELECT
         COUNT(DISTINCT session_key) AS sessions,
         COUNT(DISTINCT CASE WHEN event_type = 'product.viewed' THEN session_key END) AS product_viewed,
         COUNT(DISTINCT CASE WHEN event_type = 'cart.item_added' THEN session_key END) AS cart_added,
         COUNT(DISTINCT CASE WHEN stitched_order_id IS NOT NULL THEN session_key END) AS purchased
       FROM brain_silver.silver_touchpoint
       WHERE occurred_at >= ? AND occurred_at <= ?
         AND ${BRAND_PREDICATE}`,
      [fromTs, toTs],
    );

    const r = rows[0];
    const sessions = r ? bi(r.sessions) : 0n;
    if (sessions <= 0n) {
      return { hasData: false, stages: [] };
    }

    const counts: { key: string; count: bigint }[] = [
      { key: 'sessions', count: sessions },
      { key: 'product_viewed', count: r ? bi(r.product_viewed) : 0n },
      { key: 'cart_added', count: r ? bi(r.cart_added) : 0n },
      { key: 'purchased', count: r ? bi(r.purchased) : 0n },
    ];

    const stages: FunnelStage[] = counts.map((c, i) => ({
      key: c.key,
      sessions: c.count,
      conversionPct: ratePct(c.count, sessions),
      stepPct: i === 0 ? null : ratePct(c.count, counts[i - 1]!.count),
    }));

    return { hasData: true, stages };
  });
}
