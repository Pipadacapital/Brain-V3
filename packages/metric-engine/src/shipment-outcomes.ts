/**
 * @brain/metric-engine — computeShipmentOutcomes (Silver shipment RTO/courier rollup, Tier-0).
 *
 * The SOLE emitter of the logistics shipment-outcome signal: delivered / RTO / other / in-transit
 * counts + RTO% (overall, by courier, by pincode) over a date window, read from the Silver mart
 * `silver_shipment` (StarRocks brain_silver) through the Silver read seam (withSilverBrand).
 *
 * Multi-source by construction: silver_shipment folds GoKwik AWB + Shiprocket tracking through the
 * shared @brain/logistics-status terminal_class authority, so this one metric serves every source.
 *
 * ── WHY THIS LIVES HERE, NOT IN dbt (ADR-004) ──────────────────────────────────
 * dbt produced the ADDITIVE marts silver_shipment_event (per-transition) + silver_shipment
 * (latest-state). "RTO%" and the courier/pincode rollups are NON-additive (COUNT + ratio + rank).
 * Non-additive math lives in the metric-engine, never in a dbt mart.
 *
 * ── INTEGER-ONLY RATE ──────────────────────────────────────────────────────────
 * RTO% is integer basis-point math (no float). RTO% denominator = delivered + rto (the resolved
 * CoD outcome base); in-transit/other are reported but excluded from the rate denominator.
 *
 * ── HONEST NO_DATA ─────────────────────────────────────────────────────────────
 * hasData=false when the brand has zero shipment rows in the window (NEVER a fabricated zero).
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────────
 * Every read goes through withSilverBrand (brand predicate injected at the seam). brandId is from
 * session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/silver-deps.ts — the Silver read seam
 * @see packages/metric-engine/src/journey-mix.ts — the ratePct integer-share sibling
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface ShipmentRange {
  from: Date;
  to: Date;
}

export interface CourierOutcome {
  courier: string;
  delivered: bigint;
  rto: bigint;
  /** rto ÷ (delivered + rto), 2dp string; null when the resolved base is 0. */
  rtoPct: string | null;
}

export interface PincodeOutcome {
  pincode: string;
  delivered: bigint;
  rto: bigint;
  rtoPct: string | null;
}

export interface ShipmentOutcomesResult {
  /** True iff the brand has ANY shipment in the window (honest no_data). */
  hasData: boolean;
  total: bigint;
  delivered: bigint;
  rto: bigint;
  other: bigint;
  /** Non-terminal (still in flight) shipments in the window. */
  inTransit: bigint;
  /** rto ÷ (delivered + rto), 2dp string; null when the resolved base is 0. */
  rtoPct: string | null;
  /** Per-courier outcomes (couriers present on the rows; empty until a courier-bearing source lands). */
  byCourier: CourierOutcome[];
  /** Top pincode cohorts by shipment volume. */
  byPincode: PincodeOutcome[];
}

const MAX_PINCODE_COHORTS = 20;

/** Exact 2-decimal percentage from two bigint magnitudes (integer math; null on non-positive denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator <= 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  const absFrac = frac < 0n ? -frac : frac;
  return `${whole}.${String(absFrac).padStart(2, '0')}`;
}

/** Format a Date as a StarRocks DATETIME literal 'YYYY-MM-DD HH:MM:SS' (UTC). */
function toStarRocksTs(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function bi(v: unknown): bigint {
  return BigInt(String(v ?? '0'));
}

interface SummaryRow {
  total: string | number;
  delivered: string | number;
  rto: string | number;
  other: string | number;
  in_transit: string | number;
}

interface GroupRow {
  k: string | null;
  delivered: string | number;
  rto: string | number;
}

/**
 * computeShipmentOutcomes — delivered/RTO/other/in-transit counts + RTO% (overall, by courier, by
 * pincode) over [from,to], from silver_shipment. last_status_at is the window key.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @param range   - The last_status_at window [from, to] (inclusive).
 */
export async function computeShipmentOutcomes(
  brandId: string,
  deps: { srPool: SilverPool },
  range: ShipmentRange,
): Promise<ShipmentOutcomesResult> {
  const fromTs = toStarRocksTs(range.from);
  const toTs = toStarRocksTs(range.to);

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<SummaryRow>(
      `SELECT
          COUNT(*)                                                   AS total,
          COALESCE(SUM(CASE WHEN terminal_class = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
          COALESCE(SUM(CASE WHEN terminal_class = 'rto'       THEN 1 ELSE 0 END), 0) AS rto,
          COALESCE(SUM(CASE WHEN terminal_class = 'other'     THEN 1 ELSE 0 END), 0) AS other,
          COALESCE(SUM(CASE WHEN terminal_class = 'none'      THEN 1 ELSE 0 END), 0) AS in_transit
        FROM brain_silver.silver_shipment
        WHERE last_status_at >= ?
          AND last_status_at <= ?
          AND ${BRAND_PREDICATE}`,
      [fromTs, toTs],
    );

    const s = summaryRows[0];
    const total = s ? bi(s.total) : 0n;
    if (total <= 0n) {
      return {
        hasData: false, total: 0n, delivered: 0n, rto: 0n, other: 0n, inTransit: 0n,
        rtoPct: null, byCourier: [], byPincode: [],
      };
    }
    const delivered = bi(s!.delivered);
    const rto = bi(s!.rto);
    const other = bi(s!.other);
    const inTransit = bi(s!.in_transit);

    const courierRows = await scope.runScoped<GroupRow>(
      `SELECT courier AS k,
              COALESCE(SUM(CASE WHEN terminal_class = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
              COALESCE(SUM(CASE WHEN terminal_class = 'rto'       THEN 1 ELSE 0 END), 0) AS rto
        FROM brain_silver.silver_shipment
        WHERE last_status_at >= ?
          AND last_status_at <= ?
          AND courier IS NOT NULL AND courier <> ''
          AND ${BRAND_PREDICATE}
        GROUP BY courier
        ORDER BY rto DESC, delivered DESC`,
      [fromTs, toTs],
    );

    const pincodeRows = await scope.runScoped<GroupRow>(
      `SELECT pincode AS k,
              COALESCE(SUM(CASE WHEN terminal_class = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered,
              COALESCE(SUM(CASE WHEN terminal_class = 'rto'       THEN 1 ELSE 0 END), 0) AS rto
        FROM brain_silver.silver_shipment
        WHERE last_status_at >= ?
          AND last_status_at <= ?
          AND pincode IS NOT NULL AND pincode <> ''
          AND ${BRAND_PREDICATE}
        GROUP BY pincode
        ORDER BY (COALESCE(SUM(CASE WHEN terminal_class IN ('delivered','rto') THEN 1 ELSE 0 END),0)) DESC
        LIMIT ${MAX_PINCODE_COHORTS}`,
      [fromTs, toTs],
    );

    const byCourier: CourierOutcome[] = courierRows
      .filter((r) => r.k)
      .map((r) => {
        const d = bi(r.delivered);
        const rt = bi(r.rto);
        return { courier: String(r.k), delivered: d, rto: rt, rtoPct: ratePct(rt, d + rt) };
      });

    const byPincode: PincodeOutcome[] = pincodeRows
      .filter((r) => r.k)
      .map((r) => {
        const d = bi(r.delivered);
        const rt = bi(r.rto);
        return { pincode: String(r.k), delivered: d, rto: rt, rtoPct: ratePct(rt, d + rt) };
      });

    return {
      hasData: true,
      total,
      delivered,
      rto,
      other,
      inTransit,
      rtoPct: ratePct(rto, delivered + rto),
      byCourier,
      byPincode,
    };
  });
}
