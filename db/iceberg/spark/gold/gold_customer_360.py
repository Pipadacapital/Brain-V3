"""
gold_customer_360.py — Spark reimplementation of the dbt gold_customer_360 mart (Brain V4 Phase 2,
GROUP customer). Reproduces db/dbt/models/marts/gold_customer_360.sql EXACTLY: the flagship
denormalized Customer-360 serving mart — ONE row per (brand_id, brain_id) with lifetime value +
order counts (carried straight from the silver_customer spine) + a lifecycle breakdown
(delivered / rto / cancelled / refunded) rolled up from silver_order_state.

This is ADDITIVE / dual-run: it reads Iceberg brain_silver and writes Iceberg brain_gold BESIDE the
live dbt→StarRocks gold_customer_360. It repoints NO reader, changes NO dbt, touches NO app code.

THE TRANSFORM (folded from the dbt model — the FULL-build branch; the incremental dirty-key fold is a
perf optimization that yields the identical end-state, so the Spark dual-run does the full roll-up):
  customers  = silver_customer (the customer spine — all columns)
  lifecycle  = from silver_order_state where brain_id is not null, GROUP BY (brand_id, brain_id):
        delivered_orders = sum(case when lifecycle_state = 'delivered' then 1 else 0 end)::bigint
        rto_orders       = sum(case when lifecycle_state = 'rto'       then 1 else 0 end)::bigint
        cancelled_orders = sum(case when lifecycle_state = 'cancelled' then 1 else 0 end)::bigint
        refunded_orders  = sum(case when lifecycle_state = 'refunded'  then 1 else 0 end)::bigint
  result     = customers LEFT JOIN lifecycle on (brand_id, brain_id), projecting the spine columns +
        coalesce(<lifecycle count>, 0). updated_at = current_timestamp().

MONEY (I-S07): lifetime_value_minor is bigint MINOR units paired with currency_code — carried verbatim
  from silver_customer (no re-derivation here → no rounding, the 360 mart is a denormalized JOIN, not a
  money computation). brand_id is the first column / tenant key.

SOURCES (the dbt ref() graph onto the Spark→Iceberg dual-run):
  - silver_customer      : Iceberg brain_silver.silver_customer (the Phase-1 spine). REQUIRED.
  - silver_order_state   : Iceberg brain_silver.silver_order_state (the order spine). Absent → lifecycle
                           counts all 0 (the LEFT-JOIN-on-missing → coalesce(...,0) behavior).

PARITY: current side = StarRocks brain_gold.gold_customer_360 (dbt). PK (brand_id, brain_id); money
  column lifetime_value_minor (per-(brand,currency) exact Σ). The lifecycle CASE buckets ('delivered'/
  'rto') are byte-for-byte the dbt CASE — the same silver_order_state lifecycle_state vocabulary.

Run via spark-submit inside the Spark+Iceberg image — see ../run-gold-customer.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402

TABLE_NAME = "gold_customer_360"

# Column contract — the dbt gold_customer_360 select list (denormalized 360). brand_id first (tenant key).
_COLUMNS = """
          brand_id             string    NOT NULL,
          brain_id             string    NOT NULL,
          lifetime_orders      bigint,
          lifetime_value_minor bigint,
          currency_code        string,
          first_seen_at        timestamp,
          first_identified_at  timestamp,
          last_seen_at         timestamp,
          delivered_orders     bigint,
          rto_orders           bigint,
          cancelled_orders     bigint,
          refunded_orders      bigint,
          customer_watermark   timestamp,
          updated_at           timestamp
