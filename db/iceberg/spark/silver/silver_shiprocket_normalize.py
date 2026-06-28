"""
silver_shiprocket_normalize.py — ADR-0006 P4: normalize RAW Shiprocket shipment-tracking rows in Spark Silver.

══════════════════════════════════════════════════════════════════════════════════════════════════════
SR-8 DECISION (Brain V4, finalized) — KEEP AS A DUAL-RUN PARITY SHADOW; NOT ON THE LIVE PATH.
──────────────────────────────────────────────────────────────────────────────────────────────────────
This job stays a SHADOW: by default it writes to silver_collector_event_shiprocket_shadow (TARGET_TABLE
override) and is GUARDED to skip when its raw lane (brain_bronze.shiprocket_shipments_raw) is empty — which it is
today, because the LIVE boundary is the TS mapper (@brain/shiprocket-mapper), which emits the canonical
`shiprocket.shipment_status.v1` directly onto the collector lane. We do NOT cut this onto the live path now; we
keep it as the ADR-0006 verbatim→canonical parity oracle so a future connector-emits-verbatim cutover can be
proven byte-identical before flipping. RETIREMENT is deferred, not chosen.

LOCKSTEP OBLIGATION (why this file is in Slice 3's lane): its LOCAL port of the @brain/logistics-status authority
MUST track the TS authority. As of SR-5 it carries _EXCEPTION + _classify_exception + the additive
`exception_class` field — kept byte-aligned with packages/logistics-status/src/index.ts (EXCEPTION_STATES /
classifyException) and with silver_shipment_event.py's exception_class projection. The 3 FROZEN terminal sets
(_RTO_TERMINAL / _DELIVERED_TERMINAL / _OTHER_TERMINAL) are UNCHANGED (GoKwik parity).

RETURNS (SR-4) ARE OUT OF SCOPE HERE — BY DESIGN. This shadow reads only the FORWARD shipment raw lane
(shiprocket_shipments_raw → ShiprocketShipmentProperties). The RETURN family flows on the DISJOINT canonical
event `shiprocket.return_status.v1` (classifyReturnStatus, never classifyShipmentStatus) into the dedicated
silver_return mart. There is therefore NO RETURN_* class to port into this forward-only normalizer; adding one
here would be wrong (it would risk a return re-entering the forward terminal_class authority).
══════════════════════════════════════════════════════════════════════════════════════════════════════

Reads the RAW Shiprocket shipment Bronze (brain_bronze.shiprocket_shipments_raw, written by the Kafka
Connect Iceberg sink from {env}.shiprocket.shipments.raw.v1) and produces the canonical
shiprocket.shipment_status.v1 rows the shipment marts consume — replacing the TS
@brain/shiprocket-mapper::mapShiprocketShipment normalization (which the connector used to do before
emitting a canonical event). The connector now emits the verbatim provider shipment record; ALL
normalization happens HERE (ADR-0006 D3). Mirrors the Shopify exemplar exactly.

Output: the SAME column contract as silver_collector_event (the gated collector lane), so
silver_shipment_event reads it with ZERO change — `payload` is the reconstructed canonical
shiprocket.shipment_status.v1 envelope (event_name + properties.*), event_type='shiprocket.shipment_status.v1',
brand_id server-trusted from the envelope (MT-1).

CORRECTNESS: every field goes through the SHARED, GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py
(udf-wrapped → Spark output == the verified Python == the TS), so Silver-from-raw is byte-identical to the
old canonical Silver. LOGISTICS IS MONEY-FREE — there is no money column; the parity analogue is the
terminal_class multiset. PII = the AWB only, hashed via hash_salted_bytes (the salt-HEX-bytes convention,
== @brain/shiprocket-mapper.hashAwbNumber); the raw AWB is dropped.

CONNECTOR-LOCAL PORT: the status->terminal_class authority (@brain/logistics-status — 3 FROZEN label sets)
is NOT a shared _raw_normalize primitive, so it is ported LOCALLY here (and in test_shiprocket-golden.py),
kept in lockstep with packages/logistics-status/src/index.ts. See new_framework_primitives_needed for the
later consolidation into the shared framework.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against
the live canonical silver_collector_event shiprocket rows before the connector cutover. brand_id is the
tenant key, first column, taken ONLY from the server-trusted envelope (MT-1) — never the provider body.

STAGE-1 GATE (Brain V4 two-stage): the mapper THROWS on an empty order_id (the ledger spine key), which the
inline `.where(event_id & occurred_at_iso & order_id_norm non-empty)` gate then SILENTLY DROPPED. Those
drops are now ROUTED through _silver_technical.write_quarantine (stage='dq') to brain_silver.silver_quarantine:
empty order_id → empty_identifier:order_id, un-seedable event_id → empty_identifier:event_id, unparseable
status_changed_at → unparseable_timestamp. The admitted set is IDENTICAL (good rows byte-identical /
parity-faithful); logistics is MONEY-FREE and the diagnostic payload carries only NON-PII fields (the raw
AWB is the hash input — NEVER threaded), and Bronze keeps the untouched original (replay-safe).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import col, concat_ws, lit, to_json, struct, udf, when  # noqa: E402
from pyspark.sql.types import BooleanType, StringType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine  # noqa: E402
import _raw_normalize as rn
from _raw_normalize import classify_terminal_class as _classify_shipment_status, normalize_status as _normalize_status  # consolidated primitives (ADR-0006)  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.shiprocket_shipments_raw"
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at the shipment-lane cutover.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_shiprocket_shadow"
)
# The verbatim Shiprocket record is nested under this key in the raw envelope (the connector wraps it,
# parallel to Shopify's `order`). Override if the sink uses a different wrapper key.
RECORD_KEY = os.environ.get("SHIPROCKET_RECORD_KEY", "shipment")

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

# ── Connector-local port of @brain/logistics-status (FROZEN authority — keep in lockstep with
#    packages/logistics-status/src/index.ts AND _p4_golden/test_shiprocket-golden.py). NOT in
#    _raw_normalize.py (a concurrently-edited shared file). See new_framework_primitives_needed. ─────────
_RTO_TERMINAL = {
    "rto", "rto initiated", "rto in transit", "rto undelivered", "rto out for delivery",
    "rto delivered", "rto ofd", "rto acknowledged", "rto rejected", "rto ndr", "rto disposed",
}
_DELIVERED_TERMINAL = {"delivered", "completed"}
_OTHER_TERMINAL = {
    "cancelled", "lost", "damaged", "returned", "canceled", "destroyed", "disposed", "disposed of",
}
# SR-5: NON-TERMINAL exception/NDR sub-class — kept in lockstep with @brain/logistics-status
# (EXCEPTION_STATES + classifyException). 'delayed' → 'delayed'; NDR / undelivered / delivery
# exception → 'ndr'; else null. A SEPARATE dimension — it does NOT alter terminal_class.
_EXCEPTION = {
    "delayed", "exception", "ndr", "undelivered",
    "address issue", "customer unavailable", "failed delivery attempt",
}


def _classify_exception(raw):
    s = _normalize_status(raw)
    if s == "delayed":
        return "delayed"
    if s in _EXCEPTION:
        return "ndr"
    return None






def _resolve_payment_method(raw):
    s = (raw or "").strip().lower()
    if s in ("cod", "cash_on_delivery", "cash on delivery"):
        return "cod"
    if s in ("prepaid", "online", "paid"):
        return "prepaid"
    return None


def _event_id_shipment(brand_id, awb, status, status_changed_at_iso):
    """uuidV5FromShipment(brand, awb, status, statusChangedAt) — mirrors the shiprocket-shipment-repull
    seed: raw (untrimmed) awb/status + the ISO-normalized status_changed_at."""
    return rn.uuid_shaped(
        f"{brand_id}:{awb}:{status}:{status_changed_at_iso}:shiprocket.shipment_status.v1"
    )


# ── UDFs over the verified shared ports + the connector-local logistics-status port ───────────────────
u_iso = udf(lambda a: rn.iso_ms(a) if a else None, StringType())
u_awb_hash = udf(lambda v, salt: rn.hash_salted_bytes(v, salt) if v else None, StringType())
u_classify = udf(lambda s: _classify_shipment_status(s), StringType())
u_is_terminal = udf(lambda s: _classify_shipment_status(s) != "none", BooleanType())
u_exception = udf(lambda s: _classify_exception(s), StringType())
u_payment = udf(lambda s: _resolve_payment_method(s), StringType())
u_eid = udf(
    lambda brand, awb, status, sca: _event_id_shipment(brand, awb, status, sca)
    if (brand and sca) else None,
    StringType(),
)


def build(spark: SparkSession):
    create_iceberg_table(
        spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )

    raw = spark.table(RAW_TABLE)
    # Skip-guard: connector raw lanes are EMPTY until a connector syncs + the V4 raw-lane producer (G1)
    # lands payload-schema records. No source rows → nothing to normalize; return cleanly instead of
    # failing on the legacy struct columns this job still reads. Full payload-JSON normalize is G1.
    if raw.limit(1).count() == 0:
        print(f"[silver-shiprocket-normalize] {RAW_TABLE} has 0 rows — skipping (awaiting connector data / G1)", flush=True)
        return TARGET, 0
    r = RECORD_KEY  # verbatim Shiprocket record nested under `shipment` (connector wraps it; MT-1 envelope)

    df = raw.select(
        col("brand_id").cast("string").alias("brand_id"),               # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        # data_source provenance (DEV-HONESTY) — envelope-level if present, else 'real'.
        col("data_source").cast("string").alias("data_source") if "data_source" in raw.columns
        else lit("real").alias("data_source"),
        col(f"{r}.awb").cast("string").alias("awb"),
        col(f"{r}.order_id").cast("string").alias("order_id"),
        col(f"{r}.status").cast("string").alias("status"),
        col(f"{r}.status_changed_at").cast("string").alias("status_changed_at"),
        col(f"{r}.payment_method").cast("string").alias("payment_method"),
        col(f"{r}.pincode").cast("string").alias("pincode"),
        col(f"{r}.courier").cast("string").alias("courier"),
    )

    # Per-brand salt (the keystone) — broadcast join on brand_id (re-uses the JDBC salt SoR, single read).
    salts = _load_salts(spark)
    df = df.join(salts.hint("broadcast"), "brand_id", "left")

    # raw (untrimmed) seed components mirror the repull: String(record.awb)/String(record.status) or ''.
    from pyspark.sql.functions import coalesce, trim
    raw_awb = coalesce(col("awb"), lit(""))
    raw_status = coalesce(col("status"), lit(""))

    canon = (
        df.withColumn("occurred_at_iso", u_iso(col("status_changed_at")))
        .withColumn("order_id_norm", trim(col("order_id")))
        .withColumn("status_norm", trim(col("status")))
        .withColumn("terminal_class", u_classify(col("status")))
        .withColumn("is_terminal", u_is_terminal(col("status")))
        .withColumn("exception_class", u_exception(col("status")))
        .withColumn("payment_method_norm", u_payment(col("payment_method")))
        .withColumn("awb_number_hash", u_awb_hash(trim(col("awb")), col("salt_hex")))
        .withColumn("pincode_norm", trim(col("pincode")))
        .withColumn("courier_norm", trim(col("courier")))
        .withColumn("event_id", u_eid(col("brand_id"), raw_awb, raw_status, col("occurred_at_iso")))
    )

    # ── Stage-1 DQ gate: order_id is the ledger spine key (mapper THROWS on empty); route that + un-seedable
    #    id / unparseable ts to brain_silver.silver_quarantine (stage='dq') instead of silently dropping.
    #    Same admission set; good rows byte-identical; NON-PII diagnostic payload (raw AWB never threaded).
    _ok = (
        col("event_id").isNotNull()
        & col("occurred_at_iso").isNotNull()
        & (col("order_id_norm").isNotNull() & (col("order_id_norm") != lit("")))
    )
    _reason = concat_ws(
        ",",
        when(col("order_id_norm").isNull() | (col("order_id_norm") == lit("")), lit("empty_identifier:order_id")),
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("occurred_at_iso").isNull(), lit("unparseable_timestamp")),
    )
    write_quarantine(
        spark,
        canon.where(~_ok).select(
            col("brand_id"),
            lit("shiprocket").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
            _reason.alias("reason"),
            to_json(struct(
                col("order_id_norm"), col("status_norm"), col("terminal_class"),
                col("payment_method_norm"), col("pincode_norm"), col("courier_norm"),
                col("occurred_at_iso"),
            )).alias("payload"),
        ),
        stage="dq",
    )
    canon = canon.where(_ok)

    # Reconstruct the canonical shiprocket.shipment_status.v1 envelope as the `payload` JSON the
    # shipment mart get_json_object's. Field shape == ShiprocketShipmentProperties.
    props = struct(
        lit("shiprocket").alias("source"),
        col("data_source").alias("data_source"),
        col("awb_number_hash").alias("awb_number_hash"),
        col("order_id_norm").alias("order_id"),
        col("status_norm").alias("status"),
        col("terminal_class").alias("terminal_class"),
        col("is_terminal").alias("is_terminal"),
        col("exception_class").alias("exception_class"),  # SR-5 — non-terminal NDR/delay signal (additive)
        col("payment_method_norm").alias("payment_method"),
        col("pincode_norm").alias("pincode"),
        col("courier_norm").alias("courier"),
        col("occurred_at_iso").alias("status_changed_at"),
        col("occurred_at_iso").alias("occurred_at"),
    )
    envelope = to_json(struct(
        lit("shiprocket.shipment_status.v1").alias("event_name"),
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
        lit("shiprocket.shipment_status.v1").alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        envelope.alias("payload"),
    ).withColumn("partition_key", col("brand_id"))

    out.createOrReplaceTempView("_shiprocket_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _shiprocket_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def _load_salts(spark: SparkSession):
    """(brand_id, salt_hex) for the AWB hash. Dev-derivable; prod reads the KMS-unwrapped per-brand salt.
    Mirrors the SoR the connector used so the hash matches. Override SALT_QUERY for the exact prod fn."""
    url = os.environ.get("BRONZE_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
    query = os.environ.get(
        "SALT_QUERY",
        "SELECT id::text AS brand_id, encode(sha256(('brain-dev-identity-salt-v1||'||lower(id::text))::bytea),'hex') AS salt_hex FROM tenancy.brand",
    )
    return (
        spark.read.format("jdbc").option("url", url)
        .option("user", os.environ.get("BRONZE_PG_USER", "brain"))
        .option("password", os.environ.get("BRONZE_PG_PASSWORD", "brain"))
        .option("driver", "org.postgresql.Driver").option("query", query).load()
    )


def main() -> None:
    import time

    spark = build_spark("silver-shiprocket-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-shiprocket-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-shiprocket-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-shiprocket-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
