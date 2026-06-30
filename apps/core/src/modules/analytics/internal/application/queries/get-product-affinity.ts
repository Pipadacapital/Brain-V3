/**
 * getProductAffinity — analytics use-case (ADR-002 sole-read-path, Gold serving tier).
 *
 * P3 frequently-bought-together. Reads the co-purchase pairs for ONE product from the
 * pre-materialized Gold mart gold_product_affinity through the Trino serving view
 * brain_serving.mv_gold_product_affinity (via the withSilverBrand seam). Bounded top-N read
 * (D-2 allowed — the mart already holds the per-pair co_purchase_count + support_pct rollup; no
 * ad-hoc aggregation here).
 *
 * The mart stores each unordered pair once with product_a < product_b. For the requested product,
 * the PARTNER is whichever side is NOT the requested product (CASE), so a product surfaces its FBT
 * partners regardless of which slot it occupies. NO money — every measure is a count or a 2dp ratio.
 *
 * I-ST01: the serving tier is reached ONLY through BFF → this use-case → withSilverBrand.
 * brandId is from session (D-1; NEVER the request body). Honest no_data when the product has no
 * co-purchase pairs (a single-line-item-only product, or attribution hasn't built any pairs yet).
 */

import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

export interface ProductAffinityPairDto {
  product_b: string;          // the FBT PARTNER product (not the requested product)
  co_purchase_count: string;  // bigint → string (D-1)
  support_pct: string;        // 2dp ratio string from the mart
}

export type ProductAffinityResult =
  | { state: 'no_data'; product_id: string }
  | { state: 'has_data'; product_id: string; pairs: ProductAffinityPairDto[] };

/**
 * getProductAffinity — a product's top-N frequently-bought-together partners.
 *
 * @param brandId   - Brand UUID (from session — D-1).
 * @param productId - The anchor product id (path param).
 * @param limit     - Max partner pairs to return (capped 1..50 server-side).
 * @param deps      - The Trino serving pool (injected as srPool).
 */
export async function getProductAffinity(
  brandId: string,
  productId: string,
  limit: number,
  deps: { srPool: SilverPool },
): Promise<ProductAffinityResult> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 50);

  const rows = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    return scope.runScoped<{
      product_b: string;
      co_purchase_count: string | number;
      support_pct: string;
    }>(
      `SELECT CASE WHEN product_a = ? THEN product_b ELSE product_a END AS product_b,
              co_purchase_count,
              support_pct
         FROM brain_serving.mv_gold_product_affinity
        WHERE (product_a = ? OR product_b = ?) AND ${BRAND_PREDICATE}
        ORDER BY co_purchase_count DESC
        LIMIT ${safeLimit}`,
      [productId, productId, productId],
    );
  });

  if (rows.length === 0) {
    return { state: 'no_data', product_id: productId };
  }

  return {
    state: 'has_data',
    product_id: productId,
    pairs: rows.map((r) => ({
      product_b: r.product_b,
      co_purchase_count: String(r.co_purchase_count ?? '0').split('.')[0] || '0',
      support_pct: r.support_pct,
    })),
  };
}
