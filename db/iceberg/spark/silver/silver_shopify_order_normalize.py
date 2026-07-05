"""
silver_shopify_order_normalize.py — ADR-0006 P4 EXEMPLAR: normalize RAW Shopify orders in Spark Silver.

Reads the RAW Shopify order Bronze (brain_bronze.shopify_orders_raw, written by the Kafka Connect Iceberg
sink from {env}.shopify.orders.raw.v1) and produces the canonical order.live.v1 rows the order marts
consume — replacing the TS @brain/shopify-mapper::mapOrderToEvent normalization (which the connector used
to do before emitting a canonical event). The connector now emits the verbatim provider order; ALL
normalization happens HERE (ADR-0006 D3).

Output: the SAME column contract as silver_collector_event (the gated collector lane), so silver_order_state
/ silver_order_line read it with ZERO change — `payload` is the reconstructed canonical order.live.v1
envelope (event_name + properties.*), event_type='order.live.v1', brand_id server-trusted from the envelope.

CORRECTNESS: every field goes through the SHARED, GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py
(udf-wrapped → Spark output == the verified Python == the TS), so Silver-from-raw is byte-identical to the
old canonical Silver on money (bigint minor + currency), hashed-PII, and the uuid-shaped event_id.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against
the live canonical silver_collector_event order rows before the connector cutover. brand_id is the tenant
key, first column, taken ONLY from the server-trusted envelope (MT-1) — never the provider body.

STAGE-1 GATE (Brain V4 two-stage): this normalizer used to SILENTLY DROP rows whose canonical money /
timestamp / event_id could not be derived (the `.where(event_id & amount_minor & occurred_at_iso
isNotNull)` admission gate). Those same drops are now ROUTED through _silver_technical.write_quarantine
(stage='dq') to brain_silver.silver_quarantine — observable + replayable — instead of vanishing:
malformed money → non_integer_amount, un-derivable occurred_at → unparseable_timestamp, un-seedable
event_id → empty_identifier:event_id. The ADMITTED set is IDENTICAL (same predicate), so good rows stay
byte-identical (parity-faithful); the quarantine payload carries only NON-PII source fields (raw
email/phone are never threaded — PII stays hash-only), and Bronze keeps the untouched original.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import col, concat_ws, lit, to_json, struct, udf, when  # noqa: E402
from pyspark.sql.types import LongType, StringType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine  # noqa: E402
import _raw_normalize as rn  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.shopify_orders_raw"
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at cutover (P3-for-orders).
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get("TARGET_TABLE", "silver_collector_event_shopify_shadow")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")

COLUMNS_SQL = """
  event_id          string  NOT NULL,
  brand_id          string  NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string  NOT NULL,
  schema_version    int     NOT NULL,
  event_type        string  NOT NULL,
  correlation_id    string,
  partition_key     string  NOT NULL,
  payload           string  NOT NULL
