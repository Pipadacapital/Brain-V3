/**
 * @brain/metric-engine — computeStorefrontEngagement (Silver touchpoint engagement rollup, Tier-0).
 *
 * The SOLE emitter of the storefront-engagement signal (Phase H pixel): how deeply sessions engage —
 * engaged (multi-touch) vs bounced (single-touch) sessions + average touches per session, over a date
 * window, read from silver_touchpoint (StarRocks brain_silver) via the withSilverBrand seam.
 *
 * DEFINITIONS (session grain): silver_touchpoint carries the browse events (page/product/collection/
 * cart.viewed, cart.item_added, search.submitted) — so engagement is measured by touch DEPTH:
 *   engaged session — a session with >1 touch (interacted beyond a single landing view).
 *   bounce session  — a session with exactly 1 touch.
 *   avg_touches     — total touches ÷ sessions (browse depth), 2dp.
 *
 * ── WHY HERE, NOT dbt (ADR-004): silver_touchpoint is the additive per-touch projection; these are
 *    NON-additive aggregations (COUNT DISTINCT / avg / rate) → metric-engine, never a dbt mart.
 * ── INTEGER-ONLY math (no float). Honest no_data: hasData=false when zero sessions in the window.
 * ── ISOLATION: every read via withSilverBrand (brand predicate at the seam). brandId from session.
 *
 * @see packages/metric-engine/src/storefront-funnel.ts (sibling silver_touchpoint reader)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface EngagementRange {
  from: Date;
  to: Date;
}

export interface StorefrontEngagementResult {
  hasData: boolean;
  sessions: bigint;
  touches: bigint;
  /** Sessions with >1 touch. */
  engagedSessions: bigint;
  /** Sessions with exactly 1 touch. */
  bounceSessions: bigint;
  /** engaged ÷ sessions × 100, 2dp; null when sessions = 0. */
  engagementRatePct: string | null;
  /** bounce ÷ sessions × 100, 2dp; null when sessions = 0. */
  bounceRatePct: string | null;
  /** touches ÷ sessions as a 2dp ratio (e.g. "2.50"); null when sessions = 0. */
  avgTouchesPerSession: string | null;
}

/** Percentage (num/den × 100) as a 2dp string; integer basis-point math; null on ≤0 denom. */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** Plain ratio (num/den) as a 2dp string (NOT a percentage); integer math; null on ≤0 denom. */
function ratio2dp(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const scaled = (numerator * 100n) / denominator;
  const whole = scaled / 100n;
  const frac = scaled % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

function toStarRocksTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function bi(v: unknown): bigint {
  return BigInt(String(v ?? '0'));
}

interface EngagementRow {
  sessions: string | number;
  touches: string | number;
  engaged: string | number;
}

/**
 * computeStorefrontEngagement — engagement-depth rollup over [from,to] from silver_touchpoint.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @param range   - The occurred_at window [from, to] (inclusive).
 */
export async function computeStorefrontEngagement(
  brandId: string,
  deps: { srPool: SilverPool },
  range: EngagementRange,
): Promise<StorefrontEngagementResult> {
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // Per-session touch count first, then roll up sessions / touches / engaged.
    const rows = await scope.runScoped<EngagementRow>(
      `SELECT
         COUNT(*) AS sessions,
         SUM(touches) AS touches,
         SUM(CASE WHEN touches > 1 THEN 1 ELSE 0 END) AS engaged
       FROM (
         SELECT session_key, COUNT(*) AS touches
           FROM brain_serving.mv_silver_touchpoint
          WHERE occurred_at >= ? AND occurred_at <= ?
            AND ${BRAND_PREDICATE}
          GROUP BY session_key
       ) s`,
      [fromTs, toTs],
    );

    const r = rows[0];
    const sessions = r ? bi(r.sessions) : 0n;
    if (sessions <= 0n) {
      return {
        hasData: false,
        sessions: 0n,
        touches: 0n,
        engagedSessions: 0n,
        bounceSessions: 0n,
        engagementRatePct: null,
        bounceRatePct: null,
        avgTouchesPerSession: null,
      };
    }

    const touches = r ? bi(r.touches) : 0n;
    const engagedSessions = r ? bi(r.engaged) : 0n;
    const bounceSessions = sessions - engagedSessions;

    return {
      hasData: true,
      sessions,
      touches,
      engagedSessions,
      bounceSessions,
      engagementRatePct: ratePct(engagedSessions, sessions),
      bounceRatePct: ratePct(bounceSessions, sessions),
      avgTouchesPerSession: ratio2dp(touches, sessions),
    };
  });
}
