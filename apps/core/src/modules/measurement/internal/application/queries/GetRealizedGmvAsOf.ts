/**
 * GetRealizedGmvAsOf — CQRS query.
 * Calls realized_gmv_as_of() named Postgres function — the SOLE as-of path.
 * NO ad-hoc SUM(amount_minor) permitted anywhere in application code (D-3).
 * Returns BIGINT (bigint in TS — I-S07). SECURITY INVOKER → RLS enforced.
 * Tier-0 deterministic.
 */

import { type Pool } from 'pg';

export class GetRealizedGmvAsOfQuery {
  constructor(private readonly pool: Pool) {}

  /**
   * Returns the realized GMV (in minor units, bigint) for a brand as of a date.
   * Excludes provisional_recognition rows (no-double-count heart — D-3).
   * Executes under brain_app with GUC set → RLS filters to the requesting brand.
   *
   * @param brandId - The brand UUID.
   * @param asOf    - The as-of date (inclusive). Economic_effective_at::date <= asOf.
   * @returns       Realized GMV in minor units as bigint (I-S07).
   */
  async execute(brandId: string, asOf: Date): Promise<bigint> {
    const client = await this.pool.connect();
    try {
      // GUC-first: set brand context so RLS filters correctly
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);

      const asOfStr = asOf.toISOString().split('T')[0]; // 'YYYY-MM-DD'
      const result = await client.query<{ realized_gmv_as_of: string }>(
        'SELECT realized_gmv_as_of($1::uuid, $2::date) AS realized_gmv_as_of',
        [brandId, asOfStr],
      );

      const raw = result.rows[0]?.realized_gmv_as_of ?? '0';
      // pg returns bigint as string to avoid JS precision loss
      return BigInt(raw);
    } finally {
      client.release();
    }
  }
}
