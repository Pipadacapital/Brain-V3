/**
 * @brain/metric-engine — computeCodRtoRates (RTO% by pincode cohort, Track C)
 *
 * The SOLE emitter of RTO-rate metrics — terminal-RTO ÷ all-terminal shipments per pincode cohort —
 * read from the MULTI-SOURCE Silver mart `silver_shipment` (StarRocks brain_silver) through the
 * withSilverBrand seam. silver_shipment folds every logistics source (GoKwik AWB + Shiprocket) via
 * the shared @brain/logistics-status terminal_class authority, so this one metric serves all sources.
 *
 * ── WHY silver_shipment (re-point, ADR-0002): the original read the raw gokwik.awb_status.v1 rows
 *    from PG bronze_events — but under the Iceberg-sole read posture those AWB events are not in PG
 *    bronze, so that read returned empty. silver_shipment (Slice 2) is the canonical, multi-source,
 *    Silver-tier home for shipment outcomes and is the correct seam. Shape/contract is unchanged.
 *
 * RTO% = terminal-RTO shipments ÷ all-terminal shipments, per cohort (pincode). Only TERMINAL rows
 *   count (in-flight shipments have no outcome). A pincode with no terminal rows is omitted (honest).
 *   No numeric RTO score is fabricated — terminal_class is the deterministic categorical outcome.
 *
 * DEV-HONESTY: dataSource='synthetic' when ANY contributing row is synthetic-sourced (silver_shipment
 * is_synthetic), so the BFF renders the Synthetic (dev) badge. Never present synthetic as live.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; reads go through withSilverBrand (brand
 * predicate injected at the seam). brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/shipment-outcomes.ts (sibling silver_shipment reader)
 * @see packages/metric-engine/src/silver-deps.ts (the Silver read seam)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** One pincode (or cohort) RTO row. */
export interface CodRtoCohort {
  /** Destination pincode, or 'unknown' when the shipment carried none. */
  pincode: string;
  /** Count of terminal shipments in this cohort (the denominator). */
  terminalCount: bigint;
  /** Count of terminal-RTO shipments in this cohort (the numerator). */
  rtoCount: bigint;
  /** RTO percentage as an exact string with 2 decimals (e.g. '12.50'); null when terminalCount=0. */
  rtoRatePct: string | null;
}

export interface CodRtoRatesResult {
  /** True iff the brand has ANY terminal shipment (honest no_data discriminant). */
  hasData: boolean;
  /** Overall RTO% across all cohorts (terminal-RTO ÷ terminal), 2dp string; null when no terminal rows. */
  overallRtoRatePct: string | null;
  /** Total terminal shipments observed. */
  totalTerminal: bigint;
  /** Total terminal-RTO shipments observed. */
  totalRto: bigint;
  /** Per-pincode breakdown, descending by RTO count then terminal count. */
  cohorts: CodRtoCohort[];
  /** 'synthetic' if ANY contributing row is synthetic-sourced (dev) → drives the UI badge; 'live' otherwise. */
  dataSource: 'synthetic' | 'live';
  /** True if NO row carried a pincode (cohort breakdown is degraded to overall-only). */
  pincodePending: boolean;
}

/** Exact 2-decimal percentage from two bigint counts (no float accumulation; null on zero denom). */
function ratePct(numerator: bigint, denominator: bigint): string | null {
  if (denominator === 0n) return null;
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

interface ShipmentCohortRow {
  pincode: string | null;
  terminal_class: string;
  cnt: string | number;
  synthetic_cnt: string | number;
}

/**
 * computeCodRtoRates — RTO% by pincode cohort from terminal shipment rows (silver_shipment).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - SilverDeps with the StarRocks mysql2 pool.
 * @returns CodRtoRatesResult — hasData=false when no terminal shipment rows exist (honest no_data).
 */
export async function computeCodRtoRates(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CodRtoRatesResult> {
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
    scope.runScoped<ShipmentCohortRow>(
      `SELECT pincode,
              terminal_class,
              COUNT(*)                                          AS cnt,
              COALESCE(SUM(CASE WHEN is_synthetic THEN 1 ELSE 0 END), 0) AS synthetic_cnt
         FROM brain_serving.mv_silver_shipment
        WHERE is_terminal = TRUE
          AND ${BRAND_PREDICATE}
        GROUP BY pincode, terminal_class`,
      [],
    ),
  );

  if (rows.length === 0) {
    return {
      hasData: false,
      overallRtoRatePct: null,
      totalTerminal: 0n,
      totalRto: 0n,
      cohorts: [],
      dataSource: 'live',
      pincodePending: false,
    };
  }

  // Fold rows into per-pincode {terminal, rto} accumulators.
  const byPincode = new Map<string, { terminal: bigint; rto: bigint }>();
  let totalTerminal = 0n;
  let totalRto = 0n;
  let syntheticCount = 0n;
  let anyPincode = false;

  for (const r of rows) {
    const hasPincode = r.pincode !== null && String(r.pincode).trim() !== '';
    const pincode = hasPincode ? String(r.pincode) : 'unknown';
    if (hasPincode) anyPincode = true;
    const cnt = BigInt(String(r.cnt));
    const isRto = r.terminal_class === 'rto';

    const acc = byPincode.get(pincode) ?? { terminal: 0n, rto: 0n };
    acc.terminal += cnt;
    if (isRto) acc.rto += cnt;
    byPincode.set(pincode, acc);

    totalTerminal += cnt;
    if (isRto) totalRto += cnt;
    syntheticCount += BigInt(String(r.synthetic_cnt));
  }

  const cohorts: CodRtoCohort[] = Array.from(byPincode.entries())
    .map(([pincode, acc]) => ({
      pincode,
      terminalCount: acc.terminal,
      rtoCount: acc.rto,
      rtoRatePct: ratePct(acc.rto, acc.terminal),
    }))
    .sort((a, b) => {
      if (b.rtoCount !== a.rtoCount) return b.rtoCount > a.rtoCount ? 1 : -1;
      return b.terminalCount > a.terminalCount ? 1 : -1;
    });

  return {
    hasData: true,
    overallRtoRatePct: ratePct(totalRto, totalTerminal),
    totalTerminal,
    totalRto,
    cohorts,
    dataSource: syntheticCount > 0n ? 'synthetic' : 'live',
    pincodePending: !anyPincode,
  };
}
