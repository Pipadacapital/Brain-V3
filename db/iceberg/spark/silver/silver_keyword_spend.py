"""
silver_keyword_spend.py — Google Ads FIREHOSE keyword-grain spend mart (Brain V4 Spark Silver).

A NEW, ISOLATED breakdown mart (spec §5) — it NEVER widens the base (brand_id, spend_event_id) spend
grain (which the CAC/ROAS marts assume is one row per campaign-day). Instead it reads the SAME gated
Bronze lane (silver_collector_event WHERE event_type='spend.live.v1') but keeps ONLY the keyword-view
breakdown rows (payload.properties.keyword_id IS NOT NULL) and keys on the breakdown grain
(brand_id, platform, campaign_id, keyword_id, stat_date). The distinct breakdownKey-derived event_id
(spend_event_id) keeps these rows separate from the base pass and every other breakdown — so nothing
downstream that assumes the base grain reads this table.

MONEY: bigint MINOR units (spend_minor) + sibling currency_code (never blended / float).
ISOLATION: brand_id first; server-derived in Bronze (MT-1).
REPLAY-SAFE: pure projection + MERGE on (brand_id, spend_event_id).
"""
from __future__ import annotations

import os

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table

BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"
SPEND_EVENT_TYPE = os.environ.get("SPEND_EVENT_TYPE", "spend.live.v1")
TABLE_NAME = "silver_keyword_spend"

_COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          spend_event_id    string    NOT NULL,
          platform          string,
          campaign_id       string,
          campaign_name     string,
          keyword_id        string,
          keyword_text      string,
          keyword_match_type string,
          stat_date         date,
          spend_minor       bigint,
          currency_code     string,
          impressions       bigint,
          clicks            bigint,
          conversions       bigint,
          conv_value_minor  bigint,
          ctr               double,
          occurred_at       timestamp,
          updated_at        timestamp NOT NULL
""".strip("\n")


def _prop(payload_col, path: str):
    return F.get_json_object(payload_col, f"$.properties.{path}")


def build(spark: SparkSession) -> DataFrame:
    payload = F.col("payload")
    typed = (
        spark.table(BRONZE_TABLE)
        .where(F.col("event_type") == SPEND_EVENT_TYPE)
        .select(
            F.col("brand_id"),
            F.col("event_id").alias("spend_event_id"),
            _prop(payload, "platform").alias("platform"),
            _prop(payload, "campaign_id").alias("campaign_id"),
            _prop(payload, "campaign_name").alias("campaign_name"),
            _prop(payload, "keyword_id").alias("keyword_id"),
            _prop(payload, "keyword_text").alias("keyword_text"),
            _prop(payload, "keyword_match_type").alias("keyword_match_type"),
            _prop(payload, "stat_date").cast("date").alias("stat_date"),
            _prop(payload, "spend_minor").cast("bigint").alias("spend_minor"),
            _prop(payload, "currency_code").alias("currency_code"),
            _prop(payload, "impressions").cast("bigint").alias("impressions"),
            _prop(payload, "clicks").cast("bigint").alias("clicks"),
            _prop(payload, "conversions").cast("bigint").alias("conversions"),
            _prop(payload, "conv_value_minor").cast("bigint").alias("conv_value_minor"),
            _prop(payload, "ctr").cast("double").alias("ctr"),
            F.col("occurred_at"),
            F.col("ingested_at"),
        )
        # ISOLATION: keyword breakdown rows ONLY (keyword_id present) — base/other grains never enter.
        .where(_prop(payload, "keyword_id").isNotNull() & (_prop(payload, "keyword_id") != F.lit("")))
        .where(F.col("spend_event_id").isNotNull() & F.col("stat_date").isNotNull())
    )

    from pyspark.sql.window import Window

    w = Window.partitionBy("brand_id", "spend_event_id").orderBy(
        F.col("ingested_at").desc(), F.col("occurred_at").desc()
    )
    deduped = (
        typed.withColumn("_rn", F.row_number().over(w)).where(F.col("_rn") == 1).drop("_rn", "ingested_at")
    )
    return deduped.withColumn("updated_at", F.current_timestamp())


def run(spark: SparkSession) -> None:
    fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, TABLE_NAME, _COLUMNS_SQL,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )
    mart = build(spark)
    mart.createOrReplaceTempView("_silver_keyword_spend_src")
    spark.sql(
        f"""
        MERGE INTO {fqtn} t USING _silver_keyword_spend_src s
        ON t.brand_id = s.brand_id AND t.spend_event_id = s.spend_event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    total = spark.table(fqtn).count()
    print(f"[silver_keyword_spend] MERGE complete — {fqtn} now has {total} rows", flush=True)


def main() -> None:
    spark = build_spark("silver-keyword-spend")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
