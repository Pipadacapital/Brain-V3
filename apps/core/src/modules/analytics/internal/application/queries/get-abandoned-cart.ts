/**
 * getAbandonedCart — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeAbandonedCart (metric engine) — REPOINTED in Brain V4 to read the
 * pre-materialized Gold mart gold_abandoned_cart through the Trino serving view
 * brain_serving.mv_gold_abandoned_cart (via withSilverBrand), instead of recomputing over
 * silver_touchpoint at request time. NO ad-hoc COUNT here (D-3). Serializes bigint → string (D-1),
 * echoes the range, shapes the honest no_data discriminant. The response shape is UNCHANGED.
 *
 * I-ST01: metric-engine is the SOLE serving reader; the UI reaches the Gold mart only through
 * BFF → this use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/storefront-abandoned-cart.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeAbandonedCart } from '@brain/metric-engine';

export type AbandonedCartResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;
      to: string;
      cart_sessions: string;
      converted_sessions: string;
      abandoned_sessions: string;
      abandonment_rate_pct: string | null;
      recovery_rate_pct: string | null;
      data_source: 'synthetic' | 'live';
    };

export interface AbandonedCartParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  dataSource: 'synthetic' | 'live';
}

export async function getAbandonedCart(
  brandId: string,
  deps: { srPool: SilverPool },
  params: AbandonedCartParams,
): Promise<AbandonedCartResult> {
  const r = await computeAbandonedCart(brandId, deps, { from: params.from, to: params.to });

  if (!r.hasData) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    cart_sessions: String(r.cartSessions),
    converted_sessions: String(r.convertedSessions),
    abandoned_sessions: String(r.abandonedSessions),
    abandonment_rate_pct: r.abandonmentRatePct,
    recovery_rate_pct: r.recoveryRatePct,
    data_source: params.dataSource,
  };
}
