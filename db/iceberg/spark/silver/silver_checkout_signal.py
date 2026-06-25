"""
silver_checkout_signal.py — Brain V4 Phase 1 (Spark Silver, dual-run): the Spark reimplementation of
the dbt model db/dbt/models/marts/silver_checkout_signal.sql (folding stg_checkout_signal_events).

WHAT THIS IS: an ADDITIVE, NON-BREAKING Spark job that READS raw Iceberg Bronze
(rest.brain_bronze.collector_events) for the payments/checkout SIGNAL event types and WRITES the
canonical Silver mart rest.brain_silver.silver_checkout_signal via an idempotent MERGE on the model
PK (brand_id, event_id). It runs BESIDE the existing dbt→StarRocks brain_silver.silver_checkout_signal
(the parity oracle compares the two). It repoints NO reader, changes NO dbt model or app code.

FOLDED dbt LOGIC (exactly reproduced — see the two dbt files for the canonical spec):
  stg_checkout_signal_events (view):
    - source: bronze_iceberg.collector_events, event_type IN
      ('gokwik.rto_predict.v1','shopflo.checkout_abandoned.v1')
    - typed projection from payload.properties.* (StarRocks get_json_string(parse_json(payload),'$.x')
      == Spark get_json_object(payload,'$.x') — payload is a JSON string in Bronze).
    - signal_type / source discriminant by event_type.
    - money: total_price_minor / total_discount_minor cast to BIGINT minor units (+ currency_code).
    - has_address / is_synthetic booleans from the JSON string flags.
    - dedup: row_number() over (partition by brand_id,event_id order by occurred_at asc) == 1
      (earliest-occurred wins — matches the dbt staging dedup exactly).
  silver_checkout_signal (mart):
    - projects the staging columns + current_timestamp() AS updated_at.
    - TTL/partition guard: WHERE occurred_at IS NOT NULL AND occurred_at >= now() - 400 days.

GRAIN: 1 row per (brand_id, event_id). brand_id is the tenant key (first column, partition anchor).
MONEY: total_price_minor / total_discount_minor are bigint MINOR UNITS paired with currency_code.
PII: none raw — only order_id / risk band / money / address-present flag.
IDEMPOTENT: MERGE WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT on (brand_id,event_id) — replay-safe.

Run via spark-submit inside the Spark+Iceberg image (see run-silver-checkout-shipment.sh). All wiring
is env-overridable; dev defaults target the compose service names (iceberg-rest:8181, minio:9000).
"""
from __future__ import annotations  # Python 3.8 (Spark image): defer annotation evaluation.

import os
import sys

# iceberg_base lives one dir up (db/iceberg/spark). run-silver-checkout-shipment.sh puts it on
# PYTHONPATH via --py-files; for a direct local run, add the parent dir to sys.path defensively.
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
SILVER_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_checkout_signal"

# The TTL/partition-window guard from the dbt mart (interval 400 day). Overridable so a full backfill
# can widen it; default matches the dbt model exactly.
TTL_DAYS = int(os.environ.get("CHECKOUT_SIGNAL_TTL_DAYS", "400"))

# Canonical Silver column contract — mirrors the dbt mart output (brain_silver.silver_checkout_signal
# DDL) column-for-column. Money is bigint minor units + currency_code (HARD RULE).
_COLUMNS = """
          brand_id              string    NOT NULL,
          event_id              string    NOT NULL,
          signal_type           string,
          source                string,
          order_id              string,
          risk_flag             string,
          total_price_minor     bigint,
          total_discount_minor  bigint,
          has_address           boolean,
          currency_code         string,
          occurred_at           timestamp,
          is_synthetic          boolean,
          updated_at            timestamp NOT NULL
""".strip("\n")


