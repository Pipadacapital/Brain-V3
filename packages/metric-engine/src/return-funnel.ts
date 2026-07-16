/**
 * @brain/metric-engine — computeReturnFunnel (Silver RETURN lifecycle rollup, SR-10).
 *
 * The SOLE emitter of the logistics RETURN signal: a per-return_class breakdown + completion rate over a
 * date window, read from the Silver mart `silver_return` (SR-4) through the Trino serving view
 * brain_serving.mv_silver_return via the Silver read seam (withSilverBrand).
 *
 * ── WHY A SEPARATE METRIC FROM computeShipmentOutcomes ─────────────────────────
 * Returns are a SEPARATE lifecycle that must NEVER be confused with forward delivery / RTO. The return
 * mart carries NO terminal_class (by design) — a return "delivered"/"completed" means delivered-BACK /
 * refund-closed, not a sale. So this metric reads return_class ∈ {return_initiated, return_in_transit,
 * return_delivered, return_completed, none}, NEVER terminal_class. This is the queryable proof of the
 * SR-4 false-delivery fix.
 *
 * ── INTEGER-ONLY RATE ──────────────────────────────────────────────────────────
 * completion% is integer basis-point math (no float): completed ÷ total.
 *
 * ── HONEST NO_DATA ─────────────────────────────────────────────────────────────
 * hasData=false when the brand has zero return rows in the window (NEVER a fabricated zero).
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────────
 * Every read goes through withSilverBrand (brand predicate injected at the seam). brandId is from
 * session (D-1; NEVER body). Windowed on first_event_at (the return's first observed transition).
 *
 * @see packages/metric-engine/src/shipment-outcomes.ts — the forward-shipment sibling
 * @see db/iceberg/spark/silver/silver_return.py — the mart
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface ReturnRange {
  from: Date;
  to: Date;
}

/** The canonical return_class buckets (from @brain/logistics-status classifyReturnStatus). */
export type ReturnClass =
  | 'return_initiated'
  | 'return_in_transit'
  | 'return_delivered'
  | 'return_completed'
  | 'none';

export interface ReturnClassBucket {
  return_class: ReturnClass;
  count: bigint;
}

export interface ReturnCourierBucket {
  courier: string;
  total: bigint;
  completed: bigint;
}

export interface ReturnFunnelResult {
  /** True iff the brand has ANY return in the window (honest no_data). */
  hasData: boolean;
  total: bigint;
  /** is_return_complete = true (refund/return closed). */
  completed: bigint;
  /** Currently still in the return pipeline (return_class <> 'return_completed'). */
  inProgress: bigint;
  /** completed ÷ total, 2dp string; null when total is 0. */
  completionPct: string | null;
  /** Count of returns currently at each return_class (ordered initiated→completed). */
  byClass: ReturnClassBucket[];
  /** Returns by courier (which courier drives the most returns). */
  byCourier: ReturnCourierBucket[];
}

const MAX_COURIER_COHORTS = 20;

const RETURN_CLASS_ORDER: ReturnClass[] = [
  'return_initiated',
  'return_in_transit',
  'return_delivered',
  'return_completed',
  'none',
];

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on non-positive denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** Format a Date as a Trino-friendly DATETIME literal 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function bi(v: unknown): bigint {
  return BigInt(String(v ?? '0'));
}

interface ClassRow {
  return_class: string | null;
  count: string | number;
}

interface SummaryRow {
  total: string | number;
  completed: string | number;
}

interface CourierRow {
  k: string | null;
  total: string | number;
  completed: string | number;
}

/**
 * computeReturnFunnel — per-return_class counts + completion% over [from,to], from silver_return.
 * first_event_at is the window key.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the Trino pool.
 * @param range   - The first_event_at window [from, to] (inclusive).
 */
export async function computeReturnFunnel(
  brandId: string,
  deps: { srPool: SilverPool },
  range: ReturnRange,
): Promise<ReturnFunnelResult> {
  const fromTs = toTs(range.from);
  const toTs2 = toTs(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<SummaryRow>(
      `SELECT
          COUNT(*)                                                            AS total,
          COALESCE(SUM(CASE WHEN is_return_complete = true THEN 1 ELSE 0 END), 0) AS completed
        FROM brain_serving.mv_silver_return
        WHERE CAST(first_event_at AS TIMESTAMPTZ) >= ?
          AND CAST(first_event_at AS TIMESTAMPTZ) <= ?
          AND ${BRAND_PREDICATE}`,
      [fromTs, toTs2],
    );

    const s = summaryRows[0];
    const total = s ? bi(s.total) : 0n;
    if (total <= 0n) {
      return {
        hasData: false, total: 0n, completed: 0n, inProgress: 0n,
        completionPct: null, byClass: [], byCourier: [],
      };
    }
    const completed = bi(s!.completed);
    const inProgress = total - completed;

    const classRows = await scope.runScoped<ClassRow>(
      `SELECT return_class, COUNT(*) AS count
        FROM brain_serving.mv_silver_return
        WHERE CAST(first_event_at AS TIMESTAMPTZ) >= ?
          AND CAST(first_event_at AS TIMESTAMPTZ) <= ?
          AND ${BRAND_PREDICATE}
        GROUP BY return_class`,
      [fromTs, toTs2],
    );

    const counts = new Map<string, bigint>();
    for (const r of classRows) {
      counts.set(String(r.return_class ?? 'none'), bi(r.count));
    }
    // Deterministic funnel order; only emit buckets that actually have rows.
    const byClass: ReturnClassBucket[] = RETURN_CLASS_ORDER
      .filter((rc) => (counts.get(rc) ?? 0n) > 0n)
      .map((rc) => ({ return_class: rc, count: counts.get(rc) ?? 0n }));

    const courierRows = await scope.runScoped<CourierRow>(
      `SELECT courier AS k,
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN is_return_complete = true THEN 1 ELSE 0 END), 0) AS completed
        FROM brain_serving.mv_silver_return
        WHERE CAST(first_event_at AS TIMESTAMPTZ) >= ?
          AND CAST(first_event_at AS TIMESTAMPTZ) <= ?
          AND courier IS NOT NULL AND courier <> ''
          AND ${BRAND_PREDICATE}
        GROUP BY courier
        ORDER BY total DESC
        LIMIT ${MAX_COURIER_COHORTS}`,
      [fromTs, toTs2],
    );

    const byCourier: ReturnCourierBucket[] = courierRows
      .filter((r) => r.k)
      .map((r) => ({ courier: String(r.k), total: bi(r.total), completed: bi(r.completed) }));

    return {
      hasData: true,
      total,
      completed,
      inProgress,
      completionPct: ratePct(completed, total),
      byClass,
      byCourier,
    };
  });
}
