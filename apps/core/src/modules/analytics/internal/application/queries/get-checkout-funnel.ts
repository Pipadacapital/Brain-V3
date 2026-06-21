/**
 * getCheckoutFunnel — analytics use-case (ADR-002 sole-read-path, Shopflo Track C).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeCheckoutFunnel (metric engine). NO ad-hoc COUNT
 * (D-3). Serializes bigint → string (D-1) and shapes the honest no_data discriminant.
 *
 * Shopflo checkout_abandoned is REAL (documented self-serve webhook) → data_source
 * reflects the actual payload stamp ('live' for the real webhook).
 *
 * I-ST01 / isolation: the engine reads silver_checkout_signal via withSilverBrand (brand predicate
 * injected at the seam). Brand from session (D-1).
 *
 * @see packages/metric-engine/src/checkout-funnel.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeCheckoutFunnel } from '@brain/metric-engine';

export type CheckoutFunnelResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      currency_code: string;
      abandoned_count: string;          // bigint → string
      discount_applied_count: string;   // bigint → string
      with_address_count: string;       // bigint → string
      abandoned_value_minor: string;    // bigint → string (minor units)
      data_source: 'synthetic' | 'live';
    };

/**
 * getCheckoutFunnel — returns a brand's abandoned-checkout funnel.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2) — silver_checkout_signal via withSilverBrand.
 */
export async function getCheckoutFunnel(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CheckoutFunnelResult> {
  const result = await computeCheckoutFunnel(brandId, deps);

  if (!result.hasData || result.currencyCode === null) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    currency_code: result.currencyCode,
    abandoned_count: String(result.abandonedCount),
    discount_applied_count: String(result.discountAppliedCount),
    with_address_count: String(result.withAddressCount),
    abandoned_value_minor: String(result.abandonedValueMinor),
    data_source: result.dataSource,
  };
}
