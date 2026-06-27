"""
silver_marketing_spend.py — Brain V4 Phase 1 (Spark Silver, dual-run): reimplement the dbt
`silver_marketing_spend` mart as a Spark job that READS Iceberg Bronze (brain_bronze.collector_events,
event_type='spend.live.v1') and WRITES Iceberg brain_silver.silver_marketing_spend via an idempotent
MERGE on the model PK. It reproduces the dbt SQL transform EXACTLY — folding the stg_ad_spend_bronze
staging view into one job — and runs BESIDE the live dbt→StarRocks brain_silver.silver_marketing_spend
(it repoints no reader, changes no dbt model or app code; ADDITIVE / non-breaking).

WHAT IT MIRRORS (the two dbt files this folds):
  - db/dbt/models/staging/stg_ad_spend_bronze.sql  — reads bronze_iceberg.collector_events WHERE
    event_type='spend.live.v1'; parse_json(payload) → properties.*; dedup to the LATEST-ingested row
    per (brand_id, spend_event_id) by (ingested_at desc, occurred_at desc); drops null/empty spend_event_id.
  - db/dbt/models/marts/silver_marketing_spend.sql — final projection; cast stat_date→date,
    spend_minor→bigint, coalesce impressions/clicks to 0 → bigint; updated_at = current_timestamp();
    WHERE spend_event_id is not null AND stat_date is not null.

GRAIN = (brand_id, spend_event_id)  — the canonical spend grain (spend_event_id IS the Bronze event_id,
  deterministically seeded by the @brain/ad-spend-mapper, ADR-AD-5, so a trailing re-pull re-emits the
  SAME row with the SAME id → dedup keeps the latest ingested version).
CONNECTOR-AGNOSTIC: the `platform` column (meta | google_ads | …) carries the source, never a connector
  name in the table name.
MONEY = bigint MINOR UNITS (`spend_minor`) paired with `currency_code` (HARD RULE — never a float).
ISOLATION: brand_id is the first key on every row (server-derived in Bronze, MT-1); this job is the
  cross-brand ETL writer (Silver READ seam enforces per-brand, not here).
REPLAY-SAFE: pure deterministic projection + MERGE WHEN MATCHED THEN UPDATE / WHEN NOT MATCHED INSERT,
  keyed on (brand_id, spend_event_id) — re-running over the same Bronze is a no-op on identity and
  refreshes the latest-ingested values.

STAGE-1 GATE (Brain V4 two-stage): this job now runs the Stage-1 DQ gate _silver_technical.dq_check over
  each canonical spend fact BEFORE the MERGE: a row whose spend_minor is negative/non-integer, whose
  currency_code is not ISO-4217 alpha-3, or whose occurred_at is future/unparseable is diverted to
  brain_silver.silver_quarantine (stage='dq', carrying the original Bronze payload) and NEVER written to
  silver_marketing_spend; Bronze keeps the original (replay-safe: fix + re-run re-admits). The grain
  filters (spend_event_id / stat_date NOT NULL) are unchanged dbt-parity grain selection. Good rows are
  byte-identical (parity-faithful).

Run via spark-submit inside the Spark+Iceberg image — see run-silver-marketing-spend.sh. All wiring is
env-overridable; dev defaults target the compose service names (iceberg-rest:8181, minio:9000).
"""
from __future__ import annotations  # Python 3.8 (Spark image): defer `str | None` annotation eval.

import os

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F

from iceberg_base import (
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)
from _silver_technical import dq_violations_udf, write_quarantine

# ── Bronze (source) wiring — the raw analytical SoR this Silver mart builds FROM ──────────────────
BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"  # ADR-0006 P3: gated source (R2/R3 now in Silver)
# The one Bronze event_type that carries spend rows (the @brain/ad-spend bridge / SERVER_TRUSTED_BRONZE).
SPEND_EVENT_TYPE = os.environ.get("SPEND_EVENT_TYPE", "spend.live.v1")

# ── Silver (target) table — same name as the dbt model (the Spark mart mirrors the dbt model name) ─
TABLE_NAME = "silver_marketing_spend"

