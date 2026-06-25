"""
silver_customer.py — Spark reimplementation of the dbt silver_customer mart (Brain V4 Phase 1,
customer+identity group). Reproduces db/dbt/models/marts/silver_customer.sql EXACTLY: the canonical
CUSTOMER entity — one row per resolved customer (brand_id, brain_id) — as an additive roll-up of the
order spine (silver_order_state) LEFT JOINed to the identity projection (silver_customer_identity).

GRAIN: exactly one row per (brand_id, brain_id) — the model PK. Unlinked orders (brain_id NULL) are
  EXCLUDED (not yet a known customer), matching the dbt `where brain_id is not null`.

THE TRANSFORM (folded from the dbt model's FULL-BUILD branch — the incremental dirty-key fold is a
perf optimization that yields the identical end-state, so the Spark dual-run does the full roll-up):
  order_rollup  = from silver_order_state where brain_id is not null, GROUP BY (brand_id, brain_id):
        lifetime_orders        = count(order_id)
        lifetime_value_minor   = cast(sum(order_value_minor) as bigint)   -- MONEY: bigint minor units
        currency_code          = max(currency_code)
        first_seen_at          = min(first_event_at)
        last_seen_at           = max(state_effective_at)
        customer_watermark     = max(max_ingested_at)
  identity_node = from silver_customer_identity where lifecycle_state <> 'merged':
        (brand_id, brain_id) → first_identified_at   (H6 acquisition time)
  result        = order_rollup LEFT JOIN identity_node on (brand_id, brain_id), projecting:
        brand_id, brain_id, lifetime_orders, lifetime_value_minor, currency_code,
        first_seen_at, first_identified_at, last_seen_at, customer_watermark, updated_at

SOURCES (mirrors the dbt ref() graph onto the Spark→Iceberg dual-run, with a live fallback):
  - silver_order_state: prefer the Spark→Iceberg brain_silver.silver_order_state (the dual-run sibling
    mart, owned by the order-state group). If that Iceberg table is absent yet (the order-state Spark
    job hasn't landed), FALL BACK to the live StarRocks brain_silver.silver_order_state over JDBC so
    this job is runnable independently during the staged dual-run. Controlled by ORDER_STATE_SOURCE
    (auto|iceberg|starrocks). Either source is the SAME logical table — read parity is unaffected.
  - silver_customer_identity: read the Spark→Iceberg brain_silver.silver_customer_identity built by
    silver_customer_identity.py (this group's sibling job). Absent → treat as empty (LEFT JOIN, so
    first_identified_at is simply NULL — exactly the dbt LEFT-JOIN-on-missing-identity behavior).

MONEY (I-S07): lifetime_value_minor is bigint minor units paired with currency_code. brand_id is the
  first column / tenant key. No raw PII (the customer entity is keyed by the brain_id surrogate only).

PARITY: current side = StarRocks brain_silver.silver_customer (dbt). PK (brand_id, brain_id); money
  column lifetime_value_minor (per-(brand,currency) exact Σ).

Run via spark-submit inside the Spark+Iceberg image — see ../run-silver-customer.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402

TABLE_NAME = "silver_customer"

# silver_order_state source selection: "iceberg" | "starrocks" | "auto" (iceberg if present else SR).
ORDER_STATE_SOURCE = os.environ.get("ORDER_STATE_SOURCE", "auto").strip().lower()

# CURRENT-side StarRocks JDBC (the live dual-run sibling) for the fallback read of silver_order_state.
SR_JDBC_URL = os.environ.get("SILVER_SR_JDBC_URL", "jdbc:mysql://starrocks:9030")
SR_USER = os.environ.get("SILVER_SR_USER", "root")
SR_PASSWORD = os.environ.get("SILVER_SR_PASSWORD", "")

# Column contract — the dbt silver_customer select list (additive roll-up). brand_id first (tenant key).
_COLUMNS = """
          brand_id             string    NOT NULL,
          brain_id             string    NOT NULL,
          lifetime_orders      bigint,
          lifetime_value_minor bigint,
          currency_code        string,
          first_seen_at        timestamp,
          first_identified_at  timestamp,
          last_seen_at         timestamp,
          customer_watermark   timestamp,
          updated_at           timestamp
""".strip("\n")


def _iceberg_order_state(spark: SparkSession):
    """Read the Spark→Iceberg brain_silver.silver_order_state; None if the table isn't built yet."""
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
    try:
        df = spark.table(fqtn)
        df.schema  # force metadata resolution so an absent table raises here
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001 — REST catalog raises generic Py4J
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            return None
        raise


def _starrocks_order_state(spark: SparkSession):
    """Fallback: read the live StarRocks brain_silver.silver_order_state over JDBC (the dual-run sibling).

    The StarRocks DDL exposes state_effective_at + occurred_at but NOT first_event_at / max_ingested_at
    (those are dbt-internal watermark columns not persisted in the serving DDL). For the roll-up:
      - first_seen_at uses occurred_at (the event time of the latest transition) as the best available
        per-row time when reading the SERVING table; this is a documented fallback-only approximation
        (the Iceberg sibling carries the true first_event_at). The PREFERRED path is the Iceberg read.
      - customer_watermark uses state_effective_at (the serving table's economic-time column).
    These approximations affect ONLY first_seen_at/customer_watermark (timestamps), never money or PK.
    """
    query = (
        "SELECT brand_id, order_id, brain_id, order_value_minor, currency_code, "
        "occurred_at AS first_event_at, state_effective_at, state_effective_at AS max_ingested_at "
        "FROM brain_silver.silver_order_state"
    )
    return (
        spark.read.format("jdbc")
        .option("url", SR_JDBC_URL)
        .option("user", SR_USER)
        .option("password", SR_PASSWORD)
        .option("driver", "com.mysql.cj.jdbc.Driver")
        .option("query", query)
        .load()
    )


