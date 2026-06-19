/**
 * getBillingPeriods — sealed billing-period read (P1, slice 1).
 *
 * Returns a brand's sealed gmv_meter_snapshot rows (the bill basis) as an honest discriminated
 * union: `no_data` when the brand has never sealed a period, `has_data` otherwise. Reads ONLY
 * gmv_meter_snapshot via @brain/db's RLS-enforced pool (brain_app + app.current_brand_id GUC).
 *
 * No metric-engine coupling: billing reads its own sealed snapshots; the as-of money math lives
 * behind the seal (sealed at meter time via realized_gmv_as_of), so this read never recomputes.
 * brand_id is the session brand (BFF), NEVER the request.
 */

import type { DbPool, QueryContext } from '@brain/db';

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface BillingPeriod {
  /** 'YYYY-MM' billing period. */
  billing_period: string;
  currency_code: string;
  /** realized GMV in minor units, bigint-as-string (I-S07). */
  metered_gmv_minor: string;
  /** inclusive as-of date the figure was metered at, 'YYYY-MM-DD'. */
  as_of_date: string;
  /** # realized ledger rows behind the figure (provenance). */
  ledger_row_count: number;
  /** ISO instant the period was sealed (immutable thereafter). */
  sealed_at: string;
}

export type BillingPeriods =
  | { state: 'no_data' }
  | { state: 'has_data'; periods: BillingPeriod[] };

export interface BillingReadDeps {
  pool: DbPool;
}

export async function getBillingPeriods(
  brandId: string,
  correlationId: string,
  deps: BillingReadDeps,
): Promise<BillingPeriods> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const res = await client.query<{
      billing_period: string;
      currency_code: string;
      metered_gmv_minor: string;
      as_of_date: string;
      ledger_row_count: string;
      sealed_at: Date;
    }>(
      ctx,
      `SELECT billing_period,
              currency_code,
              metered_gmv_minor::text AS metered_gmv_minor,
              to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
              ledger_row_count::text AS ledger_row_count,
              sealed_at
         FROM gmv_meter_snapshot
        WHERE brand_id = $1
        ORDER BY billing_period DESC`,
      [brandId],
    );

    if (res.rows.length === 0) {
      return { state: 'no_data' };
    }

    return {
      state: 'has_data',
      periods: res.rows.map((r) => ({
        billing_period: r.billing_period,
        currency_code: r.currency_code.trim(),
        metered_gmv_minor: r.metered_gmv_minor,
        as_of_date: r.as_of_date,
        ledger_row_count: Number(r.ledger_row_count),
        sealed_at: toIso(r.sealed_at),
      })),
    };
  } finally {
    client.release();
  }
}
