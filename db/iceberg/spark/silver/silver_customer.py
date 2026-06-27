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

SOURCES (mirrors the dbt ref() graph onto the Spark→Iceberg dual-run):
  - silver_order_state: read the Spark→Iceberg {CATALOG}.brain_silver.silver_order_state (the dual-run
    sibling mart, owned by the order-state group). Spark Phase 1 ALWAYS writes this Iceberg table, so it
    is the single source — there is NO StarRocks-JDBC fallback (no brain_silver. dbt-DB read remains).
    The Iceberg sibling carries the true first_event_at / max_ingested_at watermark columns the roll-up
    needs (the serving DDL did not), so this read is also strictly more faithful than the old fallback.
  - silver_customer_identity: read the Spark→Iceberg brain_silver.silver_customer_identity built by
    silver_customer_identity.py (this group's sibling job). Absent → treat as empty (LEFT JOIN, so
    first_identified_at is simply NULL — exactly the dbt LEFT-JOIN-on-missing-identity behavior).

MONEY (I-S07): lifetime_value_minor is bigint minor units paired with currency_code. brand_id is the
  first column / tenant key. No raw PII (the customer entity is keyed by the brain_id surrogate only).

STAGE-1 GATE (Brain V4 two-stage): this is a PII-FREE aggregate — the canonical customer entity carries
  NO raw display/name field (names live HASHED on the silver_identity_link edges, never here), so
  _silver_technical.clean_name has no applicable column in this job (the hash-only PII path is upstream;
  documented per the Stage-1 contract). The Stage-1 reject path that DOES apply is the DQ currency gate:
  a rolled-up customer whose aggregate currency_code is not ISO-4217 alpha-3 is diverted to
  brain_silver.silver_quarantine (stage='dq') and NOT written to silver_customer. (Only currency is gated
  — a customer's lifetime_value_minor can be legitimately net-NEGATIVE when refunds exceed orders, so the
  amount-sign DQ rule is intentionally NOT applied at this aggregate grain.) The (brand_id, brain_id)
  schema invariants are enforced structurally (NOT NULL + the brain_id-not-null filter = the schema gate).
  Good rows are byte-identical to before (parity-faithful).

PARITY: current side = StarRocks brain_silver.silver_customer (dbt). PK (brand_id, brain_id); money
  column lifetime_value_minor (per-(brand,currency) exact Σ).

Run via spark-submit inside the Spark+Iceberg image — see ../run-silver-customer.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

TABLE_NAME = "silver_customer"

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


def _read_order_state(spark: SparkSession):
    """Read the Spark→Iceberg {CATALOG}.brain_silver.silver_order_state — the single source.

    Spark Phase 1 (silver_order_state.py) ALWAYS writes this Iceberg sibling, so there is no
    StarRocks-JDBC fallback: zero brain_silver. dbt-DB reads remain. The Iceberg mart carries the true
    first_event_at / max_ingested_at watermark columns the roll-up needs (the serving DDL did not), so
    this is the same logical table the primary path always used — just without the absent-table branch.
    """
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_state"
    print(f"[silver_customer] order-state source = Iceberg {fqtn}", flush=True)
    # Project the exact column set the roll-up needs (the Iceberg dbt-parity mart carries them all).
    return spark.table(fqtn).select(
        "brand_id", "order_id", "brain_id", "order_value_minor", "currency_code",
        "first_event_at", "state_effective_at", "max_ingested_at",
    )


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

    # ── Stage-1 DQ gate (currency only — see module docstring): non-ISO-4217 currency → quarantine ────
    gated = result.withColumn(
        "_dq", dq_violations_udf()(F.lit(None).cast("bigint"), F.col("currency_code"), F.lit(None).cast("string"))
    )
    write_quarantine(
        spark,
        gated.where(F.size(F.col("_dq")) > 0).select(
            F.col("brand_id"),
            F.lit("silver_order_state").alias("source"),
            F.col("brain_id").alias("bronze_event_id"),
            F.lit(TABLE_NAME).alias("canonical_target"),
            F.array_join(F.col("_dq"), ",").alias("reason"),
            F.to_json(F.struct("brand_id", "brain_id", "currency_code", "lifetime_value_minor")).alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(F.size(F.col("_dq")) == 0).drop("_dq")

    n = good.count()
    good.createOrReplaceTempView("sc_src")

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
    # Structured per-job observability (additive) — one machine-parseable spark_job line carrying
    # V4_CORRELATION_ID when the v4-refresh-loop set it; the legacy human DONE line is unchanged.
    import os
    import sys
    import time

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from job_log import emit_job_log  # noqa: E402

    spark = build_spark("silver-customer")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn = materialize(spark)
        emit_job_log(
            "silver-customer", status="ok", fqtn=fqtn,
            rows_out=spark.table(fqtn).count(),
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        print("[silver_customer] DONE — Iceberg customer spine populated ✓", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-customer", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
