/**
 * Shared helper for the attribution read surfaces (audit R-10 honesty fix).
 *
 * The attribution write-side does not yet populate attribution_credit_ledger, so a brand can
 * have realized revenue / ad spend while the ledger is empty. Reading that as a real result
 * (0%/100%-unattributed) is indistinguishable from honest no-data and quietly misleads. The
 * surfaces use this to return state:'not_computed' instead — "attribution hasn't been computed".
 */
import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

/** True if the brand has ANY attribution_credit_ledger rows (the credit pipeline has populated). */
export async function hasAttributionCredit(brandId: string, deps: EngineDeps): Promise<boolean> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM attribution_credit_ledger WHERE brand_id = $1) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
  });
}