# Column contract — byte-for-byte the dbt mart's output projection (verified against the live StarRocks
# DESC brain_silver.silver_marketing_spend). brand_id tenant key first; money = bigint minor + currency.
_COLUMNS_SQL = """
          brand_id          string    NOT NULL,
          spend_event_id    string    NOT NULL,
          platform          string,
          level             string,
          level_id          string,
          parent_id         string,
          campaign_id       string,
          campaign_name     string,
          stat_date         date,
          spend_minor       bigint,
          currency_code     string,
          impressions       bigint,
          clicks            bigint,
          account_timezone  string,
          occurred_at       timestamp,
          updated_at        timestamp NOT NULL
""".strip("\n")


def ensure_table(spark: SparkSession) -> str:
    """Create brain_silver.silver_marketing_spend if absent (idempotent), Bronze-parity table props.

    Partition by bucket(256, brand_id) + days(occurred_at) — the medallion convention (brand-first
    tenant partitioning + event-time pruning), mirroring the Phase-0 _provision_check shape. Returns
    the fully-qualified table name for the MERGE.
    """
    return create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS_SQL,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )


def _prop(payload_col, path: str):
    """Extract payload.properties.<path> from the verbatim envelope JSON STRING.

    dbt does get_json_string(parse_json(payload), '$.properties.X'); Spark's get_json_object on the raw
    JSON string is the exact equivalent (both return the JSON scalar as a string, NULL if absent).
    """
    return F.get_json_object(payload_col, f"$.properties.{path}")


def build_marketing_spend(spark: SparkSession) -> DataFrame:
    """Reproduce stg_ad_spend_bronze + silver_marketing_spend.sql EXACTLY, returning the mart rows.

    Folds the staging view (read→type→dedup) into the mart projection (cast/coalesce/filter). The result
    schema matches `_COLUMNS_SQL` (the dbt output) plus a trailing `_payload` carry-through column (the
    verbatim Bronze envelope) used by the Stage-1 quarantine in run(); run() drops `_payload` before the
    MERGE so the canonical table is byte-identical. Money as bigint minor + currency_code.
    """
    payload = F.col("payload")

    # ── stg_ad_spend_bronze: raw → typed projection from Bronze (event_type='spend.live.v1') ─────────
    typed = (
        spark.table(BRONZE_TABLE)
        .where(F.col("event_type") == SPEND_EVENT_TYPE)
        .select(
            F.col("brand_id"),
            # spend_event_id == the Bronze idempotency key (mapper seeds event_id from the spend grain).
            F.col("event_id").alias("spend_event_id"),
            _prop(payload, "platform").alias("platform"),
            _prop(payload, "level").alias("level"),
            _prop(payload, "level_id").alias("level_id"),
            _prop(payload, "parent_id").alias("parent_id"),
            _prop(payload, "campaign_id").alias("campaign_id"),
            _prop(payload, "campaign_name").alias("campaign_name"),
            _prop(payload, "stat_date").alias("stat_date_raw"),
            _prop(payload, "spend_minor").cast("bigint").alias("spend_minor"),
            _prop(payload, "currency_code").alias("currency_code"),
            _prop(payload, "impressions").cast("bigint").alias("impressions"),
            _prop(payload, "clicks").cast("bigint").alias("clicks"),
            _prop(payload, "account_timezone").alias("account_timezone"),
            F.col("occurred_at"),
            F.col("ingested_at"),
            # Thread the verbatim Bronze envelope through so a Stage-1 reject is replayable from quarantine.
            payload.alias("_payload"),
        )
        # Drop malformed events with no spend_event_id (cannot be a canonical spend row).
        .where(F.col("spend_event_id").isNotNull() & (F.col("spend_event_id") != F.lit("")))
    )

    # ── dedup: keep the LATEST ingested version per (brand_id, spend_event_id) ────────────────────────
    # A trailing re-pull re-emits the SAME spend row with the SAME event_id (ADR-AD-5) — keep the
    # latest (ingested_at desc, occurred_at desc as deterministic tiebreak). Mirrors stg_order_events_bronze.
    from pyspark.sql.window import Window

    w = Window.partitionBy("brand_id", "spend_event_id").orderBy(
        F.col("ingested_at").desc(), F.col("occurred_at").desc()
    )
    deduped = (
        typed.withColumn("_dedup_rn", F.row_number().over(w))
        .where(F.col("_dedup_rn") == 1)
        .drop("_dedup_rn")
    )

    # ── silver_marketing_spend.sql: final projection (cast/coalesce/filter) ───────────────────────────
    mart = deduped.select(
        F.col("brand_id"),
        F.col("spend_event_id"),
        F.col("platform"),
        F.col("level"),
        F.col("level_id"),
        F.col("parent_id"),
        F.col("campaign_id"),
        F.col("campaign_name"),
        F.col("stat_date_raw").cast("date").alias("stat_date"),
        F.col("spend_minor").cast("bigint").alias("spend_minor"),
        F.col("currency_code"),
        F.coalesce(F.col("impressions"), F.lit(0)).cast("bigint").alias("impressions"),
        F.coalesce(F.col("clicks"), F.lit(0)).cast("bigint").alias("clicks"),
        F.col("account_timezone"),
        F.col("occurred_at"),
        F.current_timestamp().alias("updated_at"),
        F.col("_payload"),
    ).where(
        # stat_date NOT NULL: it is the dbt expression-partition key. spend_event_id NOT NULL: grain.
        F.col("spend_event_id").isNotNull() & F.col("stat_date").isNotNull()
    )
    return mart


