/**
 * @brain/metric-engine — computeProvisionalRevenue (D-4, D-5)
 *
 * The SOLE emitter of provisional_revenue values.
 * Reads via the named DB seam provisional_gmv_as_of() (migration 0020) —
 * no ad-hoc SUM(amount_minor) anywhere in app code.
 *
 * Returns Map<CurrencyCode, bigint>: per-currency map.
 * NEVER blended into realized_revenue (disjoint predicates by design):
 *   realized_gmv_as_of: WHERE event_type <> 'provisional_recognition'
 *   provisional_gmv_as_of: WHERE recognition_label IN ('provisional','settling')
 *
 * F-SEC-02: all DB reads happen inside withBrandTxn (explicit BEGIN/COMMIT).
 *
 * @see D-4, D-5 (03-architecture-plan.md)
 * @see 0020_provisional_gmv_as_of.sql — provisional_gmv_as_of() definition
 */

import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

/**
 * computeProvisionalRevenue — returns provisional revenue as of a date, per currency.
 *
 * Reads the ledger via provisional_gmv_as_of() (SECURITY INVOKER, RLS-enforced,
 * migration 0020). The function returns TABLE(currency_code, provisional_minor)
 * which maps directly to Map<CurrencyCode, bigint>.
 *
 * INVARIANT: provisional rows NEVER appear in the realized map.
 * INVARIANT: realized rows NEVER appear in the provisional map.
 *
 * @param brandId - The brand UUID.
 * @param asOf    - The as-of date (inclusive). economic_effective_at::date <= asOf.
 * @param deps    - Engine dependencies (pg.Pool).
 * @returns       Map<CurrencyCode, bigint> — provisional revenue per currency.
 *                bigint minor units (I-S07). Never floats. Empty map if 0 provisional.
 */
export async function computeProvisionalRevenue(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<Map<CurrencyCode, bigint>> {
  const asOfStr = asOf.toISOString().split('T')[0]; // 'YYYY-MM-DD'

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // Call the named seam (SOLE as-of path for provisional — no ad-hoc SUM)
    // provisional_gmv_as_of() is SECURITY INVOKER; the GUC is already set by
    // withBrandTxn so RLS filters to this brand only.
    // Returns TABLE(currency_code CHAR(3), provisional_minor BIGINT)
    const result = await client.query<{ currency_code: string; provisional_minor: string }>(
      `SELECT currency_code, provisional_minor FROM provisional_gmv_as_of($1::uuid, $2::date)`,
      [brandId, asOfStr],
    );

    const map = new Map<CurrencyCode, bigint>();
    for (const row of result.rows) {
      // pg returns bigint columns as string to avoid JS precision loss
      map.set(row.currency_code as CurrencyCode, BigInt(row.provisional_minor));
    }
    return map;
  });
}
