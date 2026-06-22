/**
 * getSettlementSummary — analytics use-case (ADR-002 sole-read-path, Razorpay Track C).
 *
 * @effort deterministic
 *
 * Thin query wrapper around computeSettlementSummary (metric engine). It does NO
 * ad-hoc SUM(amount_minor) — the named seam owns the aggregation (D-3). This module
 * only serializes bigint → string for JSON safety (D-1) and shapes the honest
 * no_data discriminant.
 *
 * Honest-empty-state (D-2): state='no_data' when the brand has NO settlement-type
 * ledger rows. NEVER infer no_data from a zero value — computeSettlementSummary's
 * hasData flag is the authoritative signal (it returns hasData=false only when zero
 * settlement rows exist, not when the net happens to be 0).
 *
 * RLS / F-SEC-02: the engine wraps its read in withBrandTxn so the GUC is set and
 * RLS scopes brand_id automatically. Brand from session (D-1) — never request body.
 *
 * @see packages/metric-engine/src/settlement-summary.ts
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeSettlementSummary, type SettlementFeeType } from '@brain/metric-engine';

/** A single fee/deduction line — magnitude POSITIVE, serialized to string (D-1). */
export interface SettlementFeeDto {
  type: SettlementFeeType;
  amount_minor: string; // bigint → string, POSITIVE magnitude (UI renders as "− ₹X")
}

/**
 * SettlementSummaryResult — the shape returned by getSettlementSummary.
 *
 * state='no_data':  no settlement rows → gross/net/fees absent.
 * state='has_data': ≥1 settlement row → gross_minor, net_minor, fees, currency_code present.
 */
export type SettlementSummaryResult =
  | { state: 'no_data'; as_of: string }
  | {
      state: 'has_data';
      as_of: string;
      currency_code: string;
      gross_minor: string; // bigint → string
      net_minor: string;   // bigint → string (net-of-fees)
      fees: SettlementFeeDto[];
    };

/**
 * getSettlementSummary — returns a brand's settlement summary as of a date.
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param asOf    - As-of date. Server-computed (never client-trusted).
 * @param deps    - The StarRocks Silver/Gold pool — gold_revenue_ledger via withSilverBrand (Phase G).
 */
export async function getSettlementSummary(
  brandId: string,
  asOf: Date,
  deps: { srPool: SilverPool },
): Promise<SettlementSummaryResult> {
  const asOfStr = asOf.toISOString().split('T')[0] as string;

  const summary = await computeSettlementSummary(brandId, asOf, deps);

  // Honest no_data — driven by the engine's hasData flag, NOT by a zero value (D-2).
  if (!summary.hasData || summary.currencyCode === null) {
    return { state: 'no_data', as_of: asOfStr };
  }

  return {
    state: 'has_data',
    as_of: asOfStr,
    currency_code: summary.currencyCode,
    gross_minor: String(summary.grossMinor),
    net_minor: String(summary.netMinor),
    fees: summary.fees.map((f) => ({ type: f.type, amount_minor: String(f.amountMinor) })),
  };
}
