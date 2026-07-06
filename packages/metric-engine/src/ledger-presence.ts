// SPEC: 0.5
/**
 * @brain/metric-engine — brandHasRealizedLedgerRows (ledger-presence probe).
 *
 * WA-02 boundary-debt fix: workspace-access (MA-11 currency_code immutability guard) used to
 * import withSilverBrand/BRAND_PREDICATE directly and write its own serving SQL — a
 * metric-engine fence violation (I-ST03: the engine is the SOLE Gold reader, I-ST01). The
 * Gold SQL now lives HERE, purpose-named, and workspace-access consumes it through the
 * analytics module facade (apps/core/src/modules/analytics/index.ts).
 *
 * Semantics are byte-identical to the inlined query it replaces: "does this brand have ANY
 * row in the realized revenue ledger?" — the 409 trigger for currency_code immutability.
 * HONEST-EMPTY degradation (withSilverBrand) means a missing serving tier reads as
 * `false` (no ledger rows → mutation allowed), same as before.
 *
 * Reads brain_serving.mv_gold_revenue_ledger via withSilverBrand (I-ST01); never PostgreSQL.
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/**
 * brandHasRealizedLedgerRows — true when the brand has at least one Gold revenue-ledger row.
 *
 * @param srPool  - The Trino serving pool (injected at the composition root).
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 */
export async function brandHasRealizedLedgerRows(srPool: SilverPool, brandId: string): Promise<boolean> {
  return withSilverBrand(srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{ one: number }>(
      `SELECT 1 AS one FROM brain_serving.mv_gold_revenue_ledger WHERE ${BRAND_PREDICATE} LIMIT 1`,
    );
    return rows.length > 0;
  });
}
