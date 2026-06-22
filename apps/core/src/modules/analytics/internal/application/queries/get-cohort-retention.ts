/**
 * getCohortRetention — analytics use-case (ADR-002 sole-read-path) for the H9/H11 cohort curve.
 *
 * Acquisition-cohort retention over the order spine, from gold_cohorts via computeCohortRetention
 * (metric engine, registry: cohort_retention). NO ad-hoc arithmetic (D-3); the engine derives the
 * per-customer ratios. Money = BIGINT minor units (I-S07) serialized to string (D-1). Honest no_data
 * when the brand has no acquisition cohorts. brandId from session (D-1; NEVER body).
 */

import type { SilverPool } from '@brain/metric-engine';
import { computeCohortRetention } from '@brain/metric-engine';

export interface CohortRetentionDto {
  cohort_month: string;
  currency_code: string;
  cohort_size: string;          // bigint → string
  cohort_orders: string;        // bigint → string
  cohort_value_minor: string;   // bigint → string
  orders_per_customer: string | null; // exact decimal, null when size=0
}

export type CohortRetentionResult =
  | { state: 'no_data' }
  | { state: 'has_data'; cohorts: CohortRetentionDto[] };

export async function getCohortRetention(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CohortRetentionResult> {
  const res = await computeCohortRetention(brandId, deps);
  if (!res.hasData) return { state: 'no_data' };
  return {
    state: 'has_data',
    cohorts: res.rows.map((r) => ({
      cohort_month: r.cohortMonth,
      currency_code: r.currencyCode,
      cohort_size: String(r.cohortSize),
      cohort_orders: String(r.cohortOrders),
      cohort_value_minor: String(r.cohortValueMinor),
      orders_per_customer: r.ordersPerCustomer,
    })),
  };
}
