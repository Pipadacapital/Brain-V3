/**
 * getAbandonedCart — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin wrapper around computeAbandonedCart (metric engine) — a read from silver_touchpoint via the
 * withSilverBrand seam. NO ad-hoc COUNT here (D-3). Serializes bigint → string (D-1), echoes the
 * range, shapes the honest no_data discriminant.
 *
 * I-ST01: metric-engine is the SOLE Silver reader; the UI reaches Silver only through BFF → this
 * use-case → withSilverBrand. brandId is from session (D-1; NEVER body).
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
