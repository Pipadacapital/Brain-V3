/**
 * @brain/metric-engine — computeExecutiveMetrics (H9).
 *
 * The executive dashboard's HEADLINE source, served from the Gold marts (gold_executive_metrics +
 * gold_cohorts) through withSilverBrand (I-ST01 — the engine is the sole Gold reader; the UI never
 * queries StarRocks). Wires the previously-orphaned gold_executive_metrics + gold_cohorts marts to a
 * registry-backed reader so the headline numbers (AOV, LTV, repeat_rate, CAC tiles) go through the
 * metric registry, not an ad-hoc BFF SUM.
 *
 * Gold stores only the ADDITIVE components (ADR-004): realized value, order counts, distinct
 * customers, per-cohort customer/order counts. The NON-ADDITIVE ratios are derived HERE at read:
 *   - aov          = realized_value_minor ÷ total_orders               (registry: aov)
 *   - ltv          = realized_value_minor ÷ distinct_customers         (registry: ltv, cohort-naive)
 *   - repeat_rate  = repeat_customers ÷ total_customers (from cohorts)  (registry: repeat_rate)
 * All money is BIGINT minor units + currency_code (I-S07). Ratios are EXACT decimal strings from the
 * integer operands (no float); null when the denominator is 0 (honest, never divide-by-zero).
 *
 * NO MODEL, NO FORECAST: LTV here is the honest realized-revenue-per-customer (cohort-naive M1), NOT
 * a predicted/discounted LTV (that is deferred to the feature layer). Labelled accordingly.
 *
 * @see db/iceberg/spark/gold/ + brain_serving.mv_gold_executive_metrics / mv_gold_cohorts (dbt removed in V4)
 * @see packages/metric-engine/src/customer-360.ts (sibling Gold reader)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

/** Format an exact integer ratio numerator/denominator to a fixed-precision decimal string. */
function exactRatioString(numerator: bigint, denominator: bigint, fractionalDigits = 2): string {
  const scale = 10n ** BigInt(fractionalDigits);
  const scaled = (numerator * scale) / denominator;
  const intPart = scaled / scale;
  const fracPart = scaled % scale;
  const absFrac = fracPart < 0n ? -fracPart : fracPart;
  return `${intPart.toString()}.${absFrac.toString().padStart(fractionalDigits, '0')}`;
}

export interface ExecutiveMetricsRow {
  currencyCode: string;
  /** Realized GMV (finalized), BIGINT minor units. */
  realizedValueMinor: bigint;
  /** Total orders (all lifecycle states present in the mart). */
  totalOrders: bigint;
  /** Distinct customers (brain_id) with realized orders. */
  distinctCustomers: bigint;
  /** AOV = realized ÷ orders, minor units, exact decimal string; null when orders=0 (honest). */
  aovMinor: string | null;
  /** LTV (cohort-naive) = realized ÷ customers, minor units; null when customers=0 (honest). */
  ltvMinor: string | null;
  /** Repeat-purchase customers (≥2 lifetime orders) ÷ all customers, percent string; null when 0. */
  repeatRatePct: string | null;
}

export interface ExecutiveMetricsResult {
  hasData: boolean;
  rows: ExecutiveMetricsRow[];
}

/**
 * computeExecutiveMetrics — the headline KPI components + derived ratios, per currency.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - The StarRocks Gold pool (gold_executive_metrics + gold_cohorts).
 * @returns       One row per currency_code; hasData=false when the brand has no Gold rows.
 */
