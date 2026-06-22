/**
 * sealBillingPeriod — the realized-GMV billing meter (P1, slice 1).
 *
 * Meters a brand's realized GMV for a 'YYYY-MM' billing period and SEALS it into the immutable
 * gmv_meter_snapshot table. The figure comes from realized_gmv_as_of() — the SOLE as-of path
 * (D-3: NO ad-hoc SUM(amount_minor) in app code) — taken as-of the period's last calendar day.
 * Billing is on realized GMV only (provisional rows are excluded inside the function), NOT
 * attribution — so the meter never waits on the decision stack (doc 10).
 *
 * IDEMPOTENT + IMMUTABLE: the INSERT is ON CONFLICT (brand_id, billing_period) DO NOTHING, so
 * re-sealing an already-sealed period is a no-op (`sealed: false`) and the original figure
 * stands. brand_app holds no UPDATE/DELETE on the table (0040 append-only-by-GRANT), so a
 * sealed period is physically un-editable — a correction is a new period, never an edit.
 *
 * Tenant isolation is the @brain/db RLS guarantee (SET LOCAL ROLE brain_app + app.current_brand_id
 * GUC per statement); the explicit `WHERE brand_id = $1` is belt-and-suspenders. brand_id is the
 * session brand (BFF), NEVER the request body.
 */

import type { DbPool, QueryContext } from '@brain/db';

const PERIOD_RE = /^\d{4}-\d{2}$/;

export interface SealResult {
  /** true if this call newly sealed the period; false if it was already sealed (idempotent no-op). */
  sealed: boolean;
  billing_period: string;
  currency_code: string;
  /** realized GMV in minor units, bigint-as-string (I-S07 — JSON has no bigint). */
  metered_gmv_minor: string;
  /** inclusive as-of date used for the meter, 'YYYY-MM-DD' (the period's last day). */
  as_of_date: string;
  ledger_row_count: number;
}

export interface BillingDeps {
  pool: DbPool;
}

/** Last calendar day of a 'YYYY-MM' period as 'YYYY-MM-DD' (UTC; day 0 of next month = last day). */
function periodEndDate(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}

export async function sealBillingPeriod(
  brandId: string,
  period: string,
  correlationId: string,
  deps: BillingDeps,
): Promise<SealResult> {
  if (!PERIOD_RE.test(period)) {
    throw new Error(`sealBillingPeriod: billing period must be 'YYYY-MM', got '${period}'`);
  }
  const asOf = periodEndDate(period);
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    // Currency of the metered figure = the currency of the realized rows being summed. Read it
    // from the ledger itself (billing's own bounded context) rather than the brand table — the
    // brand row carries a workspace/membership-coupled RLS policy that needs GUCs billing doesn't
    // set, and the figure's currency should match the rows summed, not a separately-configured one.
    // M1 is single-currency per brand; default INR if empty.
    const curRes = await client.query<{ currency_code: string }>(
      ctx,
      `SELECT currency_code
         FROM realized_revenue_ledger
        WHERE brand_id = $1 AND billing_posted_period = $2
        ORDER BY economic_effective_at DESC
        LIMIT 1`,
      [brandId, period],
    );
    const currency = (curRes.rows[0]?.currency_code ?? 'INR').trim();

    // Per-period realized GMV via the named seam (D-3) — the DELTA billed to THIS period
    // (billing_posted_period), not the cumulative as-of total. ::text → bigint-as-string.
    const gmvRes = await client.query<{ gmv: string }>(
      ctx,
      `SELECT realized_gmv_for_period($1::uuid, $2::char(7))::text AS gmv`,
      [brandId, period],
    );
    // Floor at 0: a period whose realized GMV is net-negative (reversals/refunds exceed the recognized
    // sales that posted to it — e.g. RTO reversals landing before their provisionals finalize) meters as
    // ZERO, never a negative bill. The ledger keeps the signed truth; the BILLED figure is non-negative
    // (gmv_meter_snapshot.metered_gmv_minor CHECK >= 0). You never invoice a customer a negative amount.
    const gmvRaw = BigInt(gmvRes.rows[0]?.gmv ?? '0');
    const gmv = (gmvRaw < 0n ? 0n : gmvRaw).toString();

    // Provenance-only row count (NOT the money math, which goes through the function above — so not
    // the D-3-banned ad-hoc SUM): how many rows posted to this period stand behind the figure.
    const cntRes = await client.query<{ n: string }>(
      ctx,
      `SELECT count(*)::bigint::text AS n
         FROM realized_revenue_ledger
        WHERE brand_id = $1 AND billing_posted_period = $2`,
      [brandId, period],
    );
    const rowCount = Number(cntRes.rows[0]?.n ?? '0');

    // Seal — idempotent. DO NOTHING means the period was already sealed; the original stands.
    const ins = await client.query<{ billing_period: string }>(
      ctx,
      `INSERT INTO gmv_meter_snapshot
         (brand_id, billing_period, currency_code, metered_gmv_minor, as_of_date, ledger_row_count)
       VALUES ($1, $2, $3, $4::bigint, $5::date, $6::bigint)
       ON CONFLICT (brand_id, billing_period) DO NOTHING
       RETURNING billing_period`,
      [brandId, period, currency, gmv, asOf, rowCount],
    );
    const newlySealed = ins.rows.length > 0;

    // Read back the authoritative sealed row (new OR pre-existing) so the response is always the
    // figure of record, never a recomputed value that could disagree with the seal.
    const row = (
      await client.query<{
        billing_period: string;
        currency_code: string;
        metered_gmv_minor: string;
        as_of_date: string;
        ledger_row_count: string;
      }>(
        ctx,
        `SELECT billing_period,
                currency_code,
                metered_gmv_minor::text AS metered_gmv_minor,
                to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
                ledger_row_count::text AS ledger_row_count
           FROM gmv_meter_snapshot
          WHERE brand_id = $1 AND billing_period = $2`,
        [brandId, period],
      )
    ).rows[0]!;

    return {
      sealed: newlySealed,
      billing_period: row.billing_period,
      currency_code: row.currency_code.trim(),
      metered_gmv_minor: row.metered_gmv_minor,
      as_of_date: row.as_of_date,
      ledger_row_count: Number(row.ledger_row_count),
    };
  } finally {
    client.release();
  }
}
