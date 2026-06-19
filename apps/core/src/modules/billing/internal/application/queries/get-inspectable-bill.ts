/**
 * getInspectableBill — the inspectable bill for a sealed billing period (P1, slice 2).
 *
 * Answers "how was this fee derived?" reproducibly from the ledger:
 *   fee = sealed realized-GMV basis (0040 gmv_meter_snapshot) × billing rate (billing_plan),
 *   itemized down to the per-event_type composition that RECONCILES to the basis.
 *
 * Honest by construction:
 *  - The fee is computed on the SEALED, immutable basis — not a live recompute — so a bill is
 *    reproducible and stable (doc 10: "bill reproducible from the ledger").
 *  - The composition lines are the LIVE realized GMV broken down by event_type as-of the seal's
 *    as_of_date (via the realized_gmv_composition_as_of seam — D-3, no ad-hoc SUM). If a backdated
 *    row arrived AFTER the seal, the live composition no longer equals the sealed basis; the
 *    reconciliation block surfaces that drift instead of hiding it. The bill still bills on the
 *    sealed figure.
 *  - When the brand has no billing_plan row, the rate falls back to a platform default and the
 *    bill SAYS so (rate.source = 'default').
 *
 * Tenant isolation is the @brain/db RLS guarantee; brand_id is the session brand (BFF), never
 * the request. Money is bigint-minor (I-S07); the fee uses banker's rounding (D-7).
 */

import type { DbPool, QueryContext } from '@brain/db';
import { roundToMinorBankers } from '@brain/money';

/** Platform default billing rate when a brand has no billing_plan row (100 bps = 1.00%). */
export const DEFAULT_RATE_BPS = 100;

const PERIOD_RE = /^\d{4}-\d{2}$/;

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface BillLine {
  event_type: string;
  /** realized contribution of this event_type in minor units, bigint-as-string (signed; I-S07). */
  amount_minor: string;
}

export interface InspectableBill {
  billing_period: string;
  currency_code: string;
  basis: {
    metered_gmv_minor: string;
    as_of_date: string;
    ledger_row_count: number;
    sealed_at: string;
  };
  rate: {
    rate_bps: number;
    source: 'plan' | 'default';
  };
  /** billable fee in minor units = round(basis × rate_bps / 10000), banker's rounding (D-7). */
  fee_minor: string;
  /** sub-minor amount absorbed by rounding (never silently dropped). */
  rounding_adjustment_minor: string;
  /** per-event_type composition of the basis (signed; finalizations +, refunds/reversals −). */
  lines: BillLine[];
  reconciliation: {
    sealed_basis_minor: string;
    live_composition_minor: string;
    /** true when the live composition still equals the sealed basis (no post-seal backdated rows). */
    reconciles: boolean;
    /** live − sealed; non-zero only when backdated rows landed after the seal. */
    drift_minor: string;
  };
}

export type InspectableBillResult =
  | { state: 'not_sealed'; billing_period: string }
  | ({ state: 'billed' } & InspectableBill);

export interface BillDeps {
  pool: DbPool;
}

export async function getInspectableBill(
  brandId: string,
  period: string,
  correlationId: string,
  deps: BillDeps,
): Promise<InspectableBillResult> {
  if (!PERIOD_RE.test(period)) {
    return { state: 'not_sealed', billing_period: period };
  }

  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    // 1. The sealed basis (immutable). No seal → honest not_sealed (nothing to bill yet).
    const snapRes = await client.query<{
      currency_code: string;
      metered_gmv_minor: string;
      as_of_date: string;
      ledger_row_count: string;
      sealed_at: Date;
    }>(
      ctx,
      `SELECT currency_code,
              metered_gmv_minor::text AS metered_gmv_minor,
              to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
              ledger_row_count::text AS ledger_row_count,
              sealed_at
         FROM gmv_meter_snapshot
        WHERE brand_id = $1 AND billing_period = $2`,
      [brandId, period],
    );
    if (snapRes.rows.length === 0) {
      return { state: 'not_sealed', billing_period: period };
    }
    const snap = snapRes.rows[0]!;
    const currency = snap.currency_code.trim();
    const basisMinor = BigInt(snap.metered_gmv_minor);

    // 2. The billing rate — plan row, else platform default (provenance recorded).
    const planRes = await client.query<{ rate_bps: number }>(
      ctx,
      `SELECT rate_bps FROM billing_plan WHERE brand_id = $1`,
      [brandId],
    );
    const planRow = planRes.rows[0];
    const rateBps = planRow ? planRow.rate_bps : DEFAULT_RATE_BPS;
    const rateSource: 'plan' | 'default' = planRow ? 'plan' : 'default';

    // 3. The fee on the sealed basis — banker's rounding (D-7). value is in 1/10000 minor units.
    const { minor: feeMinor, adjustment_minor } = roundToMinorBankers(
      basisMinor * BigInt(rateBps),
      10_000n,
    );

    // 4. The inspectable composition as-of the seal's as_of_date (named seam — D-3). Filtered to
    //    the basis currency (M1 single-currency per brand; other currencies bill separately).
    const compRes = await client.query<{ event_type: string; amount_minor: string }>(
      ctx,
      `SELECT event_type, amount_minor::text AS amount_minor
         FROM realized_gmv_composition_as_of($1::uuid, $2::date)
        WHERE currency_code = $3
        ORDER BY amount_minor DESC`,
      [brandId, snap.as_of_date, currency],
    );
    const lines: BillLine[] = compRes.rows.map((r) => ({
      event_type: r.event_type,
      amount_minor: r.amount_minor,
    }));
    const liveComposition = lines.reduce((sum, l) => sum + BigInt(l.amount_minor), 0n);
    const drift = liveComposition - basisMinor;

    return {
      state: 'billed',
      billing_period: period,
      currency_code: currency,
      basis: {
        metered_gmv_minor: basisMinor.toString(),
        as_of_date: snap.as_of_date,
        ledger_row_count: Number(snap.ledger_row_count),
        sealed_at: toIso(snap.sealed_at),
      },
      rate: { rate_bps: rateBps, source: rateSource },
      fee_minor: feeMinor.toString(),
      rounding_adjustment_minor: adjustment_minor.toString(),
      lines,
      reconciliation: {
        sealed_basis_minor: basisMinor.toString(),
        live_composition_minor: liveComposition.toString(),
        reconciles: drift === 0n,
        drift_minor: drift.toString(),
      },
    };
  } finally {
    client.release();
  }
}