def _build_signal_df(spark: SparkSession):
    """Fold stg_checkout_signal_events + the silver_checkout_signal mart projection into one DataFrame.

    Expressed as Spark SQL so the transform reads 1:1 against the dbt SQL (same get_json_object paths,
    same signal_type/source CASE, same earliest-occurred dedup, same TTL guard).
    """
    return spark.sql(
        f"""
        WITH raw AS (
            SELECT brand_id, event_id, event_type, occurred_at, payload
            FROM {BRONZE_TABLE}
            WHERE event_type IN ('gokwik.rto_predict.v1', 'shopflo.checkout_abandoned.v1')
        ),
        typed AS (
            SELECT
                brand_id,
                event_id,
                event_type,
                occurred_at,
                CASE event_type
                    WHEN 'gokwik.rto_predict.v1'         THEN 'rto_predict'
                    WHEN 'shopflo.checkout_abandoned.v1' THEN 'checkout_abandoned'
                END                                                        AS signal_type,
                CASE event_type
                    WHEN 'gokwik.rto_predict.v1'         THEN 'gokwik'
                    WHEN 'shopflo.checkout_abandoned.v1' THEN 'shopflo'
                END                                                        AS source,
                get_json_object(payload, '$.properties.order_id')          AS order_id,
                get_json_object(payload, '$.properties.risk_flag')         AS risk_flag,
                CAST(get_json_object(payload, '$.properties.total_price_minor')    AS bigint) AS total_price_minor,
                CAST(get_json_object(payload, '$.properties.total_discount_minor') AS bigint) AS total_discount_minor,
                CASE WHEN get_json_object(payload, '$.properties.has_address') = 'true'
                     THEN true ELSE false END                              AS has_address,
                get_json_object(payload, '$.properties.currency_code')     AS currency_code,
                CASE WHEN get_json_object(payload, '$.properties.data_source') = 'synthetic'
                     THEN true ELSE false END                              AS is_synthetic
            FROM raw
        ),
        deduped AS (
            SELECT *,
                row_number() OVER (
                    PARTITION BY brand_id, event_id
                    ORDER BY occurred_at ASC
                ) AS _dedup_rn
            FROM typed
        )
        SELECT
            brand_id,
            event_id,
            signal_type,
            source,
            order_id,
            risk_flag,
            total_price_minor,
            total_discount_minor,
            has_address,
            currency_code,
            occurred_at,
            is_synthetic,
            current_timestamp() AS updated_at
        FROM deduped
        WHERE _dedup_rn = 1
          -- silver_checkout_signal mart TTL/partition guard (interval {TTL_DAYS} day):
          AND occurred_at IS NOT NULL
          AND occurred_at >= date_sub(current_timestamp(), {TTL_DAYS})
        """
    )


def run(spark: SparkSession) -> None:
    create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        "silver_checkout_signal",
        _COLUMNS,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )

    df = _build_signal_df(spark)
    df.createOrReplaceTempView("silver_checkout_signal_batch")

    # Idempotent MERGE on the model PK (brand_id, event_id). WHEN MATCHED UPDATE keeps the row current
    # on re-run (the dedup already collapsed to 1 row per PK, so the inner row_number guard is belt+braces).
    spark.sql(
        f"""
        MERGE INTO {SILVER_TABLE} t
        USING (
            SELECT * FROM (
                SELECT *, row_number() OVER (
                    PARTITION BY brand_id, event_id ORDER BY occurred_at ASC
                ) AS _rn FROM silver_checkout_signal_batch
            ) WHERE _rn = 1
        ) s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET
            t.signal_type = s.signal_type,
            t.source = s.source,
            t.order_id = s.order_id,
            t.risk_flag = s.risk_flag,
            t.total_price_minor = s.total_price_minor,
            t.total_discount_minor = s.total_discount_minor,
            t.has_address = s.has_address,
            t.currency_code = s.currency_code,
            t.occurred_at = s.occurred_at,
            t.is_synthetic = s.is_synthetic,
            t.updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
            brand_id, event_id, signal_type, source, order_id, risk_flag,
            total_price_minor, total_discount_minor, has_address, currency_code,
            occurred_at, is_synthetic, updated_at
        ) VALUES (
            s.brand_id, s.event_id, s.signal_type, s.source, s.order_id, s.risk_flag,
            s.total_price_minor, s.total_discount_minor, s.has_address, s.currency_code,
            s.occurred_at, s.is_synthetic, s.updated_at
        )
        """
    )
    print(f"[silver_checkout_signal] MERGE done — {SILVER_TABLE} now has {spark.table(SILVER_TABLE).count()} rows", flush=True)


def main() -> None:
    spark = build_spark("silver-checkout-signal")
    spark.sparkContext.setLogLevel("WARN")
    run(spark)


if __name__ == "__main__":
    main()
