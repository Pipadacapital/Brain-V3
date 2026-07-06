// SPEC: 0.5
/**
 * @brain/metric-engine — computeFinalizedPurchasesForWindow (the CAPI passback SOURCE seam).
 *
 * WA-02 boundary-debt fix: the notification module's capi-source query used to import
 * withSilverBrand/BRAND_PREDICATE directly and write its own serving SQL — a metric-engine
 * fence violation (I-ST03: the engine is the SOLE Gold reader, I-ST01). The Gold half of the
 * CAPI source read (step 1 — finalized positive-amount purchases in the window) now lives
 * HERE, purpose-named; notification consumes it through the analytics module facade
 * (apps/core/src/modules/analytics/index.ts). The PG operational half (identity projection +
 * capi_passback_log dedup) stays in the notification module — ops.* is NOT in Iceberg.
 *
 * Semantics are byte-identical to the inlined query it replaces: every FINALIZED
 * (recognition_label='finalized', event_type='finalization') positive-amount purchase in
 * [from, to], with the resolved brain_id, ordered by occurred_at ASC.
 *
 * MONEY (I-S07): value_minor is BIGINT minor units, string/number-serialized verbatim from
 * the ledger; the caller (capi-source.query) truncates any decimal tail exactly as before.
 *
 * Reads brain_serving.mv_gold_revenue_ledger via withSilverBrand (I-ST01); never PostgreSQL.
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** One finalized-purchase ledger row (raw serving shape — caller assembles domain rows). */
export interface FinalizedPurchaseWindowRow {
  order_id: string;
  ledger_event_id: string;
  brain_id: string | null;
  /** Signed BIGINT minor units, wire-serialized (string or number) — never a float in TS math. */
  value_minor: string | number;
  currency_code: string;
  occurred_at: string;
}

/**
 * computeFinalizedPurchasesForWindow — finalized positive-amount purchases in an ISO window.
 *
 * @param srPool  - The Trino serving pool (injected at the composition root).
 * @param brandId - Brand UUID (from session — D-1; NEVER request body).
 * @param fromIso - Window start (ISO-8601 UTC, inclusive).
 * @param toIso   - Window end (ISO-8601 UTC, inclusive).
 */
export async function computeFinalizedPurchasesForWindow(
  srPool: SilverPool,
  brandId: string,
  fromIso: string,
  toIso: string,
): Promise<FinalizedPurchaseWindowRow[]> {
  return withSilverBrand(srPool, brandId, async (scope) =>
    scope.runScoped<FinalizedPurchaseWindowRow>(
      `SELECT order_id, ledger_event_id, brain_id, amount_minor AS value_minor, currency_code, occurred_at
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE event_type = 'finalization'
          AND recognition_label = 'finalized'
          AND amount_minor > 0
          AND occurred_at >= ? AND occurred_at <= ?
          AND ${BRAND_PREDICATE}
        ORDER BY occurred_at ASC`,
      [fromIso, toIso],
    ),
  );
}
