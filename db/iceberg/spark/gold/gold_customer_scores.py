"""
gold_customer_scores.py — Spark reimplementation of the dbt gold_customer_scores mart (Brain V4 Phase
2, GROUP customer). Reproduces db/dbt/models/marts/gold_customer_scores.sql EXACTLY: the deterministic
(NOT ML) RFM + churn-risk customer scoring — ONE row per (brand_id, brain_id) with transparent,
rule-based recency/frequency/monetary tiers + a churn-risk band.

ADDITIVE / dual-run: reads Iceberg brain_silver, writes Iceberg brain_gold.gold_customer_scores BESIDE
the live dbt→StarRocks copy. Repoints NO reader, changes NO dbt, touches NO app code.

THE TRANSFORM (Brain V4 — features are RUNTIME, not a precompute table):
  In V4 there is NO permanent feature-precompute table. The retired dbt graph used to read the LATEST
  per-customer snapshot from feature_customer_daily (the StarRocks brain_feature DB), which was itself a
  daily point-in-time snapshot DERIVED from silver_customer. dbt is GONE and brain_feature is retired
  (db/starrocks/teardown/drop_dead_feature_db.sql), so this job FOLDS that feature snapshot INLINE from
  the Iceberg silver_customer spine at runtime (identical formulae), then applies the scoring:
        snapshot_date         = current_date()
        days_since_last_order = datediff(current_date(), cast(last_seen_at as date))
        (+ lifetime_orders / lifetime_value_minor / currency_code carried from silver_customer)
        scored_on             = snapshot_date  (= current_date())
        recency_score   ∈ 1..5 by days_since_last_order  (≤30→5, ≤60→4, ≤90→3, ≤180→2, else 1)
        frequency_score ∈ 1..5 by lifetime_orders        (≥10→5, ≥5→4, ≥3→3, ≥2→2, else 1)
        monetary_score  ∈ 1..5 by lifetime_value_minor   (≥1e7→5, ≥5e6→4, ≥1e6→3, ≥2e5→2, else 1)
        churn_risk      ∈ {high (>180d), medium (>90d), low}
        data_source     = 'live'        (MK-1: real builds = live; the demo seed overwrites 'synthetic')
        computed_at     = current_timestamp()

  WHY runtime-fold-from-silver: on a single-snapshot-per-day grain, "today's latest feature snapshot per
  customer" IS today's silver_customer projection — so building it from silver_customer at run time is
  point-in-time-correct (money columns carried verbatim; no re-derivation → no rounding). This is the V4
  rule: features are computed at runtime from the Silver spine, never read from a permanent precompute DB.

GRAIN: ONE row per (brand_id, brain_id). No money column on this mart (it carries lifetime_value_minor
  as a descriptive bigint minor field, but the parity oracle treats this mart as row-identity only —
  registry money_columns=[]). brand_id is the first column / tenant key.

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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # gold/ — for _gold_base
from _gold_base import gold_partition_filter  # noqa: E402

TABLE_NAME = "gold_customer_scores"

# Brain V4: features are RUNTIME. The "latest customer snapshot" is folded inline from the Iceberg
# silver_customer spine (see module docstring). The retired dbt-era alternative — reading the StarRocks
# brain_feature.feature_customer_daily precompute table over JDBC — is GONE (brain_feature is dead;
# db/starrocks/teardown/drop_dead_feature_db.sql). There is exactly one feature source now: silver.

_COLUMNS = """
          brand_id              string    NOT NULL,
          brain_id              string    NOT NULL,
          currency_code         string,
          scored_on             date,
          lifetime_orders       bigint,
          lifetime_value_minor  bigint,
          days_since_last_order int,
          recency_score         int,
          frequency_score       int,
          monetary_score        int,
          churn_risk            string,
          data_source           string    NOT NULL,
          computed_at           timestamp
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
            raise SystemExit(f"[gold_customer_scores] REQUIRED Iceberg {fqtn} absent — build silver_customer first.")
        raise


