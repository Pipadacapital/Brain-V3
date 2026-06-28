"""
silver_return.py — Brain V4 / SR-4: the canonical RETURN mart (latest return state per order).

WHAT THIS IS: an ADDITIVE Spark Silver job that folds the NEW canonical `shiprocket.return_status.v1`
events out of the gated collector lane (brain_silver.silver_collector_event) into a per-(brand,order_id)
latest-return-state mart (brain_silver.silver_return), via an idempotent MERGE on the model PK
(brand_id, order_id). It mirrors silver_shipment.py (which does the same for forward shipments) but for
RETURNS — a SEPARATE lifecycle that must NEVER be confused with forward delivery or RTO.

WHY A SEPARATE MART (the SR-4 revenue-truth fix): a return whose status is "delivered"/"completed"
means delivered-BACK-to-origin / refund-closed, NOT a sale confirmation. The TS mapper
(@brain/shiprocket-mapper.mapShiprocketReturn) classifies returns with classifyReturnStatus (NEVER
classifyShipmentStatus), emitting return_class ∈ {return_initiated, return_in_transit,
return_delivered, return_completed, none} — so a return can never produce a forward DELIVERED. This
mart simply folds those events to current state; it carries NO terminal_class column, so it can never
leak into the CoD/delivery ledger as a false delivery.

GRAIN: 1 row per (brand_id, order_id) — latest return state per order. brand_id tenant key.
PII: none raw — awb_number_hash + hashed_customer_{email,phone} are already hashed at the mapper boundary.
MONEY: none (returns carry no money column here — refund money is the ledger's job, off this mart).
IDEMPOTENT: MERGE WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT on (brand_id, order_id) — replay-safe.

STAGE-1 GATE (Brain V4 two-stage): a timestamped transition log with NO money / NO quantity, so the
  applicable Stage-1 DQ rule is the TIMESTAMP gate over occurred_at (future/unparseable → quarantine,
  stage='dq', never written; Bronze keeps the original — replay-safe). return_class comes from the
  @brain/logistics-status authority (enums, not human display names), so clean_name does NOT apply.

Run via spark-submit inside the Spark+Iceberg image (see run-silver-return.sh).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import array_join, col, lit, size  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)
from _silver_technical import dq_violations_udf, write_quarantine  # noqa: E402

# ADR-0006 P3: read the GATED collector lane (R2/R3 already applied in Silver), exactly like
# silver_shipment_event.py — the return events land there server-trusted (SR-4 admit-list).
COLLECTOR_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
SILVER_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_return"
RETURN_EVENT_TYPE = "shiprocket.return_status.v1"

# Canonical Silver column contract for the return mart. last_status_at is STRING (carries the
# status_changed_at string) — same convention as silver_shipment.last_status_at.
_COLUMNS = """
          brand_id               string    NOT NULL,
          order_id               string    NOT NULL,
          source                 string,
          awb_number_hash        string,
          courier                string,
          current_status         string,
          return_class           string,
          is_return_complete     boolean,
          payment_method         string,
          pincode                string,
          hashed_customer_email  string,
          hashed_customer_phone  string,
          first_event_at         timestamp,
          last_status_at         string,
          is_synthetic           boolean,
          updated_at             timestamp NOT NULL
