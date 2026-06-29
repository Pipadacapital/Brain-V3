"""
gold_revenue_analytics.py — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=revenue.

Reimplements db/dbt/models/marts/gold_revenue_analytics.sql as a Spark job that READS Iceberg
brain_silver.silver_order_state (the Phase-1 Spark Silver mart) and WRITES Iceberg
brain_gold.gold_revenue_analytics, reproducing the per-month × lifecycle × currency realized-revenue
rollup BYTE / MINOR-UNIT EXACT. Runs BESIDE the live dbt→StarRocks brain_gold.gold_revenue_analytics —
repoints no reader, changes no dbt, changes no app code. ADDITIVE / dual-run only.

THE MART (dbt): gold_revenue_analytics is the executive/revenue dashboard's drill source — realized
revenue + order counts rolled up by month × lifecycle_state × currency, per brand. It READS SILVER ONLY
(silver_order_state) and computes ONLY ADDITIVE aggregates (COUNT / SUM); non-additive ratios (AOV/RTO%/
growth) stay the metric-engine's job and are NOT computed here. So this job is a pure GROUP BY over the
Iceberg silver_order_state mart — no money RE-derivation, the signed minor-unit order_value_minor is
carried straight from Silver and SUMmed per (brand, month, lifecycle, currency).

GRAIN / PK: (brand_id, period_month, lifecycle_state, currency_code).
  period_month  = date_format(state_effective_at, '%Y-%m')  (dbt) ≡ date_format(..., 'yyyy-MM') (Spark)
COLUMNS reproduced EXACTLY from gold_revenue_analytics.sql:
  order_count           = count(order_id)
  realized_value_minor  = cast(sum(order_value_minor) as bigint)   — signed BIGINT minor units
  terminal_order_count  = cast(sum(case when is_terminal then 1 else 0 end) as bigint)
  updated_at            = current_timestamp()
FILTER: where currency_code is not null (dbt) — per-currency rollup, currencies NEVER blended.

MONEY: realized_value_minor is signed BIGINT minor units paired with currency_code; per-currency, never
blended. brand_id is the tenant key, FIRST column. IDEMPOTENT / REPLAY-SAFE: MERGE on the 4-col PK.

READS ICEBERG SILVER ONLY: rest.brain_silver.silver_order_state (built by the Phase-1 silver_order_state.py
Spark job — the SAME canonical entity dbt's silver_order_state feeds gold_revenue_analytics). No Bronze
read, no JDBC dimension read — the entire transform is a rollup over the Iceberg Silver mart.

Run via run-gold-revenue.sh (mirrors run-silver-orders.sh — Iceberg packages; no JDBC needed here).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402

from pyspark.sql.functions import col, lit  # noqa: E402

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    GOLD_NAMESPACE,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
    run_entity_incremental,
)

SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
TABLE_NAME = "gold_revenue_analytics"

# Mirrors gold_revenue_analytics.sql column order/types (StarRocks: varchar/bigint/datetime).
_COLUMNS = """
          brand_id              string    NOT NULL,
          period_month          string    NOT NULL,
          lifecycle_state       string    NOT NULL,
          currency_code         string    NOT NULL,
          order_count           bigint    NOT NULL,
          realized_value_minor  bigint,
          terminal_order_count  bigint,
          updated_at            timestamp NOT NULL
""".strip("\n")


def _fold_and_merge(spark: SparkSession, fqtn: str) -> None:
    """Run the month×lifecycle×currency rollup + MERGE over the CURRENTLY registered `silver_order_state`
    view (one partition-incremental bucket of brands carrying their FULL order history — so each brand's
    aggregate is complete). The driver hash-buckets by brand_id."""
    # ── gold_revenue_analytics: month × lifecycle × currency additive rollup (EXACT to the dbt SQL) ──
    rollup_sql = """
        with orders as (
            select * from silver_order_state
        )
        select
            brand_id,
            date_format(state_effective_at, 'yyyy-MM')                 as period_month,
            lifecycle_state,
            currency_code,
            count(order_id)                                            as order_count,
            cast(sum(order_value_minor) as bigint)                     as realized_value_minor,
            cast(sum(case when is_terminal then 1 else 0 end) as bigint) as terminal_order_count,
            current_timestamp()                                        as updated_at
        from orders
        where currency_code is not null
        group by
            brand_id,
            date_format(state_effective_at, 'yyyy-MM'),
            lifecycle_state,
            currency_code
    """
    result = spark.sql(rollup_sql)
    result.createOrReplaceTempView("gold_revenue_analytics_new")

    # Idempotent MERGE on the (brand_id, period_month, lifecycle_state, currency_code) PK — replay-safe.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING gold_revenue_analytics_new s
        ON  t.brand_id        = s.brand_id
        AND t.period_month    = s.period_month
        AND t.lifecycle_state = s.lifecycle_state
        AND t.currency_code   = s.currency_code
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def build(spark: SparkSession) -> str:
    """PARTITION-INCREMENTAL (partition = brand_id): recompute only the brands whose silver_order_state
    rows changed since the watermark (order_state stamps updated_at when it re-folds → chains the
    incrementality), each over the brand's FULL order history, adaptively hash-bucketed by brand_id.
    Unaffected brands' aggregate rows are untouched (same UPDATE/INSERT MERGE as the full job → parity).
    FULL_REFRESH=1 recomputes all brands. See docs/ops/local-memory-budget.md."""
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(256, brand_id)",
    )
    run_entity_incremental(
        spark,
        table_name=TABLE_NAME,
        source_fqtn=SILVER_ORDER_STATE,
        event_filter=lit(True),
        entity_expr=col("brand_id"),
        fold_fn=lambda: _fold_and_merge(spark, fqtn),
        view_name="silver_order_state",
        time_col="updated_at",
    )
    n = spark.table(fqtn).count()
    print(f"[gold_revenue_analytics] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-revenue-analytics")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)


if __name__ == "__main__":
    main()
