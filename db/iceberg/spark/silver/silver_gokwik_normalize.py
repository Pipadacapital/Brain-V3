"""
silver_gokwik_normalize.py — ADR-0006 P4: normalize RAW GoKwik records in Spark Silver.

Mirrors the Shopify exemplar (silver_shopify_order_normalize.py) EXACTLY, for the GoKwik source:
reads the RAW GoKwik Bronze (brain_bronze.gokwik_events_raw — the Kafka-Connect Iceberg sink output of
the verbatim provider records the connector now emits) and produces the canonical
`gokwik.awb_status.v1` + `gokwik.rto_predict.v1` rows the logistics/CoD marts consume — REPLACING the TS
@brain/gokwik-mapper normalization (mapGokwikAwb / mapGokwikRtoPredict) that the connector used to do
before emitting a canonical event. The connector now emits the verbatim GoKwik record; ALL normalization
happens HERE (ADR-0006 D3).

TWO SEAMS in ONE raw table, discriminated by `record_type`:
  - record_type='awb'         → gokwik.awb_status.v1  (AWB lifecycle; awb_number_hash via salt-HEX bytes,
                                terminal_class from the @brain/logistics-status authority). Read by
                                silver_shipment_event, silver_cod_rto (actual), silver_order_state.
  - record_type='rto_predict' → gokwik.rto_predict.v1 (CATEGORICAL risk_flag — NEVER a fabricated number;
                                verbatim risk_flag_raw + a closed-set risk_flag). Read by silver_cod_rto
                                (predicted) + silver_checkout_signal.

Output: the SAME column contract as silver_collector_event (the gated collector lane), so the marts above
read it with ZERO change — `payload` is the reconstructed canonical envelope (event_name + properties.*),
event_type = the canonical event name, brand_id server-trusted from the envelope.

CORRECTNESS: every primitive goes through the SHARED, GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py
(uuid_shaped, hash_salted_bytes, iso_ms) — udf-wrapped → Spark output == verified Python == the TS. The
GoKwik-specific bits not yet in the shared framework (logistics-status classification, risk-flag/payment
normalizers, the two event_id seeds) are LOCAL pure ports below (listed in new_framework_primitives_needed
for later consolidation into _raw_normalize.py) and are themselves golden-verified by test_gokwik-golden.py.

HASHING CONVENTION (CRITICAL): awb_number uses hash_salted_bytes — sha256( bytes.fromhex(salt) ++
utf8(lower(trim(awb))) ), salt as HEX BYTES with NO separator — IDENTICAL to @brain/gokwik-mapper
hashAwbNumber. (NOT hash_identifier, which is the email/phone `salt || '||' || normalized` convention.)

MONEY: this source carries no money column (the CoD/RTO ledger effect is downstream). PII: hashed-only —
the raw AWB is consumed by the hash and dropped; order_id is the ledger spine key, NOT PII. brand_id is the
tenant key, first column, taken ONLY from the server-trusted envelope (MT-1) — never the GoKwik body.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against
the live canonical silver_collector_event GoKwik rows before the connector cutover.

STAGE-1 GATE (Brain V4 two-stage): both seams used to SILENTLY DROP a record whose order_id was empty (the
mapper THROWS), whose event_id could not be seeded, or whose timestamp was unparseable. Those inline drops
(`_build_awb` / `_build_rto` where-gates) are now ROUTED through _silver_technical.write_quarantine
(stage='dq') to brain_silver.silver_quarantine: empty order_id → empty_identifier:order_id, un-seedable
event_id → empty_identifier:event_id, unparseable status/occurred ts → unparseable_timestamp. The admitted
set is IDENTICAL per seam (good rows byte-identical / parity-faithful); the diagnostic payload carries only
NON-PII fields (the raw AWB is the hash input — NEVER threaded), and Bronze keeps the untouched original.
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import coalesce, col, concat_ws, get_json_object, lit, to_json, struct, udf, when  # noqa: E402
from pyspark.sql.types import BooleanType, StringType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine  # noqa: E402
import _raw_normalize as rn
from _raw_normalize import classify_terminal_class as _classify_shipment_status, normalize_status as _normalize_status  # consolidated primitives (ADR-0006)  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}." + os.environ.get("RAW_TABLE", "gokwik_events_raw")
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at cutover (P3-for-gokwik).
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get("TARGET_TABLE", "silver_collector_event_gokwik_shadow")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")

AWB_EVENT = "gokwik.awb_status.v1"
RTO_PREDICT_EVENT = "gokwik.rto_predict.v1"

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

# ╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
# ║ LOCAL PORTS — GoKwik-specific primitives NOT (yet) in _raw_normalize.py. PURE PYTHON, byte-for-byte ║
# ║ ports of the TS (@brain/logistics-status + @brain/gokwik-mapper). Golden-verified by               ║
# ║ test_gokwik-golden.py. DEFINED IDENTICALLY in that test (per ADR-0006 P4: do NOT edit the shared    ║
# ║ _raw_normalize.py concurrently). Candidates for consolidation → new_framework_primitives_needed.    ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════════╝

# ── @brain/logistics-status: the SHARED status→terminal_class authority (deterministic, no model) ─────
def normalize_status(raw):
    """Fold a raw vendor status to canonical lowercase, single-spaced form — mirrors normalizeStatus:
    (raw ?? '').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\\s+/g,' ')."""
    s = (raw or "").strip().lower()
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s


# Terminal-state sets — union of GoKwik + Shiprocket vocabularies (frozen authority; GoKwik is a subset).
_RTO_TERMINAL_STATES = {
    "rto", "rto initiated", "rto in transit", "rto undelivered", "rto out for delivery", "rto delivered",
    "rto ofd", "rto acknowledged", "rto rejected", "rto ndr", "rto disposed",
}
_DELIVERED_TERMINAL_STATES = {"delivered", "completed"}
_OTHER_TERMINAL_STATES = {
    "cancelled", "lost", "damaged", "returned", "canceled", "destroyed", "disposed", "disposed of",
}


def classify_shipment_status(raw_status):
    """classifyShipmentStatus — 'rto' | 'delivered' | 'other' | 'none' (case/_/-/space-insensitive)."""
    s = normalize_status(raw_status)
    if s in _RTO_TERMINAL_STATES:
        return "rto"
    if s in _DELIVERED_TERMINAL_STATES:
        return "delivered"
    if s in _OTHER_TERMINAL_STATES:
        return "other"
    return "none"


def is_terminal_status(raw_status):
    return classify_shipment_status(raw_status) != "none"


# ── @brain/gokwik-mapper: payment-method + risk-flag normalizers ──────────────────────────────────────
def resolve_payment_method(raw):
    """resolvePaymentMethod — 'cod' | 'prepaid' | None."""
    s = (raw or "").strip().lower()
    if s in ("cod", "cash_on_delivery", "cash on delivery"):
        return "cod"
    if s in ("prepaid", "online", "paid"):
        return "prepaid"
    return None


def normalize_risk_flag(raw):
    """normalizeRiskFlag — closed set high|medium|low|control|unknown (substring match, TS order)."""
    s = (raw or "").strip().lower()
    if "high" in s:
        return "high"
    if "medium" in s or "med" in s:
        return "medium"
    if "low" in s:
        return "low"
    if "control" in s:
        return "control"
    return "unknown"


# ── @brain/gokwik-mapper: the two deterministic event_id seeds (over the shared uuid_shaped) ───────────
def event_id_awb(brand_id, raw_awb, raw_status, status_changed_at_iso):
    """uuidV5FromAwb(brandId, awbNumber, status, statusChangedAt) — DISTINCT per (awb,status,changed_at).
    The connector seeds with the UNtrimmed raw awb/status (gokwik-awb-repull run.ts) + the ISO-normalized
    status_changed_at (mapped.properties.status_changed_at). Reuses rn.uuid_shaped (== hashToUuidShaped)."""
    return rn.uuid_shaped(f"{brand_id}:{raw_awb}:{raw_status}:{status_changed_at_iso}:{AWB_EVENT}")


def event_id_rto_predict(brand_id, order_id, request_id):
    """uuidV5FromRtoPredict(brandId, orderId, requestId) — one event per prediction call."""
    return rn.uuid_shaped(f"{brand_id}:{order_id}:{request_id}:{RTO_PREDICT_EVENT}")


def hash_awb(raw_awb, salt_hex):
    """hashAwbNumber — sha256( bytes.fromhex(salt) ++ utf8(lower(trim(awb))) ). Returns None for a
    missing/blank awb (mirrors `rawAwb ? hashAwbNumber(...) : null` where rawAwb = trim). Delegates the
    crypto to rn.hash_salted_bytes so the convention stays single-sourced."""
    if raw_awb is None or str(raw_awb).strip() == "":
        return None
    return rn.hash_salted_bytes(raw_awb, salt_hex)


# ── UDFs over the verified ports (Spark output == verified python == TS) ───────────────────────────────
u_hash_awb = udf(lambda v, salt: hash_awb(v, salt) if salt else None, StringType())
u_classify = udf(lambda s: classify_shipment_status(s), StringType())
u_is_terminal = udf(lambda s: classify_shipment_status(s) != "none", BooleanType())
u_payment = udf(lambda v: resolve_payment_method(v), StringType())
u_risk_flag = udf(lambda v: normalize_risk_flag(v), StringType())
u_iso1 = udf(lambda a: rn.iso_ms(a) if a else None, StringType())
u_eid_awb = udf(
    lambda brand, awb, status, iso: event_id_awb(brand, awb, status, iso) if (brand and iso) else None,
    StringType(),
)
u_eid_rto = udf(
    lambda brand, oid, rid: event_id_rto_predict(brand, oid, rid) if (brand and oid) else None,
    StringType(),
)


def _read_base(spark: SparkSession):
    """The raw GoKwik envelope: server-trusted brand_id (MT-1), the ingestion clock, the seam
    discriminator, the dev-honesty provenance, and the verbatim provider record as a JSON string
    (get_json_object reads each field — robust to the two heterogeneous AWB/RTO shapes in one table)."""
    raw = spark.table(RAW_TABLE)
    return raw.select(
        col("brand_id").cast("string").alias("brand_id"),               # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        col("record_type").cast("string").alias("record_type"),
        coalesce(col("data_source").cast("string"), lit("real")).alias("data_source"),
        col("record").cast("string").alias("rec"),                      # verbatim GoKwik record (JSON)
    )


def _build_awb(spark: SparkSession, base, salts):
    """gokwik.awb_status.v1 — normalize the AWB-lifecycle records into canonical Silver rows."""
    df = base.where(col("record_type") == lit("awb")).select(
        col("brand_id"), col("fetched_at"), col("data_source"),
        # event_id seeds use the UNtrimmed raw awb/status (run.ts: `record.x ? String(record.x) : ''`).
        coalesce(get_json_object(col("rec"), "$.awb_number"), lit("")).alias("raw_awb"),
        coalesce(get_json_object(col("rec"), "$.status"), lit("")).alias("raw_status"),
        get_json_object(col("rec"), "$.order_id").alias("order_id"),
        get_json_object(col("rec"), "$.status_changed_at").alias("status_changed_at"),
        get_json_object(col("rec"), "$.payment_method").alias("payment_method_raw"),
        get_json_object(col("rec"), "$.pincode").alias("pincode_raw"),
    )
    df = df.join(salts.hint("broadcast"), "brand_id", "left")

    canon = (
        df
        # properties.status is the TRIMMED raw status (mapper: String(record.status ?? '').trim()).
        .withColumn("prop_status", rn_trim_udf(col("raw_status")))
        .withColumn("status_changed_at_iso", u_iso1(col("status_changed_at")))
        .withColumn("awb_number_hash", u_hash_awb(col("raw_awb"), col("salt_hex")))
        .withColumn("terminal_class", u_classify(col("prop_status")))
        .withColumn("is_terminal", u_is_terminal(col("prop_status")))
        .withColumn("payment_method", u_payment(col("payment_method_raw")))
        .withColumn("pincode", rn_trim_null_udf(col("pincode_raw")))
        .withColumn("order_id", rn_trim_udf(col("order_id")))
        .withColumn("event_id", u_eid_awb(col("brand_id"), col("raw_awb"), col("raw_status"), col("status_changed_at_iso")))
    )

    # ── Stage-1 DQ gate: the mapper THROWS on a missing order_id; route that + un-seedable id / unparseable
    #    ts to brain_silver.silver_quarantine (stage='dq') instead of silently dropping. Same admission set.
    _ok = (col("order_id") != lit("")) & col("event_id").isNotNull() & col("status_changed_at_iso").isNotNull()
    _reason = concat_ws(
        ",",
        when(col("order_id") == lit(""), lit("empty_identifier:order_id")),
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("status_changed_at_iso").isNull(), lit("unparseable_timestamp")),
    )
    write_quarantine(
        spark,
        canon.where(~_ok).select(
            col("brand_id"),
            lit("gokwik").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
            _reason.alias("reason"),
            to_json(struct(
                col("data_source"), col("order_id"), col("prop_status"), col("terminal_class"),
                col("payment_method"), col("pincode"), col("status_changed_at_iso"),
            )).alias("payload"),
        ),
        stage="dq",
    )
    canon = canon.where(_ok)

    props = struct(
        lit("gokwik").alias("source"),
        col("data_source").alias("data_source"),
        col("awb_number_hash").alias("awb_number_hash"),
        col("order_id").alias("order_id"),
        col("prop_status").alias("status"),
        col("terminal_class").alias("terminal_class"),
        col("is_terminal").alias("is_terminal"),
        col("payment_method").alias("payment_method"),
        col("pincode").alias("pincode"),
        col("status_changed_at_iso").alias("status_changed_at"),
        col("status_changed_at_iso").alias("occurred_at"),
    )
    return _to_collector_event(canon, AWB_EVENT, col("status_changed_at_iso"), props)


def _build_rto(spark: SparkSession, base):
    """gokwik.rto_predict.v1 — normalize the RTO-Predict risk records (categorical, never a number)."""
    df = base.where(col("record_type") == lit("rto_predict")).select(
        col("brand_id"), col("fetched_at"), col("data_source"),
        get_json_object(col("rec"), "$.order_id").alias("raw_order_id"),
        get_json_object(col("rec"), "$.request_id").alias("raw_request_id"),
        get_json_object(col("rec"), "$.risk_flag").alias("risk_flag_raw_in"),
        get_json_object(col("rec"), "$.risk_reason").alias("risk_reason"),
        get_json_object(col("rec"), "$.occurred_at").alias("occurred_at_in"),
    )

    canon = (
        df
        .withColumn("order_id", rn_trim_udf(col("raw_order_id")))
        .withColumn("request_id", rn_trim_null_udf(col("raw_request_id")))
        .withColumn("risk_flag_raw", rn_trim_null_udf(col("risk_flag_raw_in")))
        .withColumn("risk_flag", u_risk_flag(col("risk_flag_raw_in")))
        .withColumn("occurred_at_iso", u_iso1(col("occurred_at_in")))
        # event_id seed uses the raw (untrimmed) order_id/request_id, as the command does.
        .withColumn("event_id", u_eid_rto(col("brand_id"), coalesce(col("raw_order_id"), lit("")), coalesce(col("raw_request_id"), lit(""))))
    )

    # ── Stage-1 DQ gate: route empty order_id / un-seedable id / unparseable occurred_at to
    #    brain_silver.silver_quarantine (stage='dq') instead of silently dropping. Same admission set.
    _ok = (col("order_id") != lit("")) & col("event_id").isNotNull() & col("occurred_at_iso").isNotNull()
    _reason = concat_ws(
        ",",
        when(col("order_id") == lit(""), lit("empty_identifier:order_id")),
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("occurred_at_iso").isNull(), lit("unparseable_timestamp")),
    )
    write_quarantine(
        spark,
        canon.where(~_ok).select(
            col("brand_id"),
            lit("gokwik").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
            _reason.alias("reason"),
            to_json(struct(
                col("data_source"), col("order_id"), col("request_id"), col("risk_flag"),
                col("risk_flag_raw"), col("risk_reason"), col("occurred_at_iso"),
            )).alias("payload"),
        ),
        stage="dq",
    )
    canon = canon.where(_ok)

    props = struct(
        lit("gokwik").alias("source"),
        col("data_source").alias("data_source"),
        col("order_id").alias("order_id"),
        col("request_id").alias("request_id"),
        col("risk_flag").alias("risk_flag"),
        col("risk_flag_raw").alias("risk_flag_raw"),
        col("risk_reason").alias("risk_reason"),
        col("occurred_at_iso").alias("occurred_at"),
    )
    return _to_collector_event(canon, RTO_PREDICT_EVENT, col("occurred_at_iso"), props)


def _to_collector_event(canon, event_name, occurred_at_iso_col, props):
    """Reconstruct the canonical envelope as the `payload` JSON the marts get_json_object, projected to
    the silver_collector_event column contract (event_type = the canonical event name)."""
    envelope = to_json(struct(
        lit(event_name).alias("event_name"),
        occurred_at_iso_col.alias("occurred_at"),
        props.alias("properties"),
    ))
    return canon.select(
        col("event_id"),
        col("brand_id"),
        occurred_at_iso_col.cast("timestamp").alias("occurred_at"),
        col("fetched_at").cast("timestamp").alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit(event_name).alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("partition_key"),
        envelope.alias("payload"),
    )


def build(spark: SparkSession):
    create_iceberg_table(spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
                         partitioned_by="bucket(256, brand_id), days(occurred_at)")

    base = _read_base(spark)
    salts = _load_salts(spark)

    awb = _build_awb(spark, base, salts)
    rto = _build_rto(spark, base)
    out = awb.unionByName(rto)

    out.createOrReplaceTempView("_gokwik_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING (
            SELECT * FROM (
                SELECT *, row_number() OVER (
                    PARTITION BY brand_id, event_id ORDER BY occurred_at ASC
                ) AS _rn FROM _gokwik_canon
            ) WHERE _rn = 1
        ) s
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


# Small string udfs (JS .trim() semantics; trim-to-null for nullable provenance fields).
rn_trim_udf = udf(lambda s: (s or "").strip(), StringType())
rn_trim_null_udf = udf(lambda s: (s.strip() if s is not None else None), StringType())


def main() -> None:
    import time

    spark = build_spark("silver-gokwik-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-gokwik-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-gokwik-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-gokwik-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
