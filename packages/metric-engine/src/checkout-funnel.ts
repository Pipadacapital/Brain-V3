/**
 * @brain/metric-engine — computeCheckoutFunnel (Shopflo checkout-conversion, Track C)
 *
 * The SOLE emitter of the checkout-conversion funnel signal. Reads the
 * `shopflo.checkout_abandoned.v1` Bronze stream (migration 0030 / the REAL Shopflo
 * self-serve webhook — this domain is NOT synthetic). NO ad-hoc COUNT in the analytics
 * module — this is the named compute seam (ADR-002).
 *
 * The Shopflo webhook fires on `checkout_abandoned` — i.e. every Bronze row here is a
 * checkout that did NOT convert (the documented payload). The funnel therefore reports,
 * over a bounded recent window:
 *   abandonedCount   — checkouts abandoned (Bronze row count)
 *   discountApplied  — abandoned checkouts that had a discount applied
 *                      (total_discount_minor > 0) — the discount-leakage signal
 *   withAddress      — abandoned checkouts that had reached the address step
 *                      (payload.has_address = true) — addressless-abandon vs late-abandon
 *   abandonedValue   — SUM(total_price_minor) of abandoned carts (recoverable GMV at risk)
 *
 * PII POSTURE (I-S02): the mapper hashed email/phone at the boundary; this read NEVER
 * touches raw PII — only counts + minor-unit money aggregates leave the query.
 *
 * Money: total_price_minor / total_discount_minor are BIGINT minor units (I-S07).
 *
 * DEV-HONESTY: Shopflo checkout_abandoned is REAL (documented self-serve webhook), so
 * this surface is NOT synthetic-labelled — dataSource reflects the actual payload stamp
 * ('live' for the real webhook). We surface it for consistency with the other reads.
 *
 * F-SEC-02: reads inside withBrandTxn (GUC transaction-scoped, RLS-enforced).
 *
 * @see db/migrations/0030_gokwik_shopflo_connectors.sql / shopflo-mapper
 * @see get-tracking-health.ts — the sibling bronze-derived read pattern
 */

import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

/** The Bronze event_type this read consumes (Shopflo abandoned checkout). */
const CHECKOUT_EVENT_TYPE = 'shopflo.checkout_abandoned.v1';

/** Bounded recent window for the funnel (constant — never user-interpolated). */
const FUNNEL_WINDOW_DAYS = 30;

export interface CheckoutFunnelResult {
  /** True iff the brand has ANY checkout_abandoned Bronze row in the window (honest no_data). */
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

/**
 * computeCheckoutFunnel — abandoned-checkout funnel over a bounded window.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns CheckoutFunnelResult — hasData=false when no rows in the window (honest no_data).
 */
export async function computeCheckoutFunnel(
  brandId: string,
  deps: EngineDeps,
): Promise<CheckoutFunnelResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    const currencyCode = (brandRow.rows[0]?.currency_code ?? null) as CurrencyCode | null;

    // All aggregation happens here (the named seam). Counts + minor-unit money sum.
    // total_price_minor / total_discount_minor are minor-unit strings in the payload;
    // SUM over the text->numeric cast is exact (integer minor units, no float).
    const res = await client.query<{
      abandoned: string;
      discount_applied: string;
      with_address: string;
      abandoned_value: string;
      synthetic_cnt: string;
    }>(
      `SELECT
          COUNT(*)::text                                                      AS abandoned,
          COUNT(*) FILTER (
            WHERE COALESCE((payload->>'total_discount_minor')::numeric, 0) > 0
          )::text                                                             AS discount_applied,
          COUNT(*) FILTER (
            WHERE (payload->>'has_address') = 'true'
          )::text                                                             AS with_address,
          COALESCE(SUM((payload->>'total_price_minor')::numeric), 0)::text    AS abandoned_value,
          COUNT(*) FILTER (
            WHERE (payload->>'data_source') = 'synthetic'
          )::text                                                             AS synthetic_cnt
        FROM bronze_events
        WHERE brand_id = $1
          AND event_type = $2
          AND occurred_at >= (now() - ($3::int * INTERVAL '1 day'))`,
      [brandId, CHECKOUT_EVENT_TYPE, FUNNEL_WINDOW_DAYS],
    );

    const row = res.rows[0];
    const abandonedCount = BigInt(row?.abandoned ?? '0');

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
      discountAppliedCount: BigInt(row?.discount_applied ?? '0'),
      withAddressCount: BigInt(row?.with_address ?? '0'),
      // abandoned_value is a numeric text (no fractional minor units possible) → BigInt-safe.
      abandonedValueMinor: BigInt(String(row?.abandoned_value ?? '0').split('.')[0] ?? '0'),
      dataSource: BigInt(row?.synthetic_cnt ?? '0') > 0n ? 'synthetic' : 'live',
    };
  });
}