def _read_order_state(spark: SparkSession):
    ice = None
    if ORDER_STATE_SOURCE in ("auto", "iceberg"):
        ice = _iceberg_order_state(spark)
    if ice is not None and ORDER_STATE_SOURCE != "starrocks":
        print("[silver_customer] order-state source = Iceberg brain_silver.silver_order_state", flush=True)
        # Normalize to the column set the roll-up needs (the Iceberg dbt-parity mart carries them all).
        return ice.select(
            "brand_id", "order_id", "brain_id", "order_value_minor", "currency_code",
            "first_event_at", "state_effective_at", "max_ingested_at",
        )
    if ORDER_STATE_SOURCE == "iceberg":
        raise SystemExit(
            "[silver_customer] ORDER_STATE_SOURCE=iceberg but brain_silver.silver_order_state is absent — "
            "build the order-state Spark mart first, or use ORDER_STATE_SOURCE=auto|starrocks."
        )
    print("[silver_customer] order-state source = StarRocks brain_silver.silver_order_state (JDBC fallback)", flush=True)
    return _starrocks_order_state(spark)


def _read_identity(spark: SparkSession):
    """Read the Spark→Iceberg silver_customer_identity (this group's sibling). Absent → empty df."""
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer_identity"
    try:
        df = spark.table(fqtn)
        df.schema
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            print("[silver_customer] silver_customer_identity absent → first_identified_at NULL (LEFT JOIN)", flush=True)
            return spark.createDataFrame(
                [], "brand_id string, brain_id string, first_identified_at timestamp"
            )
        raise
    # dbt: identity_node = where lifecycle_state <> 'merged'.
    return df.where(F.col("lifecycle_state") != F.lit("merged")).select(
        "brand_id", "brain_id", "first_identified_at"
    )


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(8, brand_id)",
    )

    osd = _read_order_state(spark).where(F.col("brain_id").isNotNull())

    # order_rollup — the dbt FULL-build aggregation.
    order_rollup = osd.groupBy("brand_id", "brain_id").agg(
        F.count("order_id").cast("bigint").alias("lifetime_orders"),
        F.sum("order_value_minor").cast("bigint").alias("lifetime_value_minor"),
        F.max("currency_code").alias("currency_code"),
        F.min("first_event_at").alias("first_seen_at"),
        F.max("state_effective_at").alias("last_seen_at"),
        F.max("max_ingested_at").alias("customer_watermark"),
    )

    identity_node = _read_identity(spark)

    result = (
        order_rollup.alias("o")
        .join(
            identity_node.alias("i"),
            (F.col("o.brand_id") == F.col("i.brand_id")) & (F.col("o.brain_id") == F.col("i.brain_id")),
            "left",
        )
        .select(
            F.col("o.brand_id").alias("brand_id"),
            F.col("o.brain_id").alias("brain_id"),
            F.col("o.lifetime_orders").alias("lifetime_orders"),
            F.col("o.lifetime_value_minor").alias("lifetime_value_minor"),
            F.col("o.currency_code").alias("currency_code"),
            F.col("o.first_seen_at").alias("first_seen_at"),
            F.col("i.first_identified_at").alias("first_identified_at"),
            F.col("o.last_seen_at").alias("last_seen_at"),
            F.col("o.customer_watermark").alias("customer_watermark"),
            F.current_timestamp().alias("updated_at"),
        )
    )

    n = result.count()
    result.createOrReplaceTempView("sc_src")

    # Idempotent MERGE on the PK. WHEN MATCHED THEN UPDATE — a customer's lifetime totals RESTATE when a
    # new order lands (the dbt incremental re-fold semantic); WHEN NOT MATCHED THEN INSERT for new ones.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING sc_src s
        ON t.brand_id = s.brand_id AND t.brain_id = s.brain_id
        WHEN MATCHED THEN UPDATE SET
          t.lifetime_orders      = s.lifetime_orders,
          t.lifetime_value_minor = s.lifetime_value_minor,
          t.currency_code        = s.currency_code,
          t.first_seen_at        = s.first_seen_at,
          t.first_identified_at  = s.first_identified_at,
          t.last_seen_at         = s.last_seen_at,
          t.customer_watermark   = s.customer_watermark,
          t.updated_at           = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, brain_id, lifetime_orders, lifetime_value_minor, currency_code,
          first_seen_at, first_identified_at, last_seen_at, customer_watermark, updated_at
        ) VALUES (
          s.brand_id, s.brain_id, s.lifetime_orders, s.lifetime_value_minor, s.currency_code,
          s.first_seen_at, s.first_identified_at, s.last_seen_at, s.customer_watermark, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(f"[silver_customer] MERGEd {n} customer rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-customer")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[silver_customer] DONE — Iceberg customer spine populated ✓", flush=True)


if __name__ == "__main__":
    main()
