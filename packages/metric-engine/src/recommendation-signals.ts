/**
 * @brain/metric-engine — recommendation signal seams (Tier-0), lakehouse edition.
 *
 * MEDALLION REALIGNMENT (Epic 1 / decision B): the recommendation detectors' REVENUE signals come
 * from the lakehouse ledger (brain_gold.gold_revenue_ledger, Bronze-sourced) via withSilverBrand —
 * NOT the PostgreSQL realized_revenue_ledger + its rto_risk_signal_for_brand /
 * realization_signal_for_brand / cm2_signal_for_brand SQL functions (dropped with the table).
 *
 * These return RAW AGGREGATES only (counts + signed BIGINT sums); the DERIVED business numbers (RTO
 * rate, realization gap, CM2 margin + thresholds) stay in the pure detectors (ADR-004 — SQL/seam never
 * decides a business number). Money is signed BIGINT minor units (I-S07).
 *
 * Event-type mapping PG→gold: the PG ledger conflated RTO into 'rto_reversal'; the Bronze-sourced gold
 * ledger models a COD return-to-origin as 'cod_rto_clawback' (from gokwik.awb_status terminal RTO) —
 * that is the RTO signal here. The cm2 detector's marketing (ad_spend_ledger) + cost (cost_input) parts
 * remain PostgreSQL operational reads in the registry; only the revenue half moves to gold.
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

function bi(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] || '0');
}
function num(v: string | number | null | undefined): number {
  return Number(String(v ?? '0').split('.')[0] || '0');
}

export interface RtoRiskSignalRaw {
  orderCount: number;
  rtoCount: number;
  rtoGmvMinor: bigint;
}

/** RTO signal from gold: provisional-order count, COD-RTO count, |RTO| GMV. */
export async function computeRtoRiskSignal(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RtoRiskSignalRaw> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{ order_count: string | number; rto_count: string | number; rto_gmv_minor: string | number }>(
      `SELECT
         COUNT(DISTINCT CASE WHEN event_type = 'provisional_recognition' THEN order_id END) AS order_count,
         COUNT(CASE WHEN event_type = 'cod_rto_clawback' THEN 1 END) AS rto_count,
         COALESCE(SUM(CASE WHEN event_type = 'cod_rto_clawback' THEN ABS(amount_minor) ELSE 0 END), 0) AS rto_gmv_minor
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE ${BRAND_PREDICATE}`,
      [],
    );
    const r = rows[0];
    return { orderCount: num(r?.order_count), rtoCount: num(r?.rto_count), rtoGmvMinor: bi(r?.rto_gmv_minor) };
  });
}

export interface RealizationSignalRaw {
  provisionalMinor: bigint;
  realizedMinor: bigint;
  orderCount: number;
}

/** Realization signal from gold: provisional Σ, realized Σ (non-provisional, net of reversals), orders. */
export async function computeRealizationSignal(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<RealizationSignalRaw> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{ provisional_minor: string | number; realized_minor: string | number; order_count: string | number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN event_type = 'provisional_recognition' THEN amount_minor ELSE 0 END), 0) AS provisional_minor,
         COALESCE(SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END), 0) AS realized_minor,
         COUNT(DISTINCT order_id) AS order_count
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE ${BRAND_PREDICATE}`,
      [],
    );
    const r = rows[0];
    return { provisionalMinor: bi(r?.provisional_minor), realizedMinor: bi(r?.realized_minor), orderCount: num(r?.order_count) };
  });
}

export interface Cm2RevenueSignalRaw {
  /** Realized (net) revenue to date — Σ amount over non-provisional events. */
  netRevenueMinor: bigint;
  /** Distinct realized orders (the min-orders gate). */
  orderCount: number;
}

/** CM2 REVENUE half from gold (cost half stays PG in the registry; marketing → computeCm2MarketingSignal). */
export async function computeCm2RevenueSignal(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<Cm2RevenueSignalRaw> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{ net_revenue_minor: string | number; order_count: string | number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN event_type <> 'provisional_recognition' THEN amount_minor ELSE 0 END), 0) AS net_revenue_minor,
         COUNT(DISTINCT CASE WHEN event_type <> 'provisional_recognition' THEN order_id END) AS order_count
       FROM brain_serving.mv_gold_revenue_ledger
       WHERE ${BRAND_PREDICATE}`,
      [],
    );
    const r = rows[0];
    return { netRevenueMinor: bi(r?.net_revenue_minor), orderCount: num(r?.order_count) };
  });
}

export interface Cm2MarketingSignalRaw {
  /** Σ ad spend in the brand's currency — BIGINT minor units (I-S07). */
  marketingMinor: bigint;
}

/**
 * CM2 MARKETING half from the lakehouse Silver entity brain_silver.silver_marketing_spend
 * (Bronze-sourced — AV-1/MV-1), via the StarRocks read seam (I-ST01). Replaces the PG
 * ad_spend_as_of() read. Spend is summed ONLY for rows in the brand's currency — the exact
 * filter the dropped PG cm2_signal_for_brand() applied (JOIN brand b ON b.currency_code =
 * s.currency_code), so CM2 never mixes a foreign-currency spend total into a brand-currency margin.
 *
 * @param brandId  Brand UUID (from session — D-1; NEVER request body).
 * @param currencyCode  The brand's ISO-4217 currency (operational config, read from PG by the caller).
 * @param deps     The StarRocks Silver pool — silver_marketing_spend via withSilverBrand.
 */
export async function computeCm2MarketingSignal(
  brandId: string,
  currencyCode: string,
  deps: { srPool: SilverPool },
): Promise<Cm2MarketingSignalRaw> {
  // currencyCode is operational config (CHAR(3)); defensively strip to ISO-4217 alpha before
  // interpolation (StarRocks SET/param caveats mirror withSilverBrand's brand-id escaping).
  const safeCcy = currencyCode.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3);
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{ marketing_minor: string | number }>(
      `SELECT COALESCE(SUM(spend_minor), 0) AS marketing_minor
         FROM brain_serving.mv_silver_marketing_spend
        WHERE currency_code = '${safeCcy}'
          AND ${BRAND_PREDICATE}`,
      [],
    );
    return { marketingMinor: bi(rows[0]?.marketing_minor) };
  });
}
