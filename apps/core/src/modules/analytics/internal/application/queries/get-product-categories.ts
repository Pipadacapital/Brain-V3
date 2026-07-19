/**
 * getProductCategories — analytics use-case (ADR-002 sole-read-path, Gold serving tier).
 *
 * P3 treemap. Reads the per-product revenue rollup from the pre-materialized Gold mart
 * gold_product_detail through the Trino serving view brain_serving.mv_gold_product_detail (via the
 * withSilverBrand seam) and returns it as the treemap's leaf rows. Bounded top-N read (D-2 allowed —
 * the mart already holds the per-product revenue; no ad-hoc aggregation here).
 *
 * HONESTY NOTE — there is NO category dimension in the Gold/Silver marts today
 * (gold_product_detail carries no category/product_type column; the storefront
 * order line does not surface one). Rather than fabricate a category, the treemap rolls up at the
 * AVAILABLE granularity — the product — sized by revenue_minor. When a category attribute is later
 * landed on the mart, this query rolls up by it without changing the response shape (each row is a
 * tile keyed on a name + a revenue size). Honest no_data when the brand has no product rows.
 *
 * MONEY: revenue_minor is BIGINT minor units serialized → string (D-1, I-S07), paired with its
 * sibling currency_code (per-product currency, never blended, never a float; null for a
 * views/cart-only product with zero purchases).
 *
 * I-ST01: the serving tier is reached ONLY through BFF → this use-case → withSilverBrand.
 * brandId is from session (D-1; NEVER the request body).
 */

import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface ProductCategoryNodeDto {
  product_id: string;
  product_title: string | null;
  revenue_minor: string;        // bigint → string (minor units, I-S07)
  currency_code: string | null; // null when 0 purchases (no currency for zero revenue)
  purchases: string;            // bigint → string
  return_count: string;         // bigint → string
}

export type ProductCategoriesResult =
  | { state: 'no_data' }
  | { state: 'has_data'; nodes: ProductCategoryNodeDto[] };

/**
 * getProductCategories — the product revenue treemap (leaf = product, size = revenue_minor).
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param limit   - Max treemap tiles to return (capped 1..200 server-side).
 * @param deps    - The Trino serving pool (injected as srPool).
 */
export async function getProductCategories(
  brandId: string,
  limit: number,
  deps: { srPool: SilverPool },
): Promise<ProductCategoriesResult> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    return scope.runScoped<{
      product_id: string;
      product_title: string | null;
      revenue_minor: string | number;
      currency_code: string | null;
      purchases: string | number;
      return_count: string | number;
    }>(
      `SELECT product_id, product_title, revenue_minor, currency_code, purchases, return_count
         FROM brain_serving.mv_gold_product_detail
        WHERE ${BRAND_PREDICATE}
        ORDER BY revenue_minor DESC
        LIMIT ${safeLimit}`,
      [],
    );
  });

  if (rows.length === 0) {
    return { state: 'no_data' };
  }

  return {
    state: 'has_data',
    nodes: rows.map((r) => ({
      product_id: r.product_id,
      product_title: r.product_title,
      revenue_minor: String(r.revenue_minor ?? '0').split('.')[0] || '0',
      currency_code: r.currency_code,
      purchases: String(r.purchases ?? '0').split('.')[0] || '0',
      return_count: String(r.return_count ?? '0').split('.')[0] || '0',
    })),
  };
}
