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

B2 ENRICHMENT (Brain V4 — the F1 Customer360 contract fields, folded onto each row, ADDITIVE; every
existing column above is byte-identical). All new columns are nullable (a customer with no journey /
no order line / no health row simply gets NULL — honest-empty, never a fabricated value):
  - aov_minor          = lifetime_value_minor `div` lifetime_orders — EXACT integer minor-unit division
                         (Spark `div`/IntegralDivide; nullsafe when orders<=0), per the SAME currency_code
                         as lifetime_value_minor (never blended, never a float). See _customer_360_enrich.
  - preferred_channel  = deterministic MODE of silver_touchpoint.channel per resolved customer
                         (stitched_brain_id); tie-break value ASC.
  - preferred_device   = deterministic MODE of silver_page_view.device_class, mapped to the resolved
                         customer via the touchpoint (brand_id, brain_anon_id → stitched_brain_id) bridge
                         (silver_touchpoint carries no device column; page_view is the device grain).
  - top_category       = deterministic MODE of silver_order_line.title per customer (joined via
                         silver_order_state order_id→brain_id). title is the product-descriptive Silver
                         field standing in for category until a dedicated category dimension lands.
  - acquisition_source = FIRST-touch channel: the silver_touchpoint.channel of the earliest touch
                         (is_first_touch desc, occurred_at asc, channel asc) per customer.
  - last_activity_at   = greatest observed activity = max(silver_touchpoint.occurred_at) coalesced to
                         silver_customer.last_seen_at.
  - health_band        = FOLDED-IN from gold_customer_health.health_band (healthy|at_risk|churned).
  - churn_score        = INTEGER 0-100 risk, FOLDED-IN from gold_customer_scores.churn_risk
                         (low→15 / medium→55 / high→85). Its own int seam — NEVER blended with money.
  - lifecycle_stage    = closed {new|active|at_risk|churned} derived from health_band + lifetime_orders.

MONEY (I-S07): lifetime_value_minor AND aov_minor are bigint MINOR units paired with currency_code —
  lifetime_value carried verbatim from silver_customer, aov an EXACT per-currency integer division of it
  (no float). brand_id is the first column / tenant key. churn_score is a non-money INTEGER 0-100.

SOURCES (the dbt ref() graph onto the Spark→Iceberg dual-run):
  - silver_customer      : Iceberg brain_silver.silver_customer (the Phase-1 spine). REQUIRED.
  - silver_order_state   : Iceberg brain_silver.silver_order_state (the order spine). Absent → lifecycle
                           counts all 0 (the LEFT-JOIN-on-missing → coalesce(...,0) behavior).
  - silver_touchpoint    : OPTIONAL — journey grain for preferred_channel / acquisition_source /
                           last_activity_at + the anon→brain bridge for preferred_device.
  - silver_page_view     : OPTIONAL — device_class grain for preferred_device.
  - silver_order_line    : OPTIONAL — line titles for top_category (bridged via silver_order_state).
  - gold_customer_health : OPTIONAL — health_band fold. gold_customer_scores : OPTIONAL — churn fold.
    NOTE: health/scores are Phase-2 sibling Gold marts (they derive deterministically from the SAME
    Silver spine), so on a cold first cycle they may be absent → health_band/churn_score/lifecycle_stage
    are NULL until the next continuous refresh cycle (eventually-consistent dual-run, never blocking).

PARITY: current side = StarRocks brain_gold.gold_customer_360 (dbt). PK (brand_id, brain_id); money
  column lifetime_value_minor (per-(brand,currency) exact Σ). The lifecycle CASE buckets ('delivered'/
  'rto') are byte-for-byte the dbt CASE — the same silver_order_state lifecycle_state vocabulary. The B2
  enrichment columns are NET-NEW (no dbt predecessor) — additive, parity-neutral on existing columns.

Run via spark-submit inside the Spark+Iceberg image — see ../run-gold-customer.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.types import IntegerType, StringType  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402
from pyspark.sql.window import Window  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402

# B2 enrichment scalars live PURE (no Spark) in _customer_360_enrich so they are unit-tested without a
# Spark session; we wrap them as UDFs here so the EXECUTED churn/lifecycle logic IS the tested logic.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _customer_360_enrich import churn_score_from_risk, lifecycle_stage  # noqa: E402

