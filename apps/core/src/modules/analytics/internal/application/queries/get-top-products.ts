/**
 * getTopProducts — analytics use-case (ADR-002 sole-read-path, Silver tier).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeTopProducts (metric engine), reading the Silver line-item
 * mart silver.order_line (StarRocks brain_silver) through the withSilverBrand seam. NO ad-hoc
 * SUM/COUNT here (D-3 / ADR-002) — the metric-engine seam owns the non-additive aggregation
 * (ADR-004: it does NOT live in dbt). Serializes bigint → string (D-1); honest no_data.
 * Money is bigint-serialized minor units (I-S07) — never /100, never float.
 *
 * I-ST01: the metric-engine is the SOLE Silver reader; the UI reaches Silver only through
 * BFF → this use-case → withSilverBrand. brandId is from session (D-1).
 *
 * @see packages/metric-engine/src/top-products.ts
 */
import type { SilverPool } from '@brain/metric-engine';
import { computeTopProducts } from '@brain/metric-engine';

export interface TopProductDto {
  sku: string;
  title: string | null;
  units: string;          // bigint → string
  line_gmv_minor: string; // bigint → string (minor units, I-S07)
  order_count: string;    // bigint → string
}

export type TopProductsResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      from: string;          // YYYY-MM-DD (echoed range)
      to: string;            // YYYY-MM-DD
      currency_code: string; // ISO 4217 — single brand currency
      data_source: 'synthetic' | 'live';
      products: TopProductDto[];
    };

export interface TopProductsParams {
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  limit: number;
  dataSource: 'synthetic' | 'live';
}

/**
 * getTopProducts — a brand's top products (units + line GMV + order count) over a window.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The StarRocks Silver pool (mysql2).
 * @param params  - The window + echoed date strings + limit + data_source flag.
 */
export async function getTopProducts(
  brandId: string,
  deps: { srPool: SilverPool },
  params: TopProductsParams,
): Promise<TopProductsResult> {
  const result = await computeTopProducts(
    brandId,
    deps,
    { from: params.from, to: params.to },
    params.limit,
  );

  if (!result.hasData || result.currencyCode === null) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    from: params.fromStr,
    to: params.toStr,
    currency_code: result.currencyCode,
    data_source: params.dataSource,
    products: result.products.map((p) => ({
      sku: p.sku,
      title: p.title,
      units: String(p.units),
      line_gmv_minor: String(p.lineGmvMinor),
      order_count: String(p.orderCount),
    })),
  };
}
