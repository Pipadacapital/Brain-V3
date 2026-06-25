/**
 * @brain/metric-engine — computeRealizedGmvCompositionForPeriod (the inspectable-bill seam, Tier-0).
 *
 * The per-event_type composition of a brand's realized GMV for a 'YYYY-MM' billing period — the
 * reconcilable breakdown behind the inspectable bill (finalizations +, refunds/reversals −). D-3:
 * money math lives in the metric engine, never as an ad-hoc SUM in app code — this is the lakehouse
 * replacement for the PostgreSQL realized_gmv_composition_for_period() function (medallion realignment,
 * Epic 1 / decision B: billing reads the lakehouse, not the PG ledger).
 *
 * Keyed by billing_posted_period (the DELTA posted to THIS period). Signed BIGINT minor units (I-S07).
 * Reads brain_gold.gold_revenue_ledger via withSilverBrand (I-ST01); never PostgreSQL.
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface RealizedGmvCompositionLine {
  eventType: string;
  /** Currency of the line (single-per-brand M1). */
  currencyCode: string;
  /** Signed realized contribution of this event_type in minor units, bigint-as-string (I-S07). */
  amountMinor: string;
}

/**
 * computeRealizedGmvCompositionForPeriod — per-event_type realized-GMV breakdown for a period.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param period  - 'YYYY-MM' billing_posted_period.
 * @param deps    - { srPool } — the StarRocks Silver/Gold pool.
 */
export async function computeRealizedGmvCompositionForPeriod(
  brandId: string,
  period: string,
  deps: { srPool: SilverPool },
): Promise<RealizedGmvCompositionLine[]> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      event_type: string;
      currency_code: string | null;
      amount_minor: string | number;
    }>(
      `SELECT event_type,
              currency_code,
              SUM(amount_minor) AS amount_minor
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE billing_posted_period = ?
          AND event_type <> 'provisional_recognition'
          AND ${BRAND_PREDICATE}
        GROUP BY event_type, currency_code
        ORDER BY SUM(amount_minor) DESC`,
      [period],
    );
    return rows.map((r) => ({
      eventType: r.event_type,
      currencyCode: (r.currency_code ?? 'INR').trim(),
      amountMinor: String(r.amount_minor ?? '0').split('.')[0] || '0',
    }));
  });
}
