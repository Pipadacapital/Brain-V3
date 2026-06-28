/**
 * @brain/metric-engine — computeCheckoutFunnel (Shopflo checkout-conversion, Track C)
 *
 * The SOLE emitter of the checkout-conversion funnel signal. Reads the MULTI-SOURCE Silver mart
 * `silver_checkout_signal` (StarRocks brain_silver), signal_type='checkout_abandoned', through the
 * withSilverBrand seam. NO ad-hoc COUNT in the analytics module — this is the named compute seam (ADR-002).
 *
 * ── WHY silver_checkout_signal (re-point, payments-category Silver): the original read the raw
 *    shopflo.checkout_abandoned.v1 rows from PG bronze_events — but under the Iceberg-sole read
 *    posture those events are not in PG bronze, so that read returned empty. silver_checkout_signal is
 *    the canonical, Silver-tier home for payments/checkout signals. Shape/contract unchanged.
 *
 * The Shopflo webhook fires on `checkout_abandoned` — i.e. every row here is a checkout that did NOT
 * convert. The funnel reports, over a bounded recent window:
 *   abandonedCount   — checkouts abandoned (row count)
 *   discountApplied  — abandoned checkouts that had a discount applied (total_discount_minor > 0)
 *   withAddress      — abandoned checkouts that had reached the address step (has_address = true)
 *   abandonedValue   — SUM(total_price_minor) of abandoned carts (recoverable GMV at risk, minor units)
 *
 * PII POSTURE (I-S02): the mapper hashed email/phone at the boundary; this read NEVER touches raw PII.
 * Money: total_price_minor / total_discount_minor are BIGINT minor units (I-S07).
 * Currency: carried per-row in the Silver mart (the mapper stamps currency_code) — derived here, no PG read.
 *
 * DEV-HONESTY: Shopflo checkout_abandoned is REAL (documented self-serve webhook), so dataSource
 * reflects the actual payload stamp ('live'); is_synthetic flips it to 'synthetic' only for dev rows.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; reads go through withSilverBrand. brandId from
 * session (D-1; NEVER body).
 *
 * @see packages/metric-engine/src/cod-rto-rates.ts (sibling silver re-point) + silver-deps.ts (the seam)
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Bounded recent window for the funnel (constant — never user-interpolated). */
const FUNNEL_WINDOW_DAYS = 30;

export interface CheckoutFunnelResult {
  /** True iff the brand has ANY checkout_abandoned row in the window (honest no_data). */
  hasData: boolean;
  currencyCode: CurrencyCode | null;
  /** Checkouts abandoned in the window. */
  abandonedCount: bigint;
  /** Of those, how many had a discount applied (total_discount_minor > 0). */
  discountAppliedCount: bigint;
  /** Of those, how many had reached the address step (has_address = true). */
  withAddressCount: bigint;
  /** SUM(total_price_minor) of abandoned carts — recoverable GMV at risk, minor units. */
  abandonedValueMinor: bigint;
  /** 'synthetic' if any contributing row is synthetic-stamped; 'live' otherwise (real Shopflo = 'live'). */
  dataSource: 'synthetic' | 'live';
}

interface CheckoutFunnelRow {
  abandoned: string | number;
  discount_applied: string | number;
  with_address: string | number;
  abandoned_value: string | number;
  synthetic_cnt: string | number;
  currency_code: string | null;
}

/**
 * computeCheckoutFunnel — abandoned-checkout funnel over a bounded window.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2) — silver_checkout_signal via withSilverBrand.
 * @returns CheckoutFunnelResult — hasData=false when no rows in the window (honest no_data).
 */
export async function computeCheckoutFunnel(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CheckoutFunnelResult> {
  // All aggregation happens at the named seam. Counts + minor-unit money sum + the per-row currency.
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) =>
    scope.runScoped<CheckoutFunnelRow>(
      `SELECT
          COUNT(*)                                                              AS abandoned,
          SUM(CASE WHEN COALESCE(total_discount_minor, 0) > 0 THEN 1 ELSE 0 END) AS discount_applied,
          SUM(CASE WHEN has_address THEN 1 ELSE 0 END)                          AS with_address,
          COALESCE(SUM(total_price_minor), 0)                                   AS abandoned_value,
          SUM(CASE WHEN is_synthetic THEN 1 ELSE 0 END)                         AS synthetic_cnt,
          MAX(currency_code)                                                    AS currency_code
        FROM brain_serving.mv_silver_checkout_signal
        WHERE signal_type = 'checkout_abandoned'
          AND occurred_at >= (NOW() - INTERVAL '${FUNNEL_WINDOW_DAYS}' DAY)
          AND ${BRAND_PREDICATE}`,
      [],
    ),
  );

  const row = rows[0];
  const abandonedCount = BigInt(String(row?.abandoned ?? '0'));
  const currencyCode = (row?.currency_code ?? null) as CurrencyCode | null;

  if (abandonedCount === 0n || currencyCode === null) {
    return {
      hasData: false,
      currencyCode,
      abandonedCount: 0n,
      discountAppliedCount: 0n,
      withAddressCount: 0n,
      abandonedValueMinor: 0n,
      dataSource: 'live',
    };
  }

  return {
    hasData: true,
    currencyCode,
    abandonedCount,
    discountAppliedCount: BigInt(String(row?.discount_applied ?? '0')),
    withAddressCount: BigInt(String(row?.with_address ?? '0')),
    // abandoned_value is an integer minor-unit sum → BigInt-safe (strip any decimal artifact).
    abandonedValueMinor: BigInt(String(row?.abandoned_value ?? '0').split('.')[0] ?? '0'),
    dataSource: BigInt(String(row?.synthetic_cnt ?? '0')) > 0n ? 'synthetic' : 'live',
  };
}