def _latest_feature_from_silver(spark: SparkSession):
    """Fold feature_customer_daily's snapshot INLINE from Iceberg silver_customer (identical formulae).

    Reproduces feature_customer_daily.sql: snapshot_date = current_date(); days_since_last_order =
    datediff(current_date(), last_seen_at::date). One row per (brand_id, brain_id) → already the
    'latest snapshot per customer'.
    """
    sc = _read_silver_customer(spark)
    return sc.select(
        F.col("brand_id"),
        F.col("brain_id"),
        F.col("currency_code"),
        F.current_date().alias("snapshot_date"),
        F.col("lifetime_orders"),
        F.col("lifetime_value_minor"),
        F.datediff(F.current_date(), F.col("last_seen_at").cast("date")).alias("days_since_last_order"),
    )


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id)"
    )

    # V4: the sole feature source is the runtime fold from the Iceberg silver_customer spine.
    print("[gold_customer_scores] feature source = Iceberg silver_customer (runtime feature fold)", flush=True)
    latest = _latest_feature_from_silver(spark)
    latest, _commit_wm = gold_partition_filter(
        spark, latest, table_name=TABLE_NAME, source_tables=["silver_customer"],
    )

    d = F.col("days_since_last_order")
    lo = F.col("lifetime_orders")
    lv = F.col("lifetime_value_minor")

    recency = (
        F.when(d <= 30, 5).when(d <= 60, 4).when(d <= 90, 3).when(d <= 180, 2).otherwise(1)
    )
    frequency = (
        F.when(lo >= 10, 5).when(lo >= 5, 4).when(lo >= 3, 3).when(lo >= 2, 2).otherwise(1)
    )
    monetary = (
        F.when(lv >= 10000000, 5)
        .when(lv >= 5000000, 4)
        .when(lv >= 1000000, 3)
        .when(lv >= 200000, 2)
        .otherwise(1)
    )
    churn = (
        F.when(d > 180, F.lit("high")).when(d > 90, F.lit("medium")).otherwise(F.lit("low"))
    )

    result = latest.select(
        F.col("brand_id"),
        F.col("brain_id"),
        F.col("currency_code"),
        F.col("snapshot_date").alias("scored_on"),
        F.col("lifetime_orders"),
        F.col("lifetime_value_minor"),
        d.alias("days_since_last_order"),
        recency.cast("int").alias("recency_score"),
        frequency.cast("int").alias("frequency_score"),
        monetary.cast("int").alias("monetary_score"),
        churn.alias("churn_risk"),
        F.lit("live").alias("data_source"),
        F.current_timestamp().alias("computed_at"),
    )

    n = result.count()
    result.createOrReplaceTempView("scores_src")

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING scores_src s
        ON t.brand_id = s.brand_id AND t.brain_id = s.brain_id
        WHEN MATCHED THEN UPDATE SET
          t.currency_code         = s.currency_code,
          t.scored_on             = s.scored_on,
          t.lifetime_orders       = s.lifetime_orders,
          t.lifetime_value_minor  = s.lifetime_value_minor,
          t.days_since_last_order = s.days_since_last_order,
          t.recency_score         = s.recency_score,
          t.frequency_score       = s.frequency_score,
          t.monetary_score        = s.monetary_score,
          t.churn_risk            = s.churn_risk,
          t.data_source           = s.data_source,
          t.computed_at           = s.computed_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, brain_id, currency_code, scored_on, lifetime_orders, lifetime_value_minor,
          days_since_last_order, recency_score, frequency_score, monetary_score, churn_risk,
          data_source, computed_at
        ) VALUES (
          s.brand_id, s.brain_id, s.currency_code, s.scored_on, s.lifetime_orders, s.lifetime_value_minor,
          s.days_since_last_order, s.recency_score, s.frequency_score, s.monetary_score, s.churn_risk,
          s.data_source, s.computed_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_customer_scores] MERGEd {n} score rows → {fqtn} (table now {total} rows)", flush=True)
    _commit_wm()  # advance watermark after the MERGE succeeded
    return fqtn


def main() -> None:
    spark = build_spark("gold-customer-scores")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_customer_scores] DONE — Iceberg RFM/churn scores populated ✓", flush=True)


if __name__ == "__main__":
    main()
