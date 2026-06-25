/**
 * getRevenueMetrics — analytics use-case (Track A, ADR-002 sole-read-path).
 *
 * @effort deterministic
 *
 * This is the ONLY place that reads revenue metrics for the dashboard.
 * It calls computeRealizedRevenue / computeProvisionalRevenue from the metric
 * engine — NO ad-hoc SUM(amount_minor) anywhere in this module (D-3).
 *
 * The ONLY additional SQL is the existence check (D-2):
 *   SELECT 1 FROM brain_serving.mv_gold_revenue_ledger WHERE <brand> LIMIT 1
 * This is an existence signal, not a value computation — explicitly allowed by D-2.
 *
 * Honest-empty-state (D-2, HIGH-1 from CTO review):
 *   computeRealizedRevenue returns Map<ccy, 0n> when no recognized rows exist.
 *   We MUST NOT infer no_data from a zero value; the existence check is authoritative.
 *
 * Isolation / F-SEC-02 (medallion realignment, Epic 1):
 *   Revenue is out of PG — the ledger is the StarRocks gold revenue ledger. The existence
 *   check runs inside withSilverBrand (the Silver/Gold read seam, I-ST01), brand-scoped via the
 *   ${BRAND_PREDICATE} sentinel → brand_id = ?. App-layer per-brand isolation (no PG RLS here).
 *
 * Deps (load-bearing):
 *   Receives a StarRocks pool (deps.srPool) for the gold existence check; the value
 *   computations stay in the metric-engine Silver seam. No raw pg.Pool revenue read remains.
 *
 * @see D-2, D-3, D-8 (03-architecture-plan.md §4)
 * @see F-SEC-02 (02-cto-advisor-review.md §HIGH-4)
 * @see packages/metric-engine/src/realized-revenue.ts:71 (the ?? '0' landmine)
 */

import type { SilverDeps } from '@brain/metric-engine';
import { withSilverBrand, BRAND_PREDICATE, computeRealizedRevenue, computeProvisionalRevenue } from '@brain/metric-engine';
import type { RevenueSnapshot } from '../../domain/metrics/revenue-snapshot.js';
import { serializeMoneyMap } from '../../domain/metrics/revenue-snapshot.js';

/**
 * getRevenueMetrics — returns a RevenueSnapshot for a brand as of the given date.
 *
 * Algorithm:
 *   1. EXISTS(finalized) check inside withBrandTxn (RLS-scoped to brandId).
 *   2. If no finalized rows → return { state: 'no_data', realized: null, provisional: null }.
 *   3. Else call computeRealizedRevenue (engine, SOLE value source).
 *   4. Call computeProvisionalRevenue (engine, SOLE value source).
 *   5. Serialize both maps to Record<ccy, string> (bigint→string, D-1).
 *   6. Return { state: 'has_data', realized, provisional }.
 *
 * @param brandId - The brand UUID (from session, NOT request body — D-1 security invariant).
 * @param asOf    - The as-of date. Server-computed (never client-trusted — Open-Q1).
 * @param deps    - EngineDeps with raw pg.Pool (rawPgPool, not the DbPool wrapper).
 * @returns       RevenueSnapshot — discriminated by state field.
 */
export async function getRevenueMetrics(
  brandId: string,
  asOf: Date,
  deps: SilverDeps,
): Promise<RevenueSnapshot> {
  const asOfStr = asOf.toISOString().split('T')[0] as string; // 'YYYY-MM-DD'

  // Step 1: EXISTS(any recognized revenue) — the authoritative honest-empty-state check (D-2).
  // "Data" = the brand has ANY ledger row (finalized OR provisional/settling), not finalized-only:
  // a brand whose recent orders are still inside the COD/prepaid recognition horizon has REAL
  // provisional revenue and must NOT be shown "No data yet". Realized may still be a true 0 (nothing
  // past the horizon yet) — that is honest, not a fabricated zero, and provisional carries the value.
  // PHASE G follow-up: existence is checked against the lakehouse gold ledger (the dashboard read
  // source), scoped per-brand at the Silver seam (BRAND_PREDICATE).
  const hasData = await withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{ one: number }>(
      `SELECT 1 AS one FROM brain_serving.mv_gold_revenue_ledger WHERE ${BRAND_PREDICATE} LIMIT 1`,
      [],
    );
    return rows.length > 0;
  });

  // Step 2: Honest-empty-state — only if the brand has NO ledger rows at all.
  // NEVER infer no_data from a zero value (D-2, the ?? '0' landmine).
  if (!hasData) {
    return {
      state: 'no_data',
      as_of: asOfStr,
      realized: null,
      provisional: null,
    };
  }

  // Step 3 & 4: Call the engine — the SOLE computation path (D-3, ADR-002).
  // NO ad-hoc SUM(amount_minor) here or anywhere in this module.
  // Each call opens its own withBrandTxn (acceptable for M1 single-currency).
  const [realizedMap, provisionalMap] = await Promise.all([
    computeRealizedRevenue(brandId, asOf, deps),
    computeProvisionalRevenue(brandId, asOf, deps),
  ]);

  // Step 5: Serialize bigint → string (JSON has no bigint; D-1).
  const realized = serializeMoneyMap(realizedMap);
  const provisional = serializeMoneyMap(provisionalMap);

  // Step 6: Return has_data snapshot.
  return {
    state: 'has_data',
    as_of: asOfStr,
    realized,
    provisional,
  };
}