TABLE_NAME = "gold_customer_360"

# UDFs wrapping the pure (unit-tested) scalar transforms — applied per resolved customer row.
_churn_score_udf = F.udf(churn_score_from_risk, IntegerType())
_lifecycle_stage_udf = F.udf(lifecycle_stage, StringType())

# Column contract — the dbt gold_customer_360 select list (denormalized 360). brand_id first (tenant key).
_COLUMNS = """
          brand_id             string    NOT NULL,
          brain_id             string    NOT NULL,
          lifetime_orders      bigint,
          lifetime_value_minor bigint,
          aov_minor            bigint,
          currency_code        string,
          first_seen_at        timestamp,
          first_identified_at  timestamp,
          last_seen_at         timestamp,
          last_activity_at     timestamp,
          delivered_orders     bigint,
          rto_orders           bigint,
          cancelled_orders     bigint,
          refunded_orders      bigint,
          preferred_channel    string,
          preferred_device     string,
          top_category         string,
          acquisition_source   string,
          health_band          string,
          churn_score          int,
          lifecycle_stage      string,
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


def _read_gold(spark: SparkSession, table: str):
    """Read an OPTIONAL sibling Iceberg brain_gold.<table> for a fold-in (health/scores). Absent → None.

    health/scores are Phase-2 marts that derive deterministically from the same Silver spine; on a cold
    first cycle they may not exist yet, so the fold is always optional (NULL until the next refresh)."""
    fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.{table}"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001 — REST catalog raises generic Py4J
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            return None
        raise


def _mode_per_customer(df, brain_col: str, value_col: str, out_col: str):
    """Deterministic MODE of value_col per (brand_id, <brain_col>): COUNT per value, then ORDER BY
    count DESC, value ASC, take the top — mirrors _customer_360_enrich.pick_mode (unit-tested). NULL /
    empty values are excluded. Returns one row per (brand_id, brain_id) with [out_col]."""
    counted = (
        df.where(F.col(value_col).isNotNull() & (F.col(value_col) != ""))
        .groupBy(F.col("brand_id"), F.col(brain_col).alias("brain_id"), F.col(value_col).alias("_v"))
        .agg(F.count(F.lit(1)).alias("_n"))
    )
    w = Window.partitionBy("brand_id", "brain_id").orderBy(F.col("_n").desc(), F.col("_v").asc())
    return (
        counted.withColumn("_rk", F.row_number().over(w))
        .where(F.col("_rk") == 1)
        .select("brand_id", "brain_id", F.col("_v").alias(out_col))
    )


def _build_touchpoint_enrich(spark: SparkSession):
    """preferred_channel (mode) + acquisition_source (first touch) + last_activity_at (max) + the
    anon→brain bridge, all from silver_touchpoint resolved customers (stitched_brain_id not null)."""
    tp = _read_silver(spark, "silver_touchpoint", optional=True)
    if tp is None:
        print("[gold_customer_360] silver_touchpoint absent → channel/acquisition/device enrich NULL", flush=True)
        return None, None, None, None
    resolved = tp.where(F.col("stitched_brain_id").isNotNull())

    preferred_channel = _mode_per_customer(resolved, "stitched_brain_id", "channel", "preferred_channel")

    # acquisition_source = first-touch channel: is_first_touch desc, occurred_at asc, channel asc.
    acq_w = Window.partitionBy("brand_id", "brain_id").orderBy(
        F.col("is_first_touch").desc_nulls_last(), F.col("occurred_at").asc_nulls_last(), F.col("channel").asc_nulls_last()
    )
    acquisition = (
        resolved.where(F.col("channel").isNotNull() & (F.col("channel") != ""))
        .select(
            F.col("brand_id"), F.col("stitched_brain_id").alias("brain_id"),
            F.col("is_first_touch"), F.col("occurred_at"), F.col("channel"),
        )
        .withColumn("_rk", F.row_number().over(acq_w))
        .where(F.col("_rk") == 1)
        .select("brand_id", "brain_id", F.col("channel").alias("acquisition_source"))
    )

    last_activity = (
        resolved.groupBy(F.col("brand_id"), F.col("stitched_brain_id").alias("brain_id"))
        .agg(F.max("occurred_at").alias("last_activity_at"))
    )

    # bridge: (brand_id, brain_anon_id) → resolved brain_id, for the page_view device join.
    bridge = (
        resolved.where(F.col("brain_anon_id").isNotNull())
        .select(F.col("brand_id"), F.col("brain_anon_id"), F.col("stitched_brain_id").alias("brain_id"))
        .distinct()
    )
    return preferred_channel, acquisition, last_activity, bridge


def _build_device_enrich(spark: SparkSession, bridge):
    """preferred_device = mode of silver_page_view.device_class mapped to the resolved customer via the
    touchpoint anon→brain bridge (silver_touchpoint has no device column; page_view is the device grain)."""
    if bridge is None:
        return None
    pv = _read_silver(spark, "silver_page_view", optional=True)
    if pv is None:
        print("[gold_customer_360] silver_page_view absent → preferred_device NULL", flush=True)
        return None
    joined = (
        pv.where(F.col("device_class").isNotNull() & (F.col("device_class") != ""))
        .select("brand_id", "brain_anon_id", "device_class")
        .join(bridge, ["brand_id", "brain_anon_id"], "inner")
    )
    return _mode_per_customer(joined, "brain_id", "device_class", "preferred_device")


def _build_category_enrich(spark: SparkSession):
    """top_category = mode of silver_order_line.title per customer, joined to brain_id via
    silver_order_state (order_id → brain_id). title is the product-descriptive Silver field standing in
    for category until a dedicated category dimension exists."""
    ol = _read_silver(spark, "silver_order_line", optional=True)
    osd = _read_silver(spark, "silver_order_state", optional=True)
    if ol is None or osd is None:
        print("[gold_customer_360] silver_order_line/state absent → top_category NULL", flush=True)
        return None
    order_brain = osd.where(F.col("brain_id").isNotNull()).select("brand_id", "order_id", "brain_id").distinct()
    joined = (
        ol.select("brand_id", "order_id", "title")
        .join(order_brain, ["brand_id", "order_id"], "inner")
    )
    return _mode_per_customer(joined, "brain_id", "title", "top_category")


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

    # ── B2 ENRICHMENT frames (all OPTIONAL → LEFT JOIN, NULL when the source is absent) ──────────────
    preferred_channel, acquisition, last_activity, bridge = _build_touchpoint_enrich(spark)
    preferred_device = _build_device_enrich(spark, bridge)
    top_category = _build_category_enrich(spark)
    health = _read_gold(spark, "gold_customer_health")          # health_band fold
    scores = _read_gold(spark, "gold_customer_scores")          # churn_risk fold
    if health is None:
        print("[gold_customer_360] gold_customer_health absent → health_band/lifecycle_stage NULL (cold cycle)", flush=True)
    if scores is None:
        print("[gold_customer_360] gold_customer_scores absent → churn_score NULL (cold cycle)", flush=True)

    def _left(df, base):
        """LEFT JOIN an optional per-customer enrichment frame on (brand_id, brain_id)."""
        if df is None:
            return base
        return base.join(df, ["brand_id", "brain_id"], "left")

    # Start from the spine projection (existing columns BYTE-IDENTICAL), then fold the enrichment.
    base = (
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
        )
    )

    enriched = base
    enriched = _left(preferred_channel, enriched)
    enriched = _left(preferred_device, enriched)
    enriched = _left(top_category, enriched)
    enriched = _left(acquisition, enriched)
    enriched = _left(last_activity, enriched)
    # health_band fold (optional) — select only the band, aliased to avoid colliding with the spine.
    if health is not None:
        enriched = enriched.join(
            health.select("brand_id", "brain_id", F.col("health_band").alias("health_band")),
            ["brand_id", "brain_id"], "left",
        )
    # churn_risk fold (optional) — projected to churn_score (int 0-100) via the unit-tested UDF below.
    if scores is not None:
        enriched = enriched.join(
            scores.select("brand_id", "brain_id", F.col("churn_risk").alias("churn_risk")),
            ["brand_id", "brain_id"], "left",
        )

    # Columns that may be absent (no source frame joined) → materialize as typed NULLs so the final
    # projection is schema-stable regardless of which optional sources existed.
    def _col_or_null(name: str, dtype: str):
        return F.col(name) if name in enriched.columns else F.lit(None).cast(dtype)

    health_band_col = _col_or_null("health_band", "string")
    churn_risk_col = _col_or_null("churn_risk", "string")

    result = enriched.select(
        F.col("brand_id"),
        F.col("brain_id"),
        F.col("lifetime_orders"),
        F.col("lifetime_value_minor"),
        # aov_minor = EXACT integer minor-unit division (Spark `div`), nullsafe when orders<=0. Per the
        # SAME currency_code as lifetime_value_minor — never blended, never a float.
        F.when(
            F.col("lifetime_orders").isNotNull() & (F.col("lifetime_orders") > 0),
            F.expr("lifetime_value_minor div lifetime_orders"),
        ).otherwise(F.lit(None).cast("bigint")).alias("aov_minor"),
        F.col("currency_code"),
        F.col("first_seen_at"),
        F.col("first_identified_at"),
        F.col("last_seen_at"),
        # last_activity_at = max touchpoint activity, coalesced to the spine's last_seen_at.
        F.coalesce(_col_or_null("last_activity_at", "timestamp"), F.col("last_seen_at")).alias("last_activity_at"),
        F.col("delivered_orders"),
        F.col("rto_orders"),
        F.col("cancelled_orders"),
        F.col("refunded_orders"),
        _col_or_null("preferred_channel", "string").alias("preferred_channel"),
        _col_or_null("preferred_device", "string").alias("preferred_device"),
        _col_or_null("top_category", "string").alias("top_category"),
        _col_or_null("acquisition_source", "string").alias("acquisition_source"),
        health_band_col.alias("health_band"),
        _churn_score_udf(churn_risk_col).alias("churn_score"),
        _lifecycle_stage_udf(health_band_col, F.col("lifetime_orders")).alias("lifecycle_stage"),
        F.col("customer_watermark"),
        F.current_timestamp().alias("updated_at"),
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
          t.aov_minor            = s.aov_minor,
          t.currency_code        = s.currency_code,
          t.first_seen_at        = s.first_seen_at,
          t.first_identified_at  = s.first_identified_at,
          t.last_seen_at         = s.last_seen_at,
          t.last_activity_at     = s.last_activity_at,
          t.delivered_orders     = s.delivered_orders,
          t.rto_orders           = s.rto_orders,
          t.cancelled_orders     = s.cancelled_orders,
          t.refunded_orders      = s.refunded_orders,
          t.preferred_channel    = s.preferred_channel,
          t.preferred_device     = s.preferred_device,
          t.top_category         = s.top_category,
          t.acquisition_source   = s.acquisition_source,
          t.health_band          = s.health_band,
          t.churn_score          = s.churn_score,
          t.lifecycle_stage      = s.lifecycle_stage,
          t.customer_watermark   = s.customer_watermark,
          t.updated_at           = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, brain_id, lifetime_orders, lifetime_value_minor, aov_minor, currency_code,
          first_seen_at, first_identified_at, last_seen_at, last_activity_at,
          delivered_orders, rto_orders, cancelled_orders, refunded_orders,
          preferred_channel, preferred_device, top_category, acquisition_source,
          health_band, churn_score, lifecycle_stage,
          customer_watermark, updated_at
        ) VALUES (
          s.brand_id, s.brain_id, s.lifetime_orders, s.lifetime_value_minor, s.aov_minor, s.currency_code,
          s.first_seen_at, s.first_identified_at, s.last_seen_at, s.last_activity_at,
          s.delivered_orders, s.rto_orders, s.cancelled_orders, s.refunded_orders,
          s.preferred_channel, s.preferred_device, s.top_category, s.acquisition_source,
          s.health_band, s.churn_score, s.lifecycle_stage,
          s.customer_watermark, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_customer_360] MERGEd {n} customer-360 rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    # Structured per-job observability (additive) — one machine-parseable spark_job line carrying
    # V4_CORRELATION_ID when the v4-refresh-loop set it; the legacy human DONE line is unchanged.
    import os
    import sys
    import time

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from job_log import emit_job_log  # noqa: E402

    spark = build_spark("gold-customer-360")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn = materialize(spark)
        emit_job_log(
            "gold-customer-360", status="ok", fqtn=fqtn,
            rows_out=spark.table(fqtn).count(),
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        print("[gold_customer_360] DONE — Iceberg Customer-360 serving mart populated ✓", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("gold-customer-360", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
