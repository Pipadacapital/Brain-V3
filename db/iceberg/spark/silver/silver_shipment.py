"""
silver_shipment.py — Brain V4 Phase 1 (Spark Silver, dual-run): the Spark reimplementation of the dbt
model db/dbt/models/marts/silver_shipment.sql.

WHAT THIS IS: an ADDITIVE, NON-BREAKING Spark job that READS the (Spark-built) Iceberg Silver
transition log rest.brain_silver.silver_shipment_event and folds it to the LATEST shipment state per
order, writing rest.brain_silver.silver_shipment via an idempotent MERGE on the model PK
(brand_id, order_id). It runs BESIDE the existing dbt→StarRocks brain_silver.silver_shipment (the
parity oracle compares the two). It repoints NO reader, changes NO dbt model or app code.

UPSTREAM (dual-run discipline): the dbt model `ref('silver_shipment_event')`s the StarRocks Silver
event log. The Spark Silver lane is self-contained — it reads the Spark-built Iceberg
brain_silver.silver_shipment_event (produced by silver_shipment_event.py), so the whole Spark Silver
chain is reproducible from Bronze with no cross-engine dependency. RUN ORDER: silver_shipment_event.py
BEFORE this job.

FOLDED dbt LOGIC (exactly reproduced — see silver_shipment.sql):
  - events = silver_shipment_event.
  - ranked: row_number() over (partition by brand_id,order_id ORDER BY
      is_terminal DESC, status_changed_at DESC, occurred_at DESC, event_id DESC) — terminal-state wins,
      then latest status_changed_at, then latest occurred_at, then highest event_id (deterministic tie-break).
    first_event_at = min(occurred_at) over (partition by brand_id,order_id).
  - latest row per (brand_id,order_id): _win_rn == 1, projecting:
      current_status = status, is_rto = (terminal_class='rto'), is_delivered = (terminal_class='delivered'),
      last_status_at = status_changed_at, + first_event_at + current_timestamp() AS updated_at.

GRAIN: 1 row per (brand_id, order_id) — latest shipment state per order. brand_id tenant key.
PII: none raw — awb_number_hash already hashed.  MONEY: none.
IDEMPOTENT: MERGE WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT on (brand_id,order_id) — replay-safe.

Run via spark-submit inside the Spark+Iceberg image (see run-silver-checkout-shipment.sh).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

EVENT_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment_event"
SILVER_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment"

# Canonical Silver column contract — mirrors brain_silver.silver_shipment (dbt) column-for-column.
# last_status_at is STRING (varchar) in the dbt mart (it carries status_changed_at, a string).
_COLUMNS = """
          brand_id         string    NOT NULL,
          order_id         string    NOT NULL,
          source           string,
          awb_number_hash  string,
          courier          string,
          current_status   string,
          terminal_class   string,
          is_terminal      boolean,
          is_rto           boolean,
          is_delivered     boolean,
          payment_method   string,
          pincode          string,
          first_event_at   timestamp,
          last_status_at   string,
          is_synthetic     boolean,
          updated_at       timestamp NOT NULL
""".strip("\n")


def _build_shipment_df(spark: SparkSession):
    """Fold silver_shipment_event → latest-state-per-order, expressed as Spark SQL 1:1 against the dbt
    silver_shipment.sql ranking + projection."""
    return spark.sql(
        f"""
        WITH events AS (
            SELECT * FROM {EVENT_TABLE}
        ),
        ranked AS (
            SELECT *,
                row_number() OVER (
                    PARTITION BY brand_id, order_id
                    ORDER BY
                        is_terminal        DESC,
                        status_changed_at  DESC,
                        occurred_at        DESC,
                        event_id           DESC
                ) AS _win_rn,
                min(occurred_at) OVER (PARTITION BY brand_id, order_id) AS first_event_at
            FROM events
        )
        SELECT
            brand_id,
            order_id,
            source,
            awb_number_hash,
            courier,
            status                          AS current_status,
            terminal_class,
            is_terminal,
            (terminal_class = 'rto')        AS is_rto,
            (terminal_class = 'delivered')  AS is_delivered,
            payment_method,
            pincode,
            first_event_at,
            status_changed_at               AS last_status_at,
            is_synthetic,
            current_timestamp()             AS updated_at
        FROM ranked
        WHERE _win_rn = 1
        """
    )


def run(spark: SparkSession) -> None:
    create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        "silver_shipment",
        _COLUMNS,
        # Latest-state grain has no natural event-time partition col that's NOT NULL across the grain;
        # partition by brand bucket + days(first_event_at) (always present for any order with events).
        partitioned_by="bucket(256, brand_id), days(first_event_at)",
    )

    df = _build_shipment_df(spark)
    df.createOrReplaceTempView("silver_shipment_batch")

    # The source is already 1 row per (brand_id, order_id) (the _win_rn=1 filter), so MERGE directly.
    spark.sql(
        f"""
        MERGE INTO {SILVER_TABLE} t
        USING silver_shipment_batch s
        ON t.brand_id = s.brand_id AND t.order_id = s.order_id
        WHEN MATCHED THEN UPDATE SET
            t.source = s.source,
            t.awb_number_hash = s.awb_number_hash,
            t.courier = s.courier,
            t.current_status = s.current_status,
            t.terminal_class = s.terminal_class,
            t.is_terminal = s.is_terminal,
            t.is_rto = s.is_rto,
            t.is_delivered = s.is_delivered,
            t.payment_method = s.payment_method,
            t.pincode = s.pincode,
            t.first_event_at = s.first_event_at,
            t.last_status_at = s.last_status_at,
            t.is_synthetic = s.is_synthetic,
            t.updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
            brand_id, order_id, source, awb_number_hash, courier, current_status, terminal_class,
            is_terminal, is_rto, is_delivered, payment_method, pincode, first_event_at, last_status_at,
            is_synthetic, updated_at
        ) VALUES (
            s.brand_id, s.order_id, s.source, s.awb_number_hash, s.courier, s.current_status, s.terminal_class,
            s.is_terminal, s.is_rto, s.is_delivered, s.payment_method, s.pincode, s.first_event_at, s.last_status_at,
            s.is_synthetic, s.updated_at
        )
        """
    )
    print(f"[silver_shipment] MERGE done — {SILVER_TABLE} now has {spark.table(SILVER_TABLE).count()} rows", flush=True)


def main() -> None:
    spark = build_spark("silver-shipment")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
