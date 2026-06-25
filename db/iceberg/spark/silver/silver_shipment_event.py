"""
silver_shipment_event.py — Brain V4 Phase 1 (Spark Silver, dual-run): the Spark reimplementation of
the dbt model db/dbt/models/marts/silver_shipment_event.sql (folding stg_shipment_events).

WHAT THIS IS: an ADDITIVE, NON-BREAKING Spark job that READS raw Iceberg Bronze
(rest.brain_bronze.collector_events) for the logistics shipment-transition event types and WRITES the
canonical Silver transition-log mart rest.brain_silver.silver_shipment_event via an idempotent MERGE on
the model PK (brand_id, event_id). It runs BESIDE the existing dbt→StarRocks
brain_silver.silver_shipment_event (the parity oracle compares the two). It repoints NO reader, changes
NO dbt model or app code.

FOLDED dbt LOGIC (exactly reproduced — see the two dbt files for the canonical spec):
  stg_shipment_events (view):
    - source: bronze_iceberg.collector_events, event_type IN
      ('gokwik.awb_status.v1','shiprocket.shipment_status.v1')
    - typed projection from payload.properties.* (StarRocks get_json_string(parse_json(payload),'$.x')
      == Spark get_json_object(payload,'$.x')).
    - keyed: order_id IS NOT NULL AND order_id <> '' (drop un-keyed transitions).
    - terminal_class = coalesce(raw,'none'); is_terminal = (terminal_class <> 'none') — derived from
      the @brain/logistics-status authority, NEVER a raw JSON bool.
    - status_changed_at = coalesce(raw, cast(occurred_at as string)).
    - dedup: row_number() over (partition by brand_id,event_id order by occurred_at asc) == 1.
  silver_shipment_event (mart):
    - straight projection of the staging columns + current_timestamp() AS updated_at.

GRAIN: 1 row per (brand_id, event_id) — one row per shipment status transition. brand_id tenant key.
PII: none raw — awb_number_hash is already hashed; no raw AWB / PII.
MONEY: none (this mart carries no money column).
IDEMPOTENT: MERGE WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT on (brand_id,event_id) — replay-safe.

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

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.collector_events"
SILVER_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment_event"

# Canonical Silver column contract — mirrors brain_silver.silver_shipment_event (dbt) column-for-column.
# status_changed_at is a STRING in the dbt mart (varchar) — coalesce(raw, cast(occurred_at as string)).
_COLUMNS = """
          brand_id           string    NOT NULL,
          event_id           string    NOT NULL,
          order_id           string,
          source             string,
          awb_number_hash    string,
          status             string,
          terminal_class     string,
          is_terminal        boolean,
          payment_method     string,
          pincode            string,
          courier            string,
          status_changed_at  string,
          occurred_at        timestamp,
          is_synthetic       boolean,
          updated_at         timestamp NOT NULL
""".strip("\n")


def _build_event_df(spark: SparkSession):
    """Fold stg_shipment_events + the silver_shipment_event mart projection into one DataFrame —
    expressed as Spark SQL so it reads 1:1 against the dbt SQL."""
    return spark.sql(
        f"""
        WITH raw AS (
            SELECT brand_id, event_id, event_type, occurred_at, payload
            FROM {BRONZE_TABLE}
            WHERE event_type IN ('gokwik.awb_status.v1', 'shiprocket.shipment_status.v1')
        ),
        src AS (
            SELECT
                brand_id,
                event_id,
                event_type,
                occurred_at,
                get_json_object(payload, '$.properties.source')           AS source,
                get_json_object(payload, '$.properties.order_id')          AS order_id,
                get_json_object(payload, '$.properties.awb_number_hash')   AS awb_number_hash,
                get_json_object(payload, '$.properties.status')            AS status,
                get_json_object(payload, '$.properties.terminal_class')    AS terminal_class,
                get_json_object(payload, '$.properties.payment_method')    AS payment_method,
                get_json_object(payload, '$.properties.pincode')           AS pincode,
                get_json_object(payload, '$.properties.courier')           AS courier,
                get_json_object(payload, '$.properties.status_changed_at') AS status_changed_at,
                CASE WHEN get_json_object(payload, '$.properties.data_source') = 'synthetic'
                     THEN true ELSE false END                              AS is_synthetic
            FROM raw
        ),
        keyed AS (
            SELECT * FROM src
            WHERE order_id IS NOT NULL AND order_id <> ''
        ),
        deduped AS (
            SELECT *,
                row_number() OVER (
                    PARTITION BY brand_id, event_id
                    ORDER BY occurred_at ASC
                ) AS _dedup_rn
            FROM keyed
        )
        SELECT
            brand_id,
            event_id,
            order_id,
            source,
            awb_number_hash,
            status,
            coalesce(terminal_class, 'none')                          AS terminal_class,
            (coalesce(terminal_class, 'none') <> 'none')             AS is_terminal,
            payment_method,
            pincode,
            courier,
            coalesce(status_changed_at, cast(occurred_at AS string)) AS status_changed_at,
            occurred_at,
            is_synthetic,
            current_timestamp() AS updated_at
        FROM deduped
        WHERE _dedup_rn = 1
        """
    )


def run(spark: SparkSession) -> None:
    create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        "silver_shipment_event",
        _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )

    df = _build_event_df(spark)
    df.createOrReplaceTempView("silver_shipment_event_batch")

    spark.sql(
        f"""
        MERGE INTO {SILVER_TABLE} t
        USING (
            SELECT * FROM (
                SELECT *, row_number() OVER (
                    PARTITION BY brand_id, event_id ORDER BY occurred_at ASC
                ) AS _rn FROM silver_shipment_event_batch
            ) WHERE _rn = 1
        ) s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET
            t.order_id = s.order_id,
            t.source = s.source,
            t.awb_number_hash = s.awb_number_hash,
            t.status = s.status,
            t.terminal_class = s.terminal_class,
            t.is_terminal = s.is_terminal,
            t.payment_method = s.payment_method,
            t.pincode = s.pincode,
            t.courier = s.courier,
            t.status_changed_at = s.status_changed_at,
            t.occurred_at = s.occurred_at,
            t.is_synthetic = s.is_synthetic,
            t.updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
            brand_id, event_id, order_id, source, awb_number_hash, status, terminal_class,
            is_terminal, payment_method, pincode, courier, status_changed_at, occurred_at,
            is_synthetic, updated_at
        ) VALUES (
            s.brand_id, s.event_id, s.order_id, s.source, s.awb_number_hash, s.status, s.terminal_class,
            s.is_terminal, s.payment_method, s.pincode, s.courier, s.status_changed_at, s.occurred_at,
            s.is_synthetic, s.updated_at
        )
        """
    )
    print(f"[silver_shipment_event] MERGE done — {SILVER_TABLE} now has {spark.table(SILVER_TABLE).count()} rows", flush=True)


def main() -> None:
    spark = build_spark("silver-shipment-event")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
