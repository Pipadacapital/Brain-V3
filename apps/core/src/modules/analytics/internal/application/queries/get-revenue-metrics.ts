/**
 * getRevenueMetrics — analytics use-case (Track A, ADR-002 sole-read-path).
 *
 * @effort deterministic
 *
 * This is the ONLY place that reads revenue metrics for the dashboard.
 * It calls computeRealizedRevenue / computeProvisionalRevenue from the metric
 * engine — NO ad-hoc SUM(amount_minor) anywhere in this module (D-3).
 *
 * The ONLY additional SQL is the EXISTS existence check (D-2):
 *   EXISTS(SELECT 1 FROM realized_revenue_ledger WHERE recognition_label='finalized')
 * This is an existence signal, not a value computation — explicitly allowed by D-2.
 *
 * Honest-empty-state (D-2, HIGH-1 from CTO review):
 *   computeRealizedRevenue returns Map<ccy, 0n> when no finalized rows exist
 *   (the realized_gmv_as_of() ?? '0' landmine at realized-revenue.ts:71).
 *   We MUST NOT infer no_data from a zero value; the EXISTS check is authoritative.
 *
 * RLS / F-SEC-02:
 *   withBrandTxn sets the GUC (app.current_brand_id) transaction-locally — the
 *   EXISTS check runs inside withBrandTxn so RLS scopes brand_id automatically.
 *   Do NOT add a manual WHERE brand_id=$1 as the isolation guarantee; RLS is the
 *   guarantee. Passing it as a query param is harmless (belt-and-suspenders) but
 *   BOTH the GUC scope and the explicit WHERE must agree.
 *
 * Pool type (D §3.1, load-bearing):
 *   Receives EngineDeps ({ pool: pg.Pool }) — the RAW pg.Pool (rawPgPool from main.ts).
 *   Do NOT pass the DbPool wrapper — it would double-apply GUCs.
 *
 * @see D-2, D-3, D-8 (03-architecture-plan.md §4)
 * @see F-SEC-02 (02-cto-advisor-review.md §HIGH-4)
 * @see packages/metric-engine/src/realized-revenue.ts:71 (the ?? '0' landmine)
 */

import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn, computeRealizedRevenue, computeProvisionalRevenue } from '@brain/metric-engine';
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
  deps: EngineDeps,
): Promise<RevenueSnapshot> {
  const asOfStr = asOf.toISOString().split('T')[0] as string; // 'YYYY-MM-DD'

  // Step 1: EXISTS(any recognized revenue) — the authoritative honest-empty-state check (D-2).
  // "Data" = the brand has ANY ledger row (finalized OR provisional/settling), not finalized-only:
  // a brand whose recent orders are still inside the COD/prepaid recognition horizon has REAL
  // provisional revenue and must NOT be shown "No data yet". Realized may still be a true 0 (nothing
  // past the horizon yet) — that is honest, not a fabricated zero, and provisional carries the value.
  // Runs inside withBrandTxn so the GUC is set and RLS scopes brand_id automatically.
  const hasData = await withBrandTxn(deps.pool, brandId, async (client) => {
    const r = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM realized_revenue_ledger
         WHERE brand_id = $1
       ) AS exists`,
      [brandId],
    );
    return r.rows[0]?.exists === true;
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
