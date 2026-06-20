/**
 * GetRealizedGmvAsOf — CQRS query.
 * Calls realized_gmv_as_of() named Postgres function — the SOLE as-of path.
 * NO ad-hoc SUM(amount_minor) permitted anywhere in application code (D-3).
 * Returns BIGINT (bigint in TS — I-S07). SECURITY INVOKER → RLS enforced.
 * Tier-0 deterministic.
 */

import { type Pool } from 'pg';
import { withBrandTxn } from '@brain/metric-engine';

export class GetRealizedGmvAsOfQuery {
  constructor(private readonly pool: Pool) {}

  /**
   * Returns the realized GMV (in minor units, bigint) for a brand as of a date.
   * Excludes provisional_recognition rows (no-double-count heart — D-3).
   *
   * F-SEC-02 (GUC-reset defense-in-depth): the brand GUC + RLS are set via the shared
   * withBrandTxn — it opens a transaction, SET LOCAL ROLE brain_app (NOBYPASSRLS), and a
   * transaction-LOCAL `app.current_brand_id`, then COMMITs. Both the role and the GUC reset on
   * COMMIT/ROLLBACK, so the brand context can NEVER leak to the next user of this pooled
   * connection. (The previous bare `set_config(..., true)` outside any transaction was not
   * transaction-scoped on a pooled client — a leak vector and the same canonical seam every other
   * Silver/ledger read already uses.)
   *
   * @param brandId - The brand UUID.
   * @param asOf    - The as-of date (inclusive). Economic_effective_at::date <= asOf.
   * @returns       Realized GMV in minor units as bigint (I-S07).
   */
  async execute(brandId: string, asOf: Date): Promise<bigint> {
    const asOfStr = asOf.toISOString().split('T')[0]; // 'YYYY-MM-DD'
    return withBrandTxn(this.pool, brandId, async (client) => {
      const result = await client.query<{ realized_gmv_as_of: string }>(
        'SELECT realized_gmv_as_of($1::uuid, $2::date) AS realized_gmv_as_of',
        [brandId, asOfStr],
      );
      // pg returns bigint as string to avoid JS precision loss.
      return BigInt(result.rows[0]?.realized_gmv_as_of ?? '0');
    });
  }
}
