"""
gold_customer_segments.py — Spark reimplementation of the dbt gold_customer_segments mart (Brain V4
Phase 2, GROUP customer). Reproduces db/dbt/models/marts/gold_customer_segments.sql EXACTLY: the
deterministic value-tier customer segments — ONE row per (brand_id, segment) with customer_count +
total realized value per tier. Deterministic CASE bucketing (NOT ML). Reads the silver_customer spine.

ADDITIVE / dual-run: reads Iceberg brain_silver.silver_customer, writes Iceberg brain_gold.
gold_customer_segments BESIDE the live dbt→StarRocks copy. Repoints NO reader.

THE TRANSFORM (verbatim from the dbt model):
  segmented = silver_customer projected with a deterministic value tier:
        segment = case
            when lifetime_value_minor >= 100000 then 'high_value'
            when lifetime_value_minor >= 50000  then 'mid_value'
            when lifetime_value_minor > 0       then 'low_value'
            else 'no_realized_value'
        end
  result    = GROUP BY (brand_id, segment):
        customer_count       = count(*)::bigint
        segment_value_minor  = sum(lifetime_value_minor)::bigint     -- MONEY: bigint minor units
        updated_at           = current_timestamp()

MONEY (I-S07): segment_value_minor is a bigint MINOR-unit Σ of silver_customer.lifetime_value_minor
  (already minor units) — a pure additive sum, no rounding. NOTE the dbt model sums across ALL of a
  brand's customers regardless of currency (it carries no currency_code on the segment grain); the
  Spark job reproduces that EXACTLY (sum over the brand-segment group) so parity is byte-exact. (The
  parity oracle's per-currency Σ collapses to per-brand here because there is no currency_code column.)

PK (brand_id, segment). brand_id is the first column / tenant key.

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

TABLE_NAME = "gold_customer_segments"

_COLUMNS = """
          brand_id            string    NOT NULL,
          segment             string    NOT NULL,
          customer_count      bigint,
          segment_value_minor bigint,
          updated_at          timestamp
""".strip("\n")


def _read_silver_customer(spark: SparkSession):
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(f"[gold_customer_segments] REQUIRED Iceberg {fqtn} absent — build silver_customer first.")
        raise


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(4, brand_id)"
    )

    customers = _read_silver_customer(spark)

    # Deterministic value tier — verbatim dbt CASE ladder.
    segment = (
        F.when(F.col("lifetime_value_minor") >= 100000, F.lit("high_value"))
        .when(F.col("lifetime_value_minor") >= 50000, F.lit("mid_value"))
        .when(F.col("lifetime_value_minor") > 0, F.lit("low_value"))
        .otherwise(F.lit("no_realized_value"))
    )

    result = (
        customers.select(
            F.col("brand_id"),
            F.col("lifetime_value_minor"),
            segment.alias("segment"),
        )
        .groupBy("brand_id", "segment")
        .agg(
            F.count(F.lit(1)).cast("bigint").alias("customer_count"),
            F.sum("lifetime_value_minor").cast("bigint").alias("segment_value_minor"),
        )
        .withColumn("updated_at", F.current_timestamp())
    )

    n = result.count()
    result.createOrReplaceTempView("seg_src")

    # Full-rebuild MERGE on (brand_id, segment): UPDATE the aggregate when it restates, INSERT new tiers.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING seg_src s
        ON t.brand_id = s.brand_id AND t.segment = s.segment
        WHEN MATCHED THEN UPDATE SET
          t.customer_count      = s.customer_count,
          t.segment_value_minor = s.segment_value_minor,
          t.updated_at          = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, segment, customer_count, segment_value_minor, updated_at
        ) VALUES (
          s.brand_id, s.segment, s.customer_count, s.segment_value_minor, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_customer_segments] MERGEd {n} segment rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-customer-segments")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_customer_segments] DONE — Iceberg value-tier segments populated ✓", flush=True)


if __name__ == "__main__":
    main()
