/**
 * @brain/metric-engine — computeCodRtoRates (GoKwik AWB-lifecycle, Track C)
 *
 * The SOLE emitter of RTO-rate metrics from the `gokwik.awb_status.v1` Bronze
 * stream (migration 0030 / GoKwik AWB trailing-window re-pull). NO ad-hoc COUNT
 * in the analytics module — this is the named compute seam (mirrors
 * computeSettlementSummary / computeOrdersTimeseries).
 *
 * AWB lifecycle (architecture plan §3): each terminal AWB transition lands a Bronze
 * row keyed `event_id = uuidV5FromAwb(brand, awb, status, status_changed_at)`. A
 * terminal status is one of RTO* / Delivered / Cancelled / Lost. The mapper stamps:
 *   payload.status            — verbatim AWB status string (e.g. 'RTO_DELIVERED')
 *   payload.is_terminal       — boolean (mapper-computed)
 *   payload.pincode           — destination pincode (may be absent → 'unknown' cohort)
 *   payload.data_source       — 'synthetic' in dev (no partner sandbox) | 'live'
 *
 * RTO% = terminal-RTO shipments ÷ all-terminal shipments, per cohort (pincode).
 *   Only TERMINAL rows count toward the denominator (an in-flight AWB has no outcome
 *   yet — counting it would understate RTO%). A pincode with no terminal rows is omitted
 *   (honest — never a fabricated 0% cohort).
 *
 * DEV-HONESTY: the AWB data source in dev is SYNTHETIC (real shape, synthetic source —
 * GoKwik partner sandbox is a platform follow-up). `dataSource` is surfaced so the BFF
 * can render the `Synthetic (dev)` badge. We NEVER present synthetic AWB data as live.
 * We compute NO numeric RTO score — GoKwik's risk_flag is categorical (recorded verbatim).
 *
 * F-SEC-02: all reads happen inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 *
 * @see db/migrations/0030_gokwik_shopflo_connectors.sql (event_type extension)
 * @see settlement-summary.ts — the sibling compute fn this mirrors
 */

import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

/** The Bronze event_type this read consumes (GoKwik AWB lifecycle). */
const AWB_EVENT_TYPE = 'gokwik.awb_status.v1';

/** Terminal AWB statuses that count as a return-to-origin outcome (prefix match on RTO). */
function isRtoStatus(status: string): boolean {
  return status.toUpperCase().startsWith('RTO');
}

/** One pincode (or cohort) RTO row. */
export interface CodRtoCohort {
  /** Destination pincode, or 'unknown' when the AWB payload carried none. */
  pincode: string;
  /** Count of terminal shipments in this cohort (the denominator). */
  terminalCount: bigint;
  /** Count of terminal-RTO shipments in this cohort (the numerator). */
  rtoCount: bigint;
  /** RTO percentage as an exact string with 2 decimals (e.g. '12.50'); null when terminalCount=0. */
  rtoRatePct: string | null;
}

export interface CodRtoRatesResult {
  /** True iff the brand has ANY terminal AWB Bronze row (honest no_data discriminant). */
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
  // (numerator * 10000) / denominator → basis points → format as NN.NN with integer math.
  const bps = (numerator * 10000n) / denominator;
  const whole = bps / 100n;
  const frac = bps % 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * computeCodRtoRates — RTO% by pincode cohort from terminal AWB Bronze rows.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns CodRtoRatesResult — hasData=false when no terminal AWB rows exist (honest no_data).
 */
export async function computeCodRtoRates(
  brandId: string,
  deps: EngineDeps,
): Promise<CodRtoRatesResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    // Per-(pincode,status) terminal counts. Only TERMINAL rows participate (is_terminal=true).
    // The aggregation lives HERE (the named seam) — the analytics module does no COUNT (ADR-002).
    // RLS scopes brand_id; the explicit WHERE is belt-and-suspenders (must agree).
    const rows = await client.query<{
      pincode: string | null;
      status: string;
      cnt: string;
      synthetic_cnt: string;
    }>(
      `SELECT
          NULLIF(payload->>'pincode', '')                       AS pincode,
          payload->>'status'                                    AS status,
          COUNT(*)::text                                        AS cnt,
          COUNT(*) FILTER (
            WHERE (payload->>'data_source') = 'synthetic'
          )::text                                               AS synthetic_cnt
        FROM bronze_events
        WHERE brand_id = $1
          AND event_type = $2
          AND (payload->>'is_terminal') = 'true'
        GROUP BY 1, 2`,
      [brandId, AWB_EVENT_TYPE],
    );

    if (rows.rows.length === 0) {
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

    for (const r of rows.rows) {
      const pincode = r.pincode ?? 'unknown';
      if (r.pincode) anyPincode = true;
      const cnt = BigInt(r.cnt);
      const isRto = isRtoStatus(r.status);

      const acc = byPincode.get(pincode) ?? { terminal: 0n, rto: 0n };
      acc.terminal += cnt;
      if (isRto) acc.rto += cnt;
      byPincode.set(pincode, acc);

      totalTerminal += cnt;
      if (isRto) totalRto += cnt;
      syntheticCount += BigInt(r.synthetic_cnt);
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
      // ANY synthetic-sourced contributing row → the whole surface is labelled synthetic (dev).
      dataSource: syntheticCount > 0n ? 'synthetic' : 'live',
      pincodePending: !anyPincode,
    };
  });
}
