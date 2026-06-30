/**
 * getProductDetail — analytics use-case (ADR-002 sole-read-path, Gold serving tier).
 *
 * P3 (per-PRODUCT performance). Reads ONE product's row from the pre-materialized Gold mart
 * gold_product_detail through the Trino serving view brain_serving.mv_gold_product_detail (via the
 * withSilverBrand seam). This is a bounded single-row read keyed on the product_id (D-2 allowed —
 * NOT an ad-hoc aggregation; the mart already holds the per-product funnel rollup). The funnel
 * (views → add_to_cart → purchases → revenue + returns) and the two conversion rates are surfaced
 * exactly as the mart stores them; return_rate is the only single-row presentation derivation
 * (return_count / purchases) — honest null when purchases = 0 (never a 0/0 divide).
 *
 * MONEY: revenue_minor is BIGINT minor units serialized → string (D-1, I-S07), paired with its
 * sibling currency_code (per-product currency, never blended, never a float). currency_code is null
 * for a views/cart-only product with zero purchases.
 *
 * I-ST01: the serving tier is reached ONLY through BFF → this use-case → withSilverBrand.
 * brandId is from session (D-1; NEVER the request body). Honest not_found when the brand has no row
 * for the requested product_id.
 */

import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface ProductDetailDto {
  product_id: string;
  product_title: string | null;
  views: string;          // bigint → string (D-1)
  add_to_cart: string;    // bigint → string
  purchases: string;      // bigint → string
  revenue_minor: string;  // bigint → string (minor units, I-S07)
  currency_code: string | null; // null when 0 purchases (no currency for zero revenue)
  return_count: string;   // bigint → string
  add_to_cart_rate: string;     // 2dp string from the mart ('0.00' when views=0)
  purchase_rate: string;        // 2dp string from the mart ('0.00' when views=0)
  return_rate: string | null;   // 2dp string (return_count/purchases); null when purchases=0
  updated_at: string;     // ISO timestamp
}

export type ProductDetailResult =
  | { state: 'not_found'; product_id: string }
  | { state: 'has_data'; product_id: string; detail: ProductDetailDto };

/**
 * getProductDetail — a single product's storefront funnel + revenue + returns.
 *
 * @param brandId   - Brand UUID (from session — D-1).
 * @param productId - The canonical storefront product id (path param).
 * @param deps      - The Trino serving pool (injected as srPool).
 */
export async function getProductDetail(
  brandId: string,
  productId: string,
  deps: { srPool: SilverPool },
): Promise<ProductDetailResult> {
  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    return scope.runScoped<{
      product_id: string;
      product_title: string | null;
      views: string | number;
      add_to_cart: string | number;
      purchases: string | number;
      revenue_minor: string | number;
      currency_code: string | null;
      return_count: string | number;
      add_to_cart_rate: string;
      purchase_rate: string;
      updated_at: string;
    }>(
      `SELECT product_id, product_title, views, add_to_cart, purchases,
              revenue_minor, currency_code, return_count, add_to_cart_rate,
              purchase_rate, updated_at
         FROM brain_serving.mv_gold_product_detail
        WHERE product_id = ? AND ${BRAND_PREDICATE}
        LIMIT 1`,
      [productId],
    );
  });

  const row = rows[0];
  if (!row) {
    return { state: 'not_found', product_id: productId };
  }

  const purchases = String(row.purchases ?? '0').split('.')[0] || '0';
  const returnCount = String(row.return_count ?? '0').split('.')[0] || '0';
  const purchasesNum = Number(purchases);
  // return_rate is a single-row presentation derivation (NOT an aggregation): honest null when
  // there are no purchases (never a 0/0 divide). 2dp string, mirroring the mart's rate convention.
  const returnRate =
    purchasesNum > 0 ? ((Number(returnCount) / purchasesNum) * 100).toFixed(2) : null;

  return {
    state: 'has_data',
    product_id: productId,
    detail: {
      product_id: row.product_id,
      product_title: row.product_title,
      views: String(row.views ?? '0').split('.')[0] || '0',
      add_to_cart: String(row.add_to_cart ?? '0').split('.')[0] || '0',
      purchases,
      revenue_minor: String(row.revenue_minor ?? '0').split('.')[0] || '0',
      currency_code: row.currency_code,
      return_count: returnCount,
      add_to_cart_rate: row.add_to_cart_rate,
      purchase_rate: row.purchase_rate,
      return_rate: returnRate,
      updated_at: new Date(row.updated_at).toISOString(),
    },
  };
}
