"""
silver_marketing_spend_breakdowns.py — Brain V4 FIREHOSE (Spark Silver): the Meta breakdown spend marts.

Reads the SAME gated source as silver_marketing_spend (brain_silver.silver_collector_event,
event_type='spend.live.v1') but keeps the BREAKDOWN rows (breakdown_key <> '') that the base mart
DROPS. Each breakdown family lands in its OWN parallel mart with the breakdown dimensions in the PK, so
the base (brand_id, spend_event_id) one-row-per-campaign-day grain that CAC/ROAS assume is NEVER exploded.

WHY parallel marts (not widening silver_marketing_spend): breakdown passes emit DISTINCT event_ids
(uuidV5FromSpendRow folds breakdown_key), so they are extra rows at the same (brand,platform,statDate,
level,levelId). Landing them in the base mart would multiply campaign-day rows and break dedup-correct
CAC/ROAS. Isolated breakdown marts keep every surface independent + additive.

GRAINS (PK):
  - silver_marketing_spend_by_demographic  : (brand_id, spend_event_id) + age, gender
  - silver_marketing_spend_by_geo          : + country, region, dma
  - silver_marketing_spend_by_placement    : + publisher_platform, platform_position, device_platform, impression_device
  - silver_marketing_spend_by_hour         : + hour_bucket

Because the breakdown dims are already folded into the DISTINCT spend_event_id, (brand_id, spend_event_id)
IS a sufficient PK; the dim columns are projected for slicing. MERGE keyed on (brand_id, spend_event_id).

MONEY = bigint MINOR units + currency_code (never blended/float). ISOLATION: brand_id first key (server-
trusted in Bronze, MT-1). REPLAY-SAFE: deterministic projection + idempotent MERGE.
"""
from __future__ import annotations

import os

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"
SPEND_EVENT_TYPE = os.environ.get("SPEND_EVENT_TYPE", "spend.live.v1")

# Common leading columns shared by every breakdown mart (identity + core spend measures).
_COMMON_COLS_SQL = """
          brand_id          string    NOT NULL,
          spend_event_id    string    NOT NULL,
          platform          string,
          level             string,
          level_id          string,
          campaign_id       string,
          campaign_name     string,
          stat_date         date,
          breakdown_key     string,
          spend_minor       bigint,
          currency_code     string,
          impressions       bigint,
          clicks            bigint,
          conversions       bigint,
          conv_value_minor  bigint,
          occurred_at       timestamp,
          updated_at        timestamp NOT NULL
"""

# Per-family breakdown-dimension columns (appended to the common set).
_FAMILIES = {
    "silver_marketing_spend_by_demographic": {
        "dims": ["age", "gender"],
        "cols_sql": "          age string,\n          gender string,",
    },
    "silver_marketing_spend_by_geo": {
        "dims": ["country", "region", "dma"],
        "cols_sql": "          country string,\n          region string,\n          dma string,",
    },
    "silver_marketing_spend_by_placement": {
        "dims": ["publisher_platform", "platform_position", "device_platform", "impression_device"],
        "cols_sql": (
            "          publisher_platform string,\n          platform_position string,\n"
            "          device_platform string,\n          impression_device string,"
        ),
    },
    "silver_marketing_spend_by_hour": {
        "dims": ["hourly_stats_aggregated_by_advertiser_time_zone"],
        "cols_sql": "          hour_bucket string,",
    },
}


def _prop(payload_col, path: str):
    return F.get_json_object(payload_col, f"$.properties.{path}")


