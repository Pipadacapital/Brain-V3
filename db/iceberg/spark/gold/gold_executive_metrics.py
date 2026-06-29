"""
gold_executive_metrics.py — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=executive+cac.

Reimplements the dbt model db/dbt/models/marts/gold_executive_metrics.sql as a Spark job that READS
Iceberg brain_silver.silver_order_state (built by the Phase-1 Spark job silver_order_state.py) and
WRITES Iceberg brain_gold.gold_executive_metrics via an idempotent MERGE on the mart PK. It runs
BESIDE the live dbt→StarRocks brain_gold.gold_executive_metrics (dual-run, NON-BREAKING): it repoints
no reader, changes no dbt model, changes no app code. ADDITIVE only.

THE dbt TRANSFORM (reproduced byte/minor-unit exact):
  select brand_id, currency_code,
         count(order_id)                                              as total_orders,
         cast(sum(order_value_minor) as bigint)                       as realized_value_minor,
         cast(count(distinct brain_id) as bigint)                     as distinct_customers,
         cast(sum(case when is_terminal then 1 else 0 end) as bigint) as terminal_orders,
         sum(case when lifecycle_state='delivered' then 1 else 0 end) as delivered_orders,
         ... rto/cancelled/refunded ...,
         'live' as data_source, current_timestamp() as updated_at
  from silver_order_state
  where currency_code is not null
  group by brand_id, currency_code

GRAIN / PK: exactly one row per (brand_id, currency_code) — the mart PK.
MONEY: realized_value_minor = Σ(order_value_minor) as bigint MINOR units, per (brand, currency) — NEVER
  blended across currencies (the GROUP BY currency_code guarantees per-currency isolation). Paired with
  currency_code on-row. brand_id is the tenant key, FIRST column.
ADDITIVE ONLY (ADR-004): only additive COMPONENTS are stored. Non-additive ratios (AOV, RTO%) are derived
  at read by the metric-engine — NOT stored here. We mirror that: no ratios computed in this job.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, currency_code) — re-running over the same Silver restates
  the same rows (UPDATE *) and inserts new (brand, currency) pairs. data_source is hard-coded 'live'
  (MK-1: real builds = live; the demo seed overwrites to 'synthetic' on the dbt side — not our concern).

Run via run-gold-executive-cac.sh (pure Iceberg read+write; no Kafka / no PG JDBC).
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

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

TABLE_NAME = "gold_executive_metrics"

# Source: the Phase-1 Spark→Iceberg silver_order_state (the dual-run sibling the dbt path also reads).
SILVER_ORDER_STATE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"

# Column contract — byte-for-byte the dbt mart's output projection (verified against the live StarRocks
# DESC brain_gold.gold_executive_metrics). brand_id tenant key first; money = bigint minor + currency.
_COLUMNS = """
          brand_id            string    NOT NULL,
          currency_code       string    NOT NULL,
          total_orders        bigint    NOT NULL,
          realized_value_minor bigint,
          distinct_customers  bigint    NOT NULL,
          terminal_orders     bigint,
          delivered_orders    bigint,
          rto_orders          bigint,
          cancelled_orders    bigint,
          refunded_orders     bigint,
          data_source         string    NOT NULL,
          updated_at          timestamp NOT NULL
""".strip("\n")


def _fold_and_merge(spark: SparkSession, fqtn: str) -> None:
    """Run the per-(brand, currency) executive rollup + MERGE over the CURRENTLY registered
    `silver_order_state` view (one partition-incremental bucket of brands, full history each)."""
    # ── the dbt aggregation, reproduced verbatim (additive components only, per (brand, currency)) ──
    rollup_sql = """
        select
            brand_id,
            currency_code,
            count(order_id)                                                       as total_orders,
            cast(sum(order_value_minor) as bigint)                               as realized_value_minor,
            cast(count(distinct brain_id) as bigint)                            as distinct_customers,
            cast(sum(case when is_terminal then 1 else 0 end) as bigint)         as terminal_orders,
            cast(sum(case when lifecycle_state = 'delivered' then 1 else 0 end) as bigint) as delivered_orders,
            cast(sum(case when lifecycle_state = 'rto'       then 1 else 0 end) as bigint) as rto_orders,
            cast(sum(case when lifecycle_state = 'cancelled' then 1 else 0 end) as bigint) as cancelled_orders,
            cast(sum(case when lifecycle_state = 'refunded'  then 1 else 0 end) as bigint) as refunded_orders,
            cast('live' as string)                                               as data_source,
            current_timestamp()                                                  as updated_at
        from silver_order_state
        where currency_code is not null
        group by brand_id, currency_code
    """
    result = spark.sql(rollup_sql)
    result.createOrReplaceTempView("gold_executive_metrics_new")

    # Idempotent MERGE on the (brand_id, currency_code) PK — replay-safe restatement.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING gold_executive_metrics_new s
        ON t.brand_id = s.brand_id AND t.currency_code = s.currency_code
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def build(spark: SparkSession) -> str:
    """PARTITION-INCREMENTAL (partition = brand_id): recompute only brands whose silver_order_state
    changed since the watermark, each over their full history, hash-bucketed. FULL_REFRESH=1 recomputes
    all. Same UPDATE/INSERT MERGE as the full job → parity. See docs/ops/local-memory-budget.md."""
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS,
        # brand-first tenant partitioning + per-currency bucketing (the mart's distribution key is brand).
        partitioned_by="bucket(4, brand_id)",
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
    print(f"[gold_executive_metrics] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-executive-metrics")
    spark.sparkContext.setLogLevel("WARN")
    build(spark)
    print("[gold_executive_metrics] DONE ✓", flush=True)


if __name__ == "__main__":
    main()