""".strip("\n")


def _read_silver(spark: SparkSession, table: str, optional: bool = False):
    """Read an Iceberg brain_silver.<table>. If optional and absent, return None (caller handles it)."""
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.{table}"
    try:
        df = spark.table(fqtn)
        df.schema  # force metadata resolution so an absent table raises here
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001 — REST catalog raises generic Py4J
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            if optional:
                return None
            raise SystemExit(
                f"[gold_customer_360] REQUIRED Iceberg table {fqtn} is absent — build the Phase-1 "
                f"silver_customer Spark mart first."
            )
        raise


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        GOLD_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(8, brand_id)",
    )

    customers = _read_silver(spark, "silver_customer")

    # lifecycle — per-customer rollup of silver_order_state lifecycle_state (dbt CASE buckets, verbatim).
    osd = _read_silver(spark, "silver_order_state", optional=True)
    if osd is None:
        print("[gold_customer_360] silver_order_state absent → lifecycle counts default to 0 (LEFT JOIN)", flush=True)
        lifecycle = spark.createDataFrame(
            [],
            "brand_id string, brain_id string, delivered_orders bigint, rto_orders bigint, "
            "cancelled_orders bigint, refunded_orders bigint",
        )
    else:
        lifecycle = (
            osd.where(F.col("brain_id").isNotNull())
            .groupBy("brand_id", "brain_id")
            .agg(
                F.sum(F.when(F.col("lifecycle_state") == "delivered", 1).otherwise(0)).cast("bigint").alias("delivered_orders"),
                F.sum(F.when(F.col("lifecycle_state") == "rto", 1).otherwise(0)).cast("bigint").alias("rto_orders"),
                F.sum(F.when(F.col("lifecycle_state") == "cancelled", 1).otherwise(0)).cast("bigint").alias("cancelled_orders"),
                F.sum(F.when(F.col("lifecycle_state") == "refunded", 1).otherwise(0)).cast("bigint").alias("refunded_orders"),
            )
        )

    result = (
        customers.alias("c")
        .join(
            lifecycle.alias("l"),
            (F.col("c.brand_id") == F.col("l.brand_id")) & (F.col("c.brain_id") == F.col("l.brain_id")),
            "left",
        )
        .select(
            F.col("c.brand_id").alias("brand_id"),
            F.col("c.brain_id").alias("brain_id"),
            F.col("c.lifetime_orders").alias("lifetime_orders"),
            F.col("c.lifetime_value_minor").alias("lifetime_value_minor"),
            F.col("c.currency_code").alias("currency_code"),
            F.col("c.first_seen_at").alias("first_seen_at"),
            F.col("c.first_identified_at").alias("first_identified_at"),
            F.col("c.last_seen_at").alias("last_seen_at"),
            F.coalesce(F.col("l.delivered_orders"), F.lit(0).cast("bigint")).alias("delivered_orders"),
            F.coalesce(F.col("l.rto_orders"), F.lit(0).cast("bigint")).alias("rto_orders"),
            F.coalesce(F.col("l.cancelled_orders"), F.lit(0).cast("bigint")).alias("cancelled_orders"),
            F.coalesce(F.col("l.refunded_orders"), F.lit(0).cast("bigint")).alias("refunded_orders"),
            F.col("c.customer_watermark").alias("customer_watermark"),
            F.current_timestamp().alias("updated_at"),
        )
    )

    n = result.count()
    result.createOrReplaceTempView("c360_src")

    # Idempotent MERGE on the PK. WHEN MATCHED UPDATE (a customer's 360 RESTATES when a new order lands —
    # the dbt incremental upsert semantic); WHEN NOT MATCHED INSERT for a new customer.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING c360_src s
        ON t.brand_id = s.brand_id AND t.brain_id = s.brain_id
        WHEN MATCHED THEN UPDATE SET
          t.lifetime_orders      = s.lifetime_orders,
          t.lifetime_value_minor = s.lifetime_value_minor,
          t.currency_code        = s.currency_code,
          t.first_seen_at        = s.first_seen_at,
          t.first_identified_at  = s.first_identified_at,
          t.last_seen_at         = s.last_seen_at,
          t.delivered_orders     = s.delivered_orders,
          t.rto_orders           = s.rto_orders,
          t.cancelled_orders     = s.cancelled_orders,
          t.refunded_orders      = s.refunded_orders,
          t.customer_watermark   = s.customer_watermark,
          t.updated_at           = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, brain_id, lifetime_orders, lifetime_value_minor, currency_code,
          first_seen_at, first_identified_at, last_seen_at,
          delivered_orders, rto_orders, cancelled_orders, refunded_orders,
          customer_watermark, updated_at
        ) VALUES (
          s.brand_id, s.brain_id, s.lifetime_orders, s.lifetime_value_minor, s.currency_code,
          s.first_seen_at, s.first_identified_at, s.last_seen_at,
          s.delivered_orders, s.rto_orders, s.cancelled_orders, s.refunded_orders,
          s.customer_watermark, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_customer_360] MERGEd {n} customer-360 rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-customer-360")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_customer_360] DONE — Iceberg Customer-360 serving mart populated ✓", flush=True)


if __name__ == "__main__":
    main()