def merge_into_silver(spark: SparkSession, fqtn: str, mart: DataFrame) -> None:
    """Idempotent MERGE on the model PK (brand_id, spend_event_id) — replay-safe.

    WHEN MATCHED THEN UPDATE refreshes the latest-ingested values (a trailing re-pull); WHEN NOT MATCHED
    THEN INSERT appends new spend rows. Re-running over the same Bronze is a no-op on identity.
    """
    mart.createOrReplaceTempView("_silver_marketing_spend_src")
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING _silver_marketing_spend_src s
        ON t.brand_id = s.brand_id AND t.spend_event_id = s.spend_event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def run(spark: SparkSession) -> None:
    fqtn = ensure_table(spark)
    print(f"[silver_marketing_spend] target table ready: {fqtn}", flush=True)

    mart = build_marketing_spend(spark)
    src_n = mart.count()
    print(f"[silver_marketing_spend] built {src_n} mart rows from Bronze {SPEND_EVENT_TYPE}", flush=True)

    # ── Stage-1 DQ gate: spend money (spend_minor + currency) at a real event time. Negative/non-int amount,
    # non-ISO-4217 currency, or future/unparseable occurred_at → silver_quarantine (stage='dq', original
    # Bronze payload), NEVER silver_marketing_spend; Bronze keeps the original (replay-safe). Good rows drop
    # the _payload carry-through so the MERGE target is byte-identical.
    gated = mart.withColumn(
        "_dq",
        dq_violations_udf()(F.col("spend_minor"), F.col("currency_code"), F.col("occurred_at").cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(F.size(F.col("_dq")) > 0).select(
            F.col("brand_id"),
            F.lit(SPEND_EVENT_TYPE).alias("source"),
            F.col("spend_event_id").alias("bronze_event_id"),
            F.lit(TABLE_NAME).alias("canonical_target"),
            F.array_join(F.col("_dq"), ",").alias("reason"),
            F.col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(F.size(F.col("_dq")) == 0).drop("_dq", "_payload")
    bad_n = src_n - good.count()
    if bad_n:
        print(f"[silver_marketing_spend] quarantined {bad_n} spend rows (stage=dq)", flush=True)

    merge_into_silver(spark, fqtn, good)

    total = spark.table(fqtn).count()
    print(f"[silver_marketing_spend] MERGE complete — {fqtn} now has {total} rows", flush=True)
    print("[silver_marketing_spend] DONE ✓", flush=True)


def main() -> None:
    spark = build_spark("silver-marketing-spend")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
