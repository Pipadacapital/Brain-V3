/**
 * @brain/metric-engine — computeCodRto (DR-006 — the COD/RTO outcome funnel per currency).
 *
 * The SOLE reader of the Gold mart gold_cod_rto, served through the serving view
 * brain_serving.mv_gold_cod_rto via withSilverBrand (I-ST01 — the engine is the only Gold
 * reader; the UI never queries the lakehouse directly). The mart, per (brand, currency),
 * folds the 3-way reconciled silver_cod_rto grain (COD order ⨝ rto-predict ⨝ awb) into one
 * outcome row: COD order count + at-risk COD cash, predicted-RTO count, actual
 * delivered/RTO outcomes, and the checkout-prediction accuracy.
 *
 * GRAIN: (brand_id, currency_code) — exactly ONE row per currency the brand sells COD in.
 * M1 is single-currency per brand, so typically one row; multi-currency is additive and
 * NEVER blended (cod_amount_minor is per-currency, paired with its currency_code on-row).
 *
 * MONEY + BPS: cod_amount_minor is BIGINT minor units (→ bigint here, string at the DTO).
 * The two rates are INTEGER BASIS POINTS computed by the mart (floor division, no float):
 * rto_rate_bps over the RESOLVED base (delivered + RTO) and prediction_accuracy_bps over
 * prediction_evaluated. Both are NULL when their denominator is 0 — the engine passes the
 * NULL through VERBATIM (honest insufficient-data; never a fabricated 0 bps).
 *
 * ── ISOLATION ──────────────────────────────────────────────────────────────────
 * Every read goes through withSilverBrand (brand predicate injected at the seam). brandId is
 * from session (D-1; NEVER body).
 *
 * @see db/iceberg/duckdb/gold/gold_cod_rto.py + db/iceberg/duckdb/views/mv_gold_cod_rto.sql
 * @see packages/metric-engine/src/cod-mix.ts — the CoD ledger-mix sibling this mirrors
 */

import type { CurrencyCode } from '@brain/money';
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Coerce a serving numeric (string|number) to bigint, dropping any fractional tail. */
function toBig(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] ?? '0');
}

/** Coerce a nullable serving integer (bps) to number | null (null stays null — honest "unresolved"). */
function toIntOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(String(v).split('.')[0] ?? '0');
}

/** One (brand, currency) COD/RTO outcome row off the mart. */
export interface CodRtoCurrencySummary {
  currencyCode: CurrencyCode;
  /** COD orders observed (the funnel top). */
  codOrders: bigint;
  /** At-risk COD cash, BIGINT minor units — per-currency, never blended. */
  codAmountMinor: bigint;
  /** Orders flagged RTO-risk at checkout (predicted_rto = true). */
  predictedRto: bigint;
  /** Orders with a terminal DELIVERED outcome. */
  actualDelivered: bigint;
  /** Orders with a terminal RTO outcome. */
  actualRto: bigint;
  /** Resolved orders = delivered + RTO (the rate base). */
  resolved: bigint;
  /** RTO rate in integer basis points over resolved; null when resolved = 0 (honest). */
  rtoRateBps: number | null;
  /** Predictions that matched the terminal outcome. */
  predictionCorrect: bigint;
  /** Predictions with a terminal outcome to evaluate against. */
  predictionEvaluated: bigint;
  /** Prediction accuracy in integer basis points; null when predictionEvaluated = 0 (honest). */
  predictionAccuracyBps: number | null;
  /** Mart refresh timestamp (ISO-ish string as served); null if absent. */
  updatedAt: string | null;
}

export interface CodRtoResult {
  /** True iff the brand has any COD/RTO mart row (honest no_data). */
  hasData: boolean;
  /** Per-currency outcome rows, ordered by COD-order volume desc. */
  byCurrency: CodRtoCurrencySummary[];
}

interface CodRtoRow {
  currency_code: string;
  cod_orders: string | number;
  cod_amount_minor: string | number;
  predicted_rto: string | number;
  actual_delivered: string | number;
  actual_rto: string | number;
  resolved: string | number;
  rto_rate_bps: string | number | null;
  prediction_correct: string | number;
  prediction_evaluated: string | number;
  prediction_accuracy_bps: string | number | null;
  updated_at: string | null;
}

/**
 * computeCodRto — a brand's COD/RTO outcome funnel per currency (gold_cod_rto).
 *
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param deps    - The Gold serving pool (gold_cod_rto via brain_serving.mv_gold_cod_rto).
 * @returns       Per-currency outcomes; hasData=false when the brand has no COD orders.
 */
export async function computeCodRto(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CodRtoResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    // ${BRAND_PREDICATE} LAST → the seam-appended brandId binds positionally to its single `?`.
    const rows = await scope.runScoped<CodRtoRow>(
      `SELECT currency_code, cod_orders, cod_amount_minor, predicted_rto,
              actual_delivered, actual_rto, resolved, rto_rate_bps,
              prediction_correct, prediction_evaluated, prediction_accuracy_bps, updated_at
         FROM brain_serving.mv_gold_cod_rto
        WHERE ${BRAND_PREDICATE}
        ORDER BY currency_code ASC`,
      [],
    );

    if (rows.length === 0) {
      return { hasData: false, byCurrency: [] };
    }

    const byCurrency: CodRtoCurrencySummary[] = rows.map((r) => ({
      currencyCode: String(r.currency_code) as CurrencyCode,
      codOrders: toBig(r.cod_orders),
      codAmountMinor: toBig(r.cod_amount_minor),
      predictedRto: toBig(r.predicted_rto),
      actualDelivered: toBig(r.actual_delivered),
      actualRto: toBig(r.actual_rto),
      resolved: toBig(r.resolved),
      rtoRateBps: toIntOrNull(r.rto_rate_bps),
      predictionCorrect: toBig(r.prediction_correct),
      predictionEvaluated: toBig(r.prediction_evaluated),
      predictionAccuracyBps: toIntOrNull(r.prediction_accuracy_bps),
      updatedAt: r.updated_at === null || r.updated_at === undefined ? null : String(r.updated_at),
    }));

    // Order currencies by COD-order volume desc (then code) — the busiest currency leads.
    byCurrency.sort((a, b) => {
      if (a.codOrders !== b.codOrders) return a.codOrders > b.codOrders ? -1 : 1;
      return a.currencyCode.localeCompare(b.currencyCode);
    });

    return { hasData: true, byCurrency };
  });
}