export async function computeExecutiveMetrics(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<ExecutiveMetricsResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const execRows = await scope.runScoped<{
      currency_code: string;
      realized_value_minor: string | number;
      total_orders: string | number;
      distinct_customers: string | number;
    }>(
      `SELECT currency_code,
              COALESCE(SUM(realized_value_minor), 0) AS realized_value_minor,
              COALESCE(SUM(total_orders), 0)         AS total_orders,
              COALESCE(SUM(distinct_customers), 0)   AS distinct_customers
         FROM brain_serving.mv_gold_executive_metrics
        WHERE ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );

    if (execRows.length === 0) {
      return { hasData: false, rows: [] };
    }

    // repeat_rate: a customer is "repeat" when they have ≥2 lifetime orders. The precise per-customer
    // count is NOT available at the gold_cohorts aggregate grain (cohort_size/cohort_orders only), so
    // we fold it deterministically from gold_customer_360 (1 row per customer with lifetime_orders) —
    // no fabrication, exact count. (gold_cohorts powers the cohort_retention curve separately.)
    const repeatRows = await scope.runScoped<{
      currency_code: string;
      total_customers: string | number;
      repeat_customers: string | number;
    }>(
      `SELECT currency_code,
              COUNT(*)                                                AS total_customers,
              SUM(CASE WHEN lifetime_orders >= 2 THEN 1 ELSE 0 END)   AS repeat_customers
         FROM brain_serving.mv_gold_customer_360
        WHERE ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );
    const repeatByCcy = new Map<string, { total: bigint; repeat: bigint }>();
    for (const r of repeatRows) {
      repeatByCcy.set(r.currency_code, {
        total: BigInt(String(r.total_customers ?? '0')),
        repeat: BigInt(String(r.repeat_customers ?? '0')),
      });
    }
    const rows: ExecutiveMetricsRow[] = execRows.map((r) => {
      const realizedValueMinor = BigInt(String(r.realized_value_minor ?? '0').split('.')[0] ?? '0');
      const totalOrders = BigInt(String(r.total_orders ?? '0').split('.')[0] ?? '0');
      const distinctCustomers = BigInt(String(r.distinct_customers ?? '0').split('.')[0] ?? '0');
      const repeat = repeatByCcy.get(r.currency_code);
      return {
        currencyCode: r.currency_code,
        realizedValueMinor,
        totalOrders,
        distinctCustomers,
        aovMinor: totalOrders > 0n ? exactRatioString(realizedValueMinor, totalOrders) : null,
        ltvMinor: distinctCustomers > 0n ? exactRatioString(realizedValueMinor, distinctCustomers) : null,
        repeatRatePct:
          repeat && repeat.total > 0n ? exactRatioString(repeat.repeat * 100n, repeat.total) : null,
      };
    });

    rows.sort((a, b) => (a.currencyCode < b.currencyCode ? -1 : a.currencyCode > b.currencyCode ? 1 : 0));
    return { hasData: true, rows };
  });
}

// ── Cohort retention (H9 / H11) ──────────────────────────────────────────────

export interface CohortRow {
  /** Acquisition cohort 'YYYY-MM' (first-seen month). */
  cohortMonth: string;
  currencyCode: string;
  /** Customers acquired in the cohort. */
  cohortSize: bigint;
  /** Lifetime orders attributed to the cohort. */
  cohortOrders: bigint;
  /** Lifetime realized value of the cohort, BIGINT minor units. */
  cohortValueMinor: bigint;
  /** Avg lifetime orders per customer = cohort_orders ÷ cohort_size, exact decimal; null when size=0. */
  ordersPerCustomer: string | null;
}

export interface CohortRetentionResult {
  hasData: boolean;
  rows: CohortRow[];
}

/**
 * computeCohortRetention — acquisition-cohort curve from gold_cohorts (H9/H11).
 *
 * Surfaces the additive cohort components (size, lifetime orders, lifetime value) + the
 * deterministic per-customer orders ratio. Retention beyond order-count requires the order spine's
 * per-month activity (deferred to a richer cohort mart — noted). Honest no_data on zero cohorts.
 */
export async function computeCohortRetention(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<CohortRetentionResult> {
  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const rows = await scope.runScoped<{
      cohort_month: string;
      currency_code: string;
      cohort_size: string | number;
      cohort_orders: string | number;
      cohort_value_minor: string | number;
    }>(
      `SELECT cohort_month, currency_code,
              COALESCE(SUM(cohort_size), 0)        AS cohort_size,
              COALESCE(SUM(cohort_orders), 0)      AS cohort_orders,
              COALESCE(SUM(cohort_value_minor), 0) AS cohort_value_minor
         FROM brain_serving.mv_gold_cohorts
        WHERE ${BRAND_PREDICATE}
        GROUP BY cohort_month, currency_code
        ORDER BY cohort_month ASC`,
      [],
    );

    if (rows.length === 0) return { hasData: false, rows: [] };

    return {
      hasData: true,
      rows: rows.map((r) => {
        const cohortSize = BigInt(String(r.cohort_size ?? '0').split('.')[0] ?? '0');
        const cohortOrders = BigInt(String(r.cohort_orders ?? '0').split('.')[0] ?? '0');
        return {
          cohortMonth: r.cohort_month,
          currencyCode: r.currency_code,
          cohortSize,
          cohortOrders,
          cohortValueMinor: BigInt(String(r.cohort_value_minor ?? '0').split('.')[0] ?? '0'),
          ordersPerCustomer: cohortSize > 0n ? exactRatioString(cohortOrders, cohortSize) : null,
        };
      }),
    };
  });
}