""".strip("\n")


def _build_event_df(spark: SparkSession):
    """Project the canonical return properties out of the gated collector lane (1 row per transition).
    get_json_object(payload,'$.properties.X') matches the ShiprocketReturnProperties shape exactly."""
    return spark.sql(
        f"""
        WITH raw AS (
            SELECT brand_id, event_id, event_type, occurred_at, payload
            FROM {COLLECTOR_TABLE}
            WHERE event_type = '{RETURN_EVENT_TYPE}'
        ),
        src AS (
            SELECT
                brand_id,
                event_id,
                occurred_at,
                payload,
                get_json_object(payload, '$.properties.source')                AS source,
                get_json_object(payload, '$.properties.order_id')              AS order_id,
                get_json_object(payload, '$.properties.awb_number_hash')       AS awb_number_hash,
                get_json_object(payload, '$.properties.courier')               AS courier,
                get_json_object(payload, '$.properties.status')                AS status,
                coalesce(get_json_object(payload, '$.properties.return_class'), 'none') AS return_class,
                (get_json_object(payload, '$.properties.is_return_complete') = 'true')  AS is_return_complete,
                get_json_object(payload, '$.properties.payment_method')        AS payment_method,
                get_json_object(payload, '$.properties.pincode')               AS pincode,
                get_json_object(payload, '$.properties.hashed_customer_email') AS hashed_customer_email,
                get_json_object(payload, '$.properties.hashed_customer_phone') AS hashed_customer_phone,
                coalesce(get_json_object(payload, '$.properties.status_changed_at'),
                         cast(occurred_at AS string))                          AS status_changed_at,
                CASE WHEN get_json_object(payload, '$.properties.data_source') = 'synthetic'
                     THEN true ELSE false END                                  AS is_synthetic
            FROM raw
        )
        SELECT * FROM src
        WHERE order_id IS NOT NULL AND order_id <> ''
        """
    )


def _fold_latest_per_order(spark: SparkSession):
    """Fold the per-transition events to the LATEST return state per (brand,order_id). Terminal
    (return_completed) wins, then latest status_changed_at, then latest occurred_at, then highest
    event_id — deterministic tie-break, mirroring silver_shipment.py."""
    return spark.sql(
        f"""
        WITH events AS (
            SELECT * FROM _silver_return_events
        ),
        ranked AS (
            SELECT *,
                row_number() OVER (
                    PARTITION BY brand_id, order_id
                    ORDER BY
                        is_return_complete DESC,
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
            status                AS current_status,
            return_class,
            is_return_complete,
            payment_method,
            pincode,
            hashed_customer_email,
            hashed_customer_phone,
            first_event_at,
            status_changed_at     AS last_status_at,
            is_synthetic,
            current_timestamp()   AS updated_at
        FROM ranked
        WHERE _win_rn = 1
        """
    )


def run(spark: SparkSession) -> None:
    create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        "silver_return",
        _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(first_event_at)",
    )

    df = _build_event_df(spark)

    # ── Stage-1 DQ gate: timestamp validity only (no money / no quantity on a return transition). ──
    gated = df.withColumn(
        "_dq",
        dq_violations_udf()(lit(None).cast("bigint"), lit(None).cast("string"), col("occurred_at").cast("string")),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            col("source"),
            col("event_id").alias("bronze_event_id"),
            lit("silver_return").alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq", "payload")
    good.createOrReplaceTempView("_silver_return_events")

    folded = _fold_latest_per_order(spark)
    folded.createOrReplaceTempView("silver_return_batch")

    spark.sql(
        f"""
        MERGE INTO {SILVER_TABLE} t
        USING silver_return_batch s
        ON t.brand_id = s.brand_id AND t.order_id = s.order_id
        WHEN MATCHED THEN UPDATE SET
            t.source = s.source,
            t.awb_number_hash = s.awb_number_hash,
            t.courier = s.courier,
            t.current_status = s.current_status,
            t.return_class = s.return_class,
            t.is_return_complete = s.is_return_complete,
            t.payment_method = s.payment_method,
            t.pincode = s.pincode,
            t.hashed_customer_email = s.hashed_customer_email,
            t.hashed_customer_phone = s.hashed_customer_phone,
            t.first_event_at = s.first_event_at,
            t.last_status_at = s.last_status_at,
            t.is_synthetic = s.is_synthetic,
            t.updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
            brand_id, order_id, source, awb_number_hash, courier, current_status, return_class,
            is_return_complete, payment_method, pincode, hashed_customer_email, hashed_customer_phone,
            first_event_at, last_status_at, is_synthetic, updated_at
        ) VALUES (
            s.brand_id, s.order_id, s.source, s.awb_number_hash, s.courier, s.current_status, s.return_class,
            s.is_return_complete, s.payment_method, s.pincode, s.hashed_customer_email, s.hashed_customer_phone,
            s.first_event_at, s.last_status_at, s.is_synthetic, s.updated_at
        )
        """
    )
    print(f"[silver_return] MERGE done — {SILVER_TABLE} now has {spark.table(SILVER_TABLE).count()} rows", flush=True)


def main() -> None:
    spark = build_spark("silver-return")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
