"""
gold_cohorts.py — Spark reimplementation of the dbt gold_cohorts mart (Brain V4 Phase 2, GROUP
customer). Reproduces db/dbt/models/marts/gold_cohorts.sql EXACTLY: acquisition cohorts — one row per
(brand_id, cohort_month) with the customers first seen in that month + their lifetime value/orders.
Reads the silver_customer spine.

ADDITIVE / dual-run: reads Iceberg brain_silver.silver_customer, writes Iceberg brain_gold.gold_cohorts
BESIDE the live dbt→StarRocks copy. Repoints NO reader.

THE TRANSFORM (verbatim from the dbt model):
  from silver_customer where first_seen_at is not null, GROUP BY (brand_id, date_format(first_seen_at,'%Y-%m')):
        cohort_month       = date_format(first_seen_at, '%Y-%m')        -- 'YYYY-MM' string
        currency_code      = max(currency_code)
        cohort_size        = count(*)::bigint
        cohort_value_minor = sum(lifetime_value_minor)::bigint          -- MONEY: bigint minor units
        cohort_orders      = sum(lifetime_orders)::bigint
        updated_at         = current_timestamp()

GRAIN NOTE: the dbt model GROUPs by (brand_id, cohort_month) only — currency_code is an AGGREGATE
  (max) inside the group, NOT a grouping key (even though the StarRocks PK lists it). The Spark job
  reproduces that grouping EXACTLY (group by brand_id + cohort_month; currency_code = max) so the row
  identity and money Σ are byte-for-byte the dbt result. The 'YYYY-MM' cohort_month is built with
  Spark date_format(first_seen_at,'yyyy-MM') — the same calendar bucketing as MySQL/StarRocks '%Y-%m'.

MONEY (I-S07): cohort_value_minor is a bigint MINOR-unit additive Σ of silver_customer.
  lifetime_value_minor — a pure sum, no rounding. brand_id is the first column / tenant key.

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

TABLE_NAME = "gold_cohorts"

_COLUMNS = """
          brand_id           string    NOT NULL,
          cohort_month       string    NOT NULL,
          currency_code      string,
          cohort_size        bigint,
          cohort_value_minor bigint,
          cohort_orders      bigint,
          updated_at         timestamp
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
            raise SystemExit(f"[gold_cohorts] REQUIRED Iceberg {fqtn} absent — build silver_customer first.")
        raise


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(4, brand_id)"
    )

    customers = _read_silver_customer(spark).where(F.col("first_seen_at").isNotNull())

    result = (
        customers.withColumn("cohort_month", F.date_format(F.col("first_seen_at"), "yyyy-MM"))
        .groupBy("brand_id", "cohort_month")
        .agg(
            F.max("currency_code").alias("currency_code"),
            F.count(F.lit(1)).cast("bigint").alias("cohort_size"),
            F.sum("lifetime_value_minor").cast("bigint").alias("cohort_value_minor"),
            F.sum("lifetime_orders").cast("bigint").alias("cohort_orders"),
        )
        .withColumn("updated_at", F.current_timestamp())
    )

    n = result.count()
    result.createOrReplaceTempView("cohort_src")

    # Full-rebuild MERGE on (brand_id, cohort_month): UPDATE on restatement, INSERT new cohorts.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING cohort_src s
        ON t.brand_id = s.brand_id AND t.cohort_month = s.cohort_month
        WHEN MATCHED THEN UPDATE SET
          t.currency_code      = s.currency_code,
          t.cohort_size        = s.cohort_size,
          t.cohort_value_minor = s.cohort_value_minor,
          t.cohort_orders      = s.cohort_orders,
          t.updated_at         = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, cohort_month, currency_code, cohort_size, cohort_value_minor, cohort_orders, updated_at
        ) VALUES (
          s.brand_id, s.cohort_month, s.currency_code, s.cohort_size, s.cohort_value_minor, s.cohort_orders, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_cohorts] MERGEd {n} cohort rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-cohorts")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_cohorts] DONE — Iceberg acquisition cohorts populated ✓", flush=True)


if __name__ == "__main__":
    main()
