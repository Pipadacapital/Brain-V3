"""
gold_retention.py — NET-NEW gap Gold `retention` mart (Brain V4 Phase 2/B7, GROUP "NEW gap Gold products").

NO dbt predecessor (parity status=NEW). The materialized retention/repeat-purchase surface — one row per
(brand_id, cohort_month) holding, FOR THE CUSTOMERS ACQUIRED IN THAT MONTH, the deterministic
repeat-purchase / returning-customer / orders-per-customer roll-up. It reuses the SAME acquisition-cohort
grain as gold_cohorts (group by brand_id + date_format(first_seen_at,'yyyy-MM')), so a retention curve and
a cohort-value curve line up row-for-row.

GRAIN  : 1 row per (brand_id, cohort_month). cohort_month = date_format(first_seen_at,'yyyy-MM') — the
         acquisition cohort / period. currency_code is an AGGREGATE (max) inside the group, NOT a grouping
         key — EXACTLY the gold_cohorts grain (the StarRocks-era PK listed currency_code, but the Spark
         MERGE key is (brand_id, cohort_month); see _gold_registry note on gold_cohorts).
SOURCE : Iceberg brain_silver.silver_customer — the brain_id-keyed additive customer rollup of
         silver_order_state (lifetime_orders + first_seen_at + currency_code, one row per (brand_id,
         brain_id)). Reading silver_customer IS the "fold from silver_order_state + the identity brain_id"
         (silver_customer is that fold, already deduped to the resolved customer). Mirror of gold_cohorts.

COLUMNS (all additive components + integer-bps rates — NO money, NO float; like gold_logistics_performance):
  cohort_customers            — customers acquired in the cohort (count of brain_id rows).
  repeat_customers            — of those, the ones with lifetime_orders >= 2 (purchased more than once).
  total_orders               — Σ lifetime_orders across the cohort's customers.
  repeat_orders              — total_orders − cohort_customers (orders BEYOND each customer's first/
                               acquiring order = the "returning" purchases). Always >= 0.
  repeat_purchase_rate_bps    — repeat_customers * 10000 / cohort_customers  (customer-weighted, integer bps).
  returning_customer_rate_bps — repeat_orders   * 10000 / total_orders      (order-weighted, integer bps;
                               NULL when total_orders = 0).
  avg_orders_per_customer_bps — total_orders    * 10000 / cohort_customers  (e.g. 1.50 orders → 15000 bps;
                               integer bps so the no-float rule holds — divide by 10000 at the read seam).

WHY bps not a ratio (V4 no-float rule): every rate is an EXACT integer basis-point (×10000 then integer
  divide). The non-additive ratio is reconstituted at the metric-engine read seam (computeRetention →
  exact decimal string), NEVER stored as a float. cohort_customers is a group COUNT so it is always >= 1
  (no div-by-zero on the customer-weighted rates); the order-weighted rate guards total_orders > 0.

NO MONEY: a retention mart is purely behavioral counts + integer-bps rates — registered money_columns=[].
  currency_code is carried (max per cohort) only so a brand's cohort stays per-currency-consistent with
  gold_cohorts; it is a descriptor, never blended into a money sum.

REPLAY-SAFE: full recompute from Silver each run, MERGE-UPDATE'd on the (brand_id, cohort_month) PK —
  a re-run over the same Silver is a no-op on row identity and refreshes the latest rollup.
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer annotation eval.

from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver

TABLE = "gold_retention"

COLUMNS_SQL = """
          brand_id                       string    NOT NULL,
          cohort_month                   string    NOT NULL,
          currency_code                  string,
          cohort_customers               bigint    NOT NULL,
          repeat_customers               bigint    NOT NULL,
          total_orders                   bigint    NOT NULL,
          repeat_orders                  bigint    NOT NULL,
          repeat_purchase_rate_bps       bigint,
          returning_customer_rate_bps    bigint,
          avg_orders_per_customer_bps    bigint,
          updated_at                     timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_gold_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(4, brand_id)")

    staged = spark.sql(
        f"""
        WITH cohort AS (
            SELECT
                brand_id,
                date_format(first_seen_at, 'yyyy-MM')                       AS cohort_month,
                MAX(currency_code)                                          AS currency_code,
                COUNT(*)                                                    AS cohort_customers,
                SUM(CASE WHEN lifetime_orders >= 2 THEN 1 ELSE 0 END)       AS repeat_customers,
                CAST(SUM(COALESCE(lifetime_orders, 0)) AS bigint)           AS total_orders
            FROM {silver('silver_customer')}
            WHERE brand_id IS NOT NULL AND first_seen_at IS NOT NULL
            GROUP BY brand_id, date_format(first_seen_at, 'yyyy-MM')
        )
        SELECT
            brand_id,
            cohort_month,
            currency_code,
            cohort_customers,
            repeat_customers,
            total_orders,
            -- orders beyond each customer's first (acquiring) order = the returning purchases (>= 0).
            CAST(GREATEST(total_orders - cohort_customers, CAST(0 AS bigint)) AS bigint)  AS repeat_orders,
            -- customer-weighted repeat rate, integer bps (cohort_customers is a group COUNT, always >= 1).
            CAST(repeat_customers * 10000 / cohort_customers AS bigint)                   AS repeat_purchase_rate_bps,
            -- order-weighted returning rate, integer bps; NULL when no orders.
            CASE WHEN total_orders > 0
                 THEN CAST(GREATEST(total_orders - cohort_customers, CAST(0 AS bigint)) * 10000 / total_orders AS bigint)
                 ELSE NULL END                                                            AS returning_customer_rate_bps,
            -- avg lifetime orders per customer, integer bps (÷10000 at the read seam → e.g. 1.50).
            CAST(total_orders * 10000 / cohort_customers AS bigint)                       AS avg_orders_per_customer_bps,
            current_timestamp()                                                           AS updated_at
        FROM cohort
        """
    )

    merge_on_pk(spark, fqtn, staged, ["brand_id", "cohort_month"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("gold-retention", build)
