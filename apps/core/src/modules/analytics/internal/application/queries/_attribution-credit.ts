/**
 * Shared helper for the attribution read surfaces (audit R-10 honesty fix).
 *
 * The attribution write-side does not yet populate attribution_credit_ledger, so a brand can
 * have realized revenue / ad spend while the ledger is empty. Reading that as a real result
 * (0%/100%-unattributed) is indistinguishable from honest no-data and quietly misleads. The
 * surfaces use this to return state:'not_computed' instead — "attribution hasn't been computed".
 */
import type { SilverPool } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE } from '@brain/metric-engine';

/**
 * True if the brand has ANY attribution credit rows (the credit pipeline has populated).
 *
 * PHASE G: reads the lakehouse mart brain_gold.gold_marketing_attribution via withSilverBrand —
 * PG attribution_credit_ledger is no longer a read source. Moved together with the attribution
 * read surfaces (channel-roas reads its own inline; by-channel + reconciliation use this), so the
 * exists-check and the compute always read the SAME store (no PG-data-hidden-by-empty-mart skew).
 */
export async function hasAttributionCredit(brandId: string, deps: { srPool: SilverPool }): Promise<boolean> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const r = await scope.runScoped<{ has_row: number }>(
      `SELECT 1 AS has_row FROM brain_gold.gold_marketing_attribution WHERE ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    return r.length > 0;
  });
}