def _base_typed(spark: SparkSession) -> DataFrame:
    """Read spend.live.v1, keep BREAKDOWN rows only (breakdown_key present + non-empty), dedup latest."""
    from pyspark.sql.window import Window

    payload = F.col("payload")
    typed = (
        spark.table(BRONZE_TABLE)
        .where(F.col("event_type") == SPEND_EVENT_TYPE)
        .select(
            F.col("brand_id"),
            F.col("event_id").alias("spend_event_id"),
            _prop(payload, "platform").alias("platform"),
            _prop(payload, "level").alias("level"),
            _prop(payload, "level_id").alias("level_id"),
            _prop(payload, "campaign_id").alias("campaign_id"),
            _prop(payload, "campaign_name").alias("campaign_name"),
            _prop(payload, "stat_date").alias("stat_date_raw"),
            _prop(payload, "breakdown_key").alias("breakdown_key"),
            _prop(payload, "spend_minor").cast("bigint").alias("spend_minor"),
            _prop(payload, "currency_code").alias("currency_code"),
            _prop(payload, "impressions").cast("bigint").alias("impressions"),
            _prop(payload, "clicks").cast("bigint").alias("clicks"),
            _prop(payload, "conversions").cast("bigint").alias("conversions"),
            _prop(payload, "conv_value_minor").cast("bigint").alias("conv_value_minor"),
            # Breakdown dim projections (null unless the row carried them).
            _prop(payload, "age").alias("age"),
            _prop(payload, "gender").alias("gender"),
            _prop(payload, "country").alias("country"),
            _prop(payload, "region").alias("region"),
            _prop(payload, "dma").alias("dma"),
            _prop(payload, "publisher_platform").alias("publisher_platform"),
            _prop(payload, "platform_position").alias("platform_position"),
            _prop(payload, "device_platform").alias("device_platform"),
            _prop(payload, "impression_device").alias("impression_device"),
            _prop(payload, "hourly_stats_aggregated_by_advertiser_time_zone").alias("hour_bucket"),
            F.col("occurred_at"),
            F.col("ingested_at"),
        )
        .where(F.col("spend_event_id").isNotNull() & (F.col("spend_event_id") != F.lit("")))
        # BREAKDOWN rows only — base rows (breakdown_key null/'') belong to silver_marketing_spend.
        .where(F.col("breakdown_key").isNotNull() & (F.col("breakdown_key") != F.lit("")))
    )
    w = Window.partitionBy("brand_id", "spend_event_id").orderBy(
        F.col("ingested_at").desc(), F.col("occurred_at").desc()
    )
    return (
        typed.withColumn("_rn", F.row_number().over(w)).where(F.col("_rn") == 1).drop("_rn")
    )


def _project_family(typed: DataFrame, family: str) -> DataFrame:
    """Project the common columns + this family's breakdown dims; keep only rows that carry ≥1 of the
    family's dims (so a placement row does not appear in the demographic mart)."""
    dims = _FAMILIES[family]["dims"]
    select_cols = [
        F.col("brand_id"),
        F.col("spend_event_id"),
        F.col("platform"),
        F.col("level"),
        F.col("level_id"),
        F.col("campaign_id"),
        F.col("campaign_name"),
        F.col("stat_date_raw").cast("date").alias("stat_date"),
        F.col("breakdown_key"),
        F.col("spend_minor").cast("bigint").alias("spend_minor"),
        F.col("currency_code"),
        F.coalesce(F.col("impressions"), F.lit(0)).cast("bigint").alias("impressions"),
        F.coalesce(F.col("clicks"), F.lit(0)).cast("bigint").alias("clicks"),
        F.col("conversions").cast("bigint").alias("conversions"),
        F.col("conv_value_minor").cast("bigint").alias("conv_value_minor"),
        F.col("occurred_at"),
        F.current_timestamp().alias("updated_at"),
    ]
    # Append the family dim columns (hour uses the aliased hour_bucket source column).
    present = None
    for d in dims:
        src = "hour_bucket" if d == "hourly_stats_aggregated_by_advertiser_time_zone" else d
        out = "hour_bucket" if d == "hourly_stats_aggregated_by_advertiser_time_zone" else d
        select_cols.append(F.col(src).alias(out))
        cond = F.col(src).isNotNull()
        present = cond if present is None else (present | cond)
    return (
        typed.select(*select_cols)
        .where(present if present is not None else F.lit(True))
        .where(F.col("stat_date").isNotNull())
    )


def _merge(spark: SparkSession, fqtn: str, mart: DataFrame) -> None:
    mart.createOrReplaceTempView("_bd_src")
    spark.sql(
        f"""
        MERGE INTO {fqtn} t USING _bd_src s
        ON t.brand_id = s.brand_id AND t.spend_event_id = s.spend_event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def run(spark: SparkSession) -> None:
    typed = _base_typed(spark).cache()
    for family, spec in _FAMILIES.items():
        columns_sql = (_COMMON_COLS_SQL.rstrip() + "\n" + spec["cols_sql"]).rstrip(",\n") + "\n"
        fqtn = create_iceberg_table(
            spark,
            SILVER_NAMESPACE,
            family,
            columns_sql,
            partitioned_by="bucket(256, brand_id), days(occurred_at)",
        )
        mart = _project_family(typed, family)
        _merge(spark, fqtn, mart)
        print(f"[silver-marketing-spend-breakdowns] {fqtn} → {spark.table(fqtn).count()} rows", flush=True)
    print("[silver-marketing-spend-breakdowns] DONE ✓", flush=True)


def main() -> None:
    spark = build_spark("silver-marketing-spend-breakdowns")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