"""

# ── UDFs over the verified shared ports (Spark output == verified python == TS) ───────────────────────
u_minor = udf(lambda s: rn.decimal_to_minor_strict(s), LongType())
u_classify = udf(lambda g, names, fs: rn.classify_payment(g, names, fs), StringType())
u_hash_email = udf(lambda v, salt: rn.hash_identifier(v, "email", salt, REGION) if v else None, StringType())
u_hash_phone = udf(lambda v, salt: rn.hash_identifier(v, "phone", salt, REGION) if v else None, StringType())
u_iso = udf(lambda a, b, c: rn.iso_ms(a, b, c), StringType())
u_iso1 = udf(lambda a: rn.iso_ms(a) if a else None, StringType())
u_epoch = udf(lambda a: rn.epoch_ms(a) if a else None, LongType())
u_eid = udf(lambda brand, oid, ms: rn.event_id_order_live(brand, oid, ms) if (brand and oid and ms is not None) else None, StringType())


def build(spark: SparkSession):
    create_iceberg_table(spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
                         partitioned_by="bucket(256, brand_id), days(occurred_at)")

    raw = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "shopify_orders_raw", "shopify")
    # Skip-guard: the connector raw lanes are EMPTY until a connector syncs and the V4 raw-lane producer
    # (connector-platform gap G1) lands payload-schema records. With no source rows there is nothing to
    # normalize, so return cleanly (target already ensured above) instead of failing on the legacy struct
    # columns this job still reads. Full payload-JSON normalize is tracked as G1.
    if raw.limit(1).count() == 0:
        print(f"[silver-shopify-order-normalize] {RAW_TABLE} has 0 rows — skipping (awaiting connector data / G1)", flush=True)
        return TARGET, 0
    o = "order"  # the verbatim Shopify order is nested under `order` in the envelope (the connector wraps it)

    # Pull the fields the order marts need straight off the nested struct (or get_json_object if stored as JSON).
    df = raw.select(
        col("brand_id").cast("string").alias("brand_id"),               # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        col(f"{o}.id").cast("string").alias("order_id"),
        col(f"{o}.currency").cast("string").alias("currency_code"),
        col(f"{o}.current_total_price").cast("string").alias("price_str"),
        col(f"{o}.financial_status").cast("string").alias("financial_status"),
        col(f"{o}.fulfillment_status").cast("string").alias("fulfillment_status"),
        col(f"{o}.gateway").cast("string").alias("gateway"),
        col(f"{o}.payment_gateway_names").alias("gateway_names"),
        col(f"{o}.updated_at").cast("string").alias("updated_at"),
        col(f"{o}.processed_at").cast("string").alias("processed_at"),
        col(f"{o}.created_at").cast("string").alias("created_at"),
        col(f"{o}.cancelled_at").cast("string").alias("cancelled_at"),
        col(f"{o}.customer.email").cast("string").alias("cust_email"),
        col(f"{o}.customer.phone").cast("string").alias("cust_phone"),
    )

    # Per-brand salt (the keystone) — broadcast join on brand_id. (Re-uses the JDBC salt SoR; a single read.)
    salts = _load_salts(spark)
    df = df.join(salts.hint("broadcast"), "brand_id", "left")

    gated = (
        df.withColumn("occurred_at_iso", u_iso(col("updated_at"), col("processed_at"), col("created_at")))
        .withColumn("amount_minor", u_minor(col("price_str")))
        .withColumn("payment_method", u_classify(col("gateway"), col("gateway_names"), col("financial_status")))
        .withColumn("hashed_customer_email", u_hash_email(col("cust_email"), col("salt_hex")))
        .withColumn("hashed_customer_phone", u_hash_phone(col("cust_phone"), col("salt_hex")))
        .withColumn("cancelled_at_iso", u_iso1(col("cancelled_at")))
        .withColumn("event_id", u_eid(col("brand_id"), col("order_id"), u_epoch(col("updated_at"))))
    )

    # ── Stage-1 DQ gate: route the inline drops (un-seedable id / malformed money / unparseable ts) to
    #    brain_silver.silver_quarantine (stage='dq') instead of silently dropping. Same admission set; good
    #    rows byte-identical. Payload carries NON-PII source fields only; Bronze keeps the original.
    _ok = col("event_id").isNotNull() & col("amount_minor").isNotNull() & col("occurred_at_iso").isNotNull()
    _reason = concat_ws(
        ",",
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("amount_minor").isNull(), lit("non_integer_amount")),
        when(col("occurred_at_iso").isNull(), lit("unparseable_timestamp")),
    )
    write_quarantine(
        spark,
        gated.where(~_ok).select(
            col("brand_id"),
            lit("shopify").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
            _reason.alias("reason"),
            to_json(struct(
                col("order_id"), col("currency_code"), col("price_str"), col("financial_status"),
                col("fulfillment_status"), col("updated_at"), col("processed_at"), col("created_at"),
                col("cancelled_at"),
            )).alias("payload"),
        ),
        stage="dq",
    )
    canon = gated.where(_ok)

    # Reconstruct the canonical order.live.v1 envelope as the `payload` JSON the order marts get_json_object.
    props = struct(
        lit("shopify").alias("source"),
        col("order_id").alias("order_id"),
        col("order_id").alias("shopify_order_id"),
        col("amount_minor").cast("string").alias("amount_minor"),
        col("currency_code").alias("currency_code"),
        col("payment_method").alias("payment_method"),
        col("financial_status").alias("financial_status"),
        col("fulfillment_status").alias("fulfillment_status"),
        col("cancelled_at_iso").alias("cancelled_at"),
        col("hashed_customer_email").alias("hashed_customer_email"),
        col("hashed_customer_phone").alias("hashed_customer_phone"),
    )
    envelope = to_json(struct(
        lit("order.live.v1").alias("event_name"),
        col("occurred_at_iso").alias("occurred_at"),
        props.alias("properties"),
    ))

    out = canon.select(
        col("event_id"),
        col("brand_id"),
        col("occurred_at_iso").cast("timestamp").alias("occurred_at"),
        col("fetched_at").cast("timestamp").alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit("order.live.v1").alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("_b"),  # placeholder for partition_key build below
        envelope.alias("payload"),
    ).withColumn("partition_key", col("brand_id")).drop("_b")

    # ADR-0010: the append-only Connect Bronze can carry redelivered duplicates — collapse to one row
    # per (brand_id, event_id) or the MERGE below aborts on a source-cardinality violation.
    out = rn.dedupe_latest(out, ["brand_id", "event_id"], "ingested_at")
    out.createOrReplaceTempView("_shopify_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _shopify_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def _load_salts(spark: SparkSession):
    """(brand_id, salt_hex) for the PII hash. Dev-derivable; prod reads the KMS-unwrapped per-brand salt.
    Mirrors the SoR the connector used so the hash matches. Override SALT_QUERY for the exact prod fn."""
    url = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
    # NOT a get-with-default: the run scripts export SALT_QUERY="" (empty), and an empty env var
    # must still fall back to the dev-derivable salt query — an empty JDBC `query` option aborts the
    # read ("Option `query` can not be empty"; surfaced by the first ADR-0010 connect-mode run).
    query = os.environ.get("SALT_QUERY") or (
        "SELECT id::text AS brand_id, encode(sha256(('brain-dev-identity-salt-v1||'||lower(id::text))::bytea),'hex') AS salt_hex FROM tenancy.brand"
    )
    return (
        spark.read.format("jdbc").option("url", url)
        .option("user", os.environ.get("BRONZE_PG_USER", "brain"))
        .option("password", os.environ.get("BRONZE_PG_PASSWORD", "brain"))
        .option("driver", "org.postgresql.Driver").option("query", query).load()
    )


def main() -> None:
    import time

    spark = build_spark("silver-shopify-order-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-shopify-order-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-shopify-order-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-shopify-order-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
