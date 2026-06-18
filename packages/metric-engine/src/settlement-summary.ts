/**
 * @brain/metric-engine — computeSettlementSummary (Razorpay Track C)
 *
 * The SOLE emitter of settlement (net-of-fees) values from the realized_revenue_ledger
 * settlement event_types (migration 0027). NO ad-hoc SUM(amount_minor) in the analytics
 * module — this is the named compute seam (mirrors computeRealizedRevenue / computeKpiSummary).
 *
 * Ledger sign convention (0027 §C taxonomy — amount_minor is SIGNED):
 *   settlement_finalization    (+)  net credit per settled payment
 *   rolling_reserve_release    (+)  reserve returned 90–180d later
 *   payment_fee                (−)  MDR processing fee
 *   settlement_tax             (−)  GST on MDR (18%) — SEPARATE from fee
 *   rolling_reserve_deduction  (−)  timing float deducted at settlement
 *   settlement_reversal        (−)  refund / chargeback settlement
 *
 * Net = SUM of ALL signed settlement rows (the engine never re-derives a sign).
 * Gross = SUM of the positive-credit components (finalization + reserve_release):
 *   the recognized gross before fee/tax/reserve/reversal deductions.
 * Fees = the deduction components grouped by type, returned as POSITIVE magnitudes
 *   (UI renders them as "− ₹X"); fee_minor on payment_fee rows is provenance only —
 *   net math uses the signed amount_minor rows (0027 §C comment).
 *
 * Per-currency: keyed by the brand's currency_code (M1: one entry per brand — the
 * 0018 single-currency trigger). Multi-currency is additive from this interface.
 *
 * F-SEC-02: all reads happen inside withBrandTxn (explicit BEGIN/COMMIT) so the GUC
 * (app.current_brand_id) is genuinely transaction-scoped and RLS filters to this brand.
 *
 * @see 0027_razorpay_settlement.sql §C (settlement event_types + fee_minor)
 * @see realized-revenue.ts — the sibling compute fn this mirrors
 */

import type { CurrencyCode } from '@brain/money';
import type { EngineDeps } from './deps.js';
import { withBrandTxn } from './deps.js';

/** A single fee/deduction line, magnitude POSITIVE (UI renders it as a subtraction). */
export type SettlementFeeType =
  | 'payment_fee'
  | 'settlement_tax'
  | 'rolling_reserve_deduction'
  | 'settlement_reversal';

export interface SettlementFee {
  type: SettlementFeeType;
  /** POSITIVE magnitude in minor units (bigint). The signed ledger value is negated here. */
  amountMinor: bigint;
}

export interface SettlementSummary {
  /** True iff the brand has ANY settlement-type ledger row (honest no_data discriminant). */
  hasData: boolean;
  currencyCode: CurrencyCode | null;
  /** Gross recognized credit (finalization + reserve_release), minor units. */
  grossMinor: bigint;
  /** Net = SUM of all signed settlement rows (gross − fees), minor units. */
  netMinor: bigint;
  /** Per-type deduction lines, positive magnitudes. */
  fees: SettlementFee[];
}

/** The settlement event_types this summary reads (0027 §C). */
const SETTLEMENT_EVENT_TYPES = [
  'settlement_finalization',
  'payment_fee',
  'settlement_tax',
  'rolling_reserve_deduction',
  'rolling_reserve_release',
  'settlement_reversal',
] as const;

/** The positive-credit components that make up gross. */
const GROSS_CREDIT_TYPES = new Set<string>([
  'settlement_finalization',
  'rolling_reserve_release',
]);

/** The deduction components, in display order, surfaced as positive-magnitude fees. */
const FEE_TYPE_ORDER: SettlementFeeType[] = [
  'payment_fee',
  'settlement_tax',
  'rolling_reserve_deduction',
  'settlement_reversal',
];

/**
 * computeSettlementSummary — net-of-fees settlement reading as of a date, per currency.
 *
 * Reads realized_revenue_ledger settlement rows directly (this IS the named seam —
 * the SUM lives in the engine, never in the analytics module). RLS-scoped via the GUC.
 *
 * @param brandId - Brand UUID (from session — D-1; never request body).
 * @param asOf    - As-of date (inclusive). economic_effective_at::date <= asOf.
 * @param deps    - EngineDeps with raw pg.Pool.
 * @returns SettlementSummary — hasData=false when no settlement rows exist (honest no_data).
 */
export async function computeSettlementSummary(
  brandId: string,
  asOf: Date,
  deps: EngineDeps,
): Promise<SettlementSummary> {
  const asOfStr = asOf.toISOString().split('T')[0]; // 'YYYY-MM-DD'

  return withBrandTxn(deps.pool, brandId, async (client) => {
    // Brand currency_code keys the per-currency reading (0018 enforces one ccy/brand).
    const brandRow = await client.query<{ currency_code: string }>(
      `SELECT currency_code FROM brand WHERE id = $1`,
      [brandId],
    );
    const currencyCode = (brandRow.rows[0]?.currency_code ?? null) as CurrencyCode | null;

    // Per-event_type signed sum + row count. Grouping by event_type is the only
    // aggregation; the signed amount_minor carries the sign (the engine never re-signs).
    // RLS scopes brand_id; the explicit WHERE is belt-and-suspenders (must agree).
    const rows = await client.query<{ event_type: string; sum_minor: string; row_count: string }>(
      `SELECT event_type,
              COALESCE(SUM(amount_minor), 0)::text AS sum_minor,
              COUNT(*)::text AS row_count
         FROM realized_revenue_ledger
        WHERE brand_id = $1
          AND event_type = ANY($2::text[])
          AND economic_effective_at::date <= $3::date
        GROUP BY event_type`,
      [brandId, SETTLEMENT_EVENT_TYPES, asOfStr],
    );

    if (rows.rows.length === 0) {
      // No settlement rows at all → honest no_data (NEVER a fabricated zero).
      return { hasData: false, currencyCode, grossMinor: 0n, netMinor: 0n, fees: [] };
    }

    const sumByType = new Map<string, bigint>();
    for (const r of rows.rows) {
      sumByType.set(r.event_type, BigInt(r.sum_minor));
    }

    // Net = sum of ALL signed rows (gross − fees, by construction of the signs).
    let netMinor = 0n;
    for (const v of sumByType.values()) netMinor += v;

    // Gross = positive-credit components only.
    let grossMinor = 0n;
    for (const [type, v] of sumByType) {
      if (GROSS_CREDIT_TYPES.has(type)) grossMinor += v;
    }

    // Fees = deduction components as POSITIVE magnitudes (signed value negated).
    // Only emit a fee line when the type actually has rows (no fabricated zeros).
    const fees: SettlementFee[] = [];
    for (const type of FEE_TYPE_ORDER) {
      const signed = sumByType.get(type);
      if (signed === undefined) continue;
      const magnitude = signed < 0n ? -signed : signed;
      fees.push({ type, amountMinor: magnitude });
    }

    return { hasData: true, currencyCode, grossMinor, netMinor, fees };
  });
}
