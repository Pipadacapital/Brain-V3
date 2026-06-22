/**
 * @brain/metric-engine — getCustomerScore (DB-AUDIT C5 ML serving).
 *
 * The SOLE read seam for a SINGLE customer's deterministic RFM/churn score row from the
 * brain_gold.gold_customer_scores Gold mart — read through withSilverBrand (brand predicate injected
 * at the seam, I-ST01; the engine is the only Gold reader, the UI never queries StarRocks). Backs the
 * C5 model-serving path: the ml module reads the score here, then logs an ml.prediction_log row in PG.
 *
 * HONEST no-data: returns null when the brand has no score row for `brainId` (do NOT fabricate).
 * All brain_id/brand_id are varchar in this mart; scores are small ints; money = bigint minor units.
 * @see packages/metric-engine/src/customer-360.ts (sibling Gold read) + silver-deps.ts (seam)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export interface CustomerScoreRow {
  brainId: string;
  recencyScore: number;
  frequencyScore: number;
  monetaryScore: number;
  churnRisk: string;
  lifetimeOrders: bigint;
  lifetimeValueMinor: bigint;
  daysSinceLastOrder: number | null;
  scoredOn: string | null;
}

/**
 * getCustomerScore — the single-customer RFM/churn score row, or null if the brand has no score for
 * this customer. brandId from session (D-1); the engine reads via withSilverBrand (I-ST01).
 */
export async function getCustomerScore(
  brandId: string,
  brainId: string,
  deps: { srPool: SilverPool },
): Promise<CustomerScoreRow | null> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      brain_id: string;
      recency_score: string | number;
      frequency_score: string | number;
      monetary_score: string | number;
      churn_risk: string | null;
      lifetime_orders: string | number;
      lifetime_value_minor: string | number;
      days_since_last_order: string | number | null;
      scored_on: string | null;
    }>(
      `SELECT brain_id, recency_score, frequency_score, monetary_score, churn_risk,
              lifetime_orders, lifetime_value_minor, days_since_last_order, scored_on
         FROM brain_gold.gold_customer_scores
        WHERE brain_id = ? AND ${BRAND_PREDICATE}
        LIMIT 1`,
      [brainId],
    );

    const r = rows[0];
    if (!r) return null;

    return {
      brainId: r.brain_id,
      recencyScore: Number(r.recency_score ?? 0),
      frequencyScore: Number(r.frequency_score ?? 0),
      monetaryScore: Number(r.monetary_score ?? 0),
      churnRisk: r.churn_risk ?? 'unknown',
      lifetimeOrders: BigInt(String(r.lifetime_orders ?? '0').split('.')[0] ?? '0'),
      lifetimeValueMinor: BigInt(String(r.lifetime_value_minor ?? '0').split('.')[0] ?? '0'),
      daysSinceLastOrder:
        r.days_since_last_order === null || r.days_since_last_order === undefined
          ? null
          : Number(r.days_since_last_order),
      scoredOn: r.scored_on ?? null,
    };
  });
}
