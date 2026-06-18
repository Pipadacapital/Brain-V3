/**
 * @brain/metric-engine — computeOrderStatusMix (Silver order-status-mix, Tier-0).
 *
 * The SOLE emitter of the order-status-mix signal: counts + share by order
 * lifecycle_state over a date range, read from the Silver mart `silver.order_state`
 * (StarRocks brain_silver) through the Silver read seam (withSilverBrand).
 *
 * ── WHY THIS LIVES HERE, NOT IN dbt (ADR-004) ──────────────────────────────────
 * dbt produced only the ADDITIVE mart silver.order_state (latest lifecycle row per
 * order — a deterministic projection). order-status-mix is a NON-additive aggregation
 * (COUNT + share-of-total per state). Non-additive math lives in the metric-engine,
 * never in a dbt mart. This fn is the GROUP BY over the additive mart.
 *
 * ── GRAIN ──────────────────────────────────────────────────────────────────────
 * silver.order_state = 1 row per (brand_id, order_id) at its latest lifecycle_state.
 * We bound by `state_effective_at` ∈ [from, to] (the moment the order reached its
 * current state), GROUP BY lifecycle_state, and compute each state's share of the
 * total order count in the window. Money (order_value_minor) is summed per state as
 * a BIGINT minor-unit value (I-S07) paired with currency_code.
 *
 * Share math is INTEGER-ONLY (the ratePct basis-point pattern from cod-mix.ts) — no
 * float ever touches a percentage. Honest no_data: hasData=false when the brand has
 * zero Silver rows in the window (NEVER a fabricated zero-row mix).
 *
 * Isolation: the read goes through withSilverBrand, which injects the brand predicate
 * at the seam (the brand can never be forgotten). brandId is from session (D-1).
 *
 * @see packages/metric-engine/src/silver-deps.ts — the Silver read seam
 * @see packages/metric-engine/src/cod-mix.ts — the ratePct integer-share sibling
 * @see 05-architecture.md §5
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** The canonical Silver lifecycle states (matches the dbt int_order_lifecycle map). */
export type LifecycleState =
  | 'placed'
  | 'confirmed'
  | 'delivered'
  | 'cancelled'
  | 'rto'
  | 'refunded';

/** Terminal states (an order at one of these will not transition further). */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'delivered',
  'cancelled',
  'rto',
  'refunded',
]);

export interface OrderStatusMixBucket {
  /** The canonical lifecycle state. */
  lifecycleState: LifecycleState;
  /** Whether this state is terminal (no further transitions). */
  isTerminal: boolean;
  /** Order count in this state within the window. */
  count: bigint;
  /** Share of the window total order count, 2dp string; null when total ≤ 0. */
  sharePct: string | null;
  /** Sum of order_value_minor for orders in this state, BIGINT minor units (I-S07). */
  valueMinor: bigint;
}

export interface OrderStatusMixResult {
  /** True iff the brand has ANY Silver order in the window (honest no_data discriminant). */
  hasData: boolean;
  /** The brand's currency for the money column; null when no data. */
  currencyCode: CurrencyCode | null;
  /** Total order count across all states in the window. */
  total: bigint;
  /** Per-state counts + shares, ordered by the canonical state order. */
  byState: OrderStatusMixBucket[];
}

export interface OrderStatusMixRange {
  /** Inclusive lower bound on state_effective_at (UTC). */
  from: Date;
  /** Inclusive upper bound on state_effective_at (UTC). */
  to: Date;
}

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on non-positive denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** Canonical render order for states (stable UI ordering). */
const STATE_ORDER: readonly LifecycleState[] = [
  'placed',
  'confirmed',
  'delivered',
  'cancelled',
  'rto',
  'refunded',
];

interface MixRow {
  lifecycle_state: string;
  cnt: string | number;
  value_minor: string | number;
  currency_code: string | null;
}

/**
 * computeOrderStatusMix — counts + share + money by lifecycle_state over [from,to].
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool (brain_analytics).
 * @param range   - The state_effective_at window [from, to] (inclusive).
 * @returns OrderStatusMixResult — hasData=false when the window has zero Silver rows.
 */
export async function computeOrderStatusMix(
  brandId: string,
  deps: { srPool: SilverPool },
  range: OrderStatusMixRange,
): Promise<OrderStatusMixResult> {
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    // The seam substitutes ${BRAND_PREDICATE} → `brand_id = ?` (parameterized to brandId).
    // The caller NEVER writes the brand filter itself — it is the seam's job.
    return scope.runScoped<MixRow>(
      `SELECT lifecycle_state,
              COUNT(*)                       AS cnt,
              COALESCE(SUM(order_value_minor), 0) AS value_minor,
              MIN(currency_code)             AS currency_code
         FROM brain_silver.silver_order_state
        WHERE ${BRAND_PREDICATE}
          AND state_effective_at >= ?
          AND state_effective_at <= ?
        GROUP BY lifecycle_state`,
      [fromTs, toTs],
    );
  });

  if (rows.length === 0) {
    return { hasData: false, currencyCode: null, total: 0n, byState: [] };
  }

  // Assemble per-state counts/money. Money via BigInt (I-S07; throws on fractional).
  const countByState = new Map<string, bigint>();
  const valueByState = new Map<string, bigint>();
  let currencyCode: CurrencyCode | null = null;
  let total = 0n;
  for (const r of rows) {
    const state = r.lifecycle_state;
    const cnt = BigInt(String(r.cnt));
    const value = BigInt(String(r.value_minor));
    countByState.set(state, cnt);
    valueByState.set(state, value);
    total += cnt;
    if (currencyCode === null && r.currency_code) {
      currencyCode = r.currency_code as CurrencyCode;
    }
  }

  // Emit in canonical order; only states actually present appear (no fabricated zeros).
  const byState: OrderStatusMixBucket[] = STATE_ORDER.filter((s) => countByState.has(s)).map((s) => {
    const count = countByState.get(s) ?? 0n;
    return {
      lifecycleState: s,
      isTerminal: TERMINAL_STATES.has(s),
      count,
      sharePct: ratePct(count, total),
      valueMinor: valueByState.get(s) ?? 0n,
    };
  });

  return { hasData: true, currencyCode, total, byState };
}

/** Format a Date as a StarRocks DATETIME literal 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toStarRocksTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
