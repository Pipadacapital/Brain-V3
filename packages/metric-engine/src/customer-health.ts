/**
 * @brain/metric-engine — getCustomerHealthSummary (Brain V4 NET-NEW gap Gold seam).
 *
 * The SOLE read seam for the DETERMINISTIC customer-health Gold mart
 * (brain_serving.mv_gold_customer_health over Iceberg brain_gold.gold_customer_health) — read through
 * withSilverBrand (brand predicate injected at the seam, I-ST01; the engine is the only Gold reader,
 * the UI never queries StarRocks). Returns a brand's customer-health band distribution + the customers
 * most at risk (churned/at_risk, ordered by recency).
 *
 * health_score is an INTEGER 0-100 (a confidence-style score, NEVER blended with money). The sibling
 * money pair (lifetimeValueMinor + currencyCode) is carried VERBATIM from silver_customer — never
 * summed across currencies, never folded into the score. No raw/hashed PII: brain_id is the only key.
 *
 * Honest-empty: hasData=false when the brand has no resolved customers.
 * @see packages/metric-engine/src/customer-360.ts (sibling Gold read) + silver-deps.ts (seam)
 */
import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

export type HealthBand = 'healthy' | 'at_risk' | 'churned';

export interface CustomerHealthRow {
  brainId: string;
  recencyDays: number;
  frequency: bigint;
  /** INTEGER 0-100, deterministic from recency/frequency. Never blended with money. */
  healthScore: number;
  healthBand: HealthBand;
  lastOrderAt: string | null;
  /** Sibling money pair carried verbatim from silver_customer — NOT folded into healthScore. */
  lifetimeValueMinor: bigint;
  currencyCode: string | null;
}

export interface CustomerHealthSummary {
  hasData: boolean;
  customerCount: bigint;
  healthyCount: bigint;
  atRiskCount: bigint;
  churnedCount: bigint;
  /** Customers most at risk (churned + at_risk), ordered by oldest recency first, capped. */
  atRiskCustomers: CustomerHealthRow[];
}

const TOP_N = 10;

function toBand(raw: string | null | undefined): HealthBand {
  return raw === 'healthy' || raw === 'churned' ? raw : 'at_risk';
}

export async function getCustomerHealthSummary(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CustomerHealthSummary> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const summaryRows = await scope.runScoped<{
      customer_count: string | number;
      healthy_count: string | number;
      at_risk_count: string | number;
      churned_count: string | number;
    }>(
      `SELECT COUNT(*)                                                        AS customer_count,
              COALESCE(SUM(CASE WHEN health_band = 'healthy' THEN 1 ELSE 0 END), 0) AS healthy_count,
              COALESCE(SUM(CASE WHEN health_band = 'at_risk' THEN 1 ELSE 0 END), 0) AS at_risk_count,
              COALESCE(SUM(CASE WHEN health_band = 'churned' THEN 1 ELSE 0 END), 0) AS churned_count
         FROM brain_serving.mv_gold_customer_health
        WHERE ${BRAND_PREDICATE}`,
      [],
    );

    const s = summaryRows[0];
    const customerCount = BigInt(String(s?.customer_count ?? '0'));
    if (customerCount === 0n) {
      return {
        hasData: false,
        customerCount: 0n,
        healthyCount: 0n,
        atRiskCount: 0n,
        churnedCount: 0n,
        atRiskCustomers: [],
      };
    }

    const riskRows = await scope.runScoped<{
      brain_id: string;
      recency_days: string | number;
      frequency: string | number;
      health_score: string | number;
      health_band: string | null;
      last_order_at: string | null;
      lifetime_value_minor: string | number | null;
      currency_code: string | null;
    }>(
      `SELECT brain_id, recency_days, frequency, health_score, health_band, last_order_at,
              lifetime_value_minor, currency_code
         FROM brain_serving.mv_gold_customer_health
        WHERE ${BRAND_PREDICATE}
          AND health_band IN ('at_risk', 'churned')
        ORDER BY recency_days DESC
        LIMIT ${TOP_N}`,
      [],
    );

    return {
      hasData: true,
      customerCount,
      healthyCount: BigInt(String(s?.healthy_count ?? '0')),
      atRiskCount: BigInt(String(s?.at_risk_count ?? '0')),
      churnedCount: BigInt(String(s?.churned_count ?? '0')),
      atRiskCustomers: riskRows.map((r) => ({
        brainId: r.brain_id,
        recencyDays: Number(r.recency_days ?? 0),
        frequency: BigInt(String(r.frequency ?? '0')),
        healthScore: Number(r.health_score ?? 0),
        healthBand: toBand(r.health_band),
        lastOrderAt: r.last_order_at ?? null,
        lifetimeValueMinor: BigInt(String(r.lifetime_value_minor ?? '0').split('.')[0] ?? '0'),
        currencyCode: r.currency_code ?? null,
      })),
    };
  });
}
