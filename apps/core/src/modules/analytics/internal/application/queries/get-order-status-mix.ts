/**
 * getOrderStatusMix — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeOrderStatusMix (metric engine), the FIRST read
 * from the Silver tier (silver.order_state, StarRocks brain_silver) through the
 * withSilverBrand seam. NO ad-hoc COUNT/SUM here (D-3 / ADR-002) — the metric-engine
 * seam owns the non-additive aggregation (ADR-004: it does NOT live in dbt).
 *
 * Serializes bigint → string (D-1), echoes the [from,to] range, derives terminal_count,
 * and shapes the honest no_data discriminant. Money fields are bigint-serialized minor
 * units (I-S07) — never /100, never float.
 *
 * DEV-HONESTY: data_source is supplied by the caller (BFF). In dev the underlying
 * ledger cod_* rows folded into Silver are SYNTHETIC (real shape, synthetic source),
 * so the BFF passes 'synthetic'. We do not invent a flag here.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; the UI reaches Silver only
 * through BFF → this use-case → withSilverBrand. brandId is from session (D-1).
 *
 * @see packages/metric-engine/src/order-status-mix.ts
 * @see packages/metric-engine/src/silver-deps.ts (the Silver read seam)
 */

import type { SilverPool, LifecycleState } from '@brain/metric-engine';
import { computeOrderStatusMix } from '@brain/metric-engine';

/** Terminal lifecycle states (matches the engine's canonical terminal set). */
const TERMINAL: ReadonlySet<LifecycleState> = new Set(['delivered', 'cancelled', 'rto', 'refunded']);

export interface OrderStatusMixRowDto {
  lifecycle_state: LifecycleState;
  count: string;            // bigint → string
  share_pct: string | null; // 2dp string; null when total = 0
  value_minor: string;      // bigint → string (minor units, I-S07)
}

export type OrderStatusMixResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;            // YYYY-MM-DD (echoed range)
      to: string;              // YYYY-MM-DD
      currency_code: string;   // ISO 4217 — single brand currency (Slice 1)
      total: string;           // bigint → string
      terminal_count: string;  // bigint → string
      by_state: OrderStatusMixRowDto[];
      data_source: 'synthetic' | 'live';
    };

export interface OrderStatusMixParams {
  /** Inclusive window on state_effective_at. */
  from: Date;
  to: Date;
  /** Echoed back to the client as YYYY-MM-DD (the canonical day strings the BFF parsed). */
  fromStr: string;
  toStr: string;
  /** Source-honesty flag for the Synthetic (dev) badge — supplied by the BFF. */
  dataSource: 'synthetic' | 'live';
}

/**
 * getOrderStatusMix — a brand's order-status mix (counts + share + money) over a window.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2, brain_analytics).
 * @param params  - The window + echoed date strings + data_source flag.
 */
export async function getOrderStatusMix(
  brandId: string,
  deps: { srPool: SilverPool },
  params: OrderStatusMixParams,
): Promise<OrderStatusMixResult> {
  const result = await computeOrderStatusMix(brandId, deps, { from: params.from, to: params.to });

  if (!result.hasData || result.currencyCode === null) {
    return { state: 'no_data' };
  }

  let terminalCount = 0n;
  const by_state: OrderStatusMixRowDto[] = result.byState.map((b) => {
    if (b.isTerminal) terminalCount += b.count;
    return {
      lifecycle_state: b.lifecycleState,
      count: String(b.count),
      share_pct: b.sharePct,
      value_minor: String(b.valueMinor),
    };
  });

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    currency_code: result.currencyCode,
    total: String(result.total),
    terminal_count: String(terminalCount),
    by_state,
    data_source: params.dataSource,
  };
}
