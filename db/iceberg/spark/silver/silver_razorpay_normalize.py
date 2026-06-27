"""
silver_razorpay_normalize.py — ADR-0006 P4: normalize RAW Razorpay settlement items in Spark Silver.

Mirror of the PROVEN Shopify exemplar (silver_shopify_order_normalize.py). Reads the RAW Razorpay
settlement-recon Bronze (brain_bronze.razorpay_settlement_raw, written by the Kafka Connect Iceberg sink
from {env}.razorpay.raw.v1) and produces the canonical settlement.live.v1 rows the payments marts consume —
replacing the TS @brain/razorpay-mapper::mapSettlementItemToEvent normalization (which the connector used to
do before emitting a canonical event). The connector now emits the verbatim provider recon item; ALL
normalization happens HERE (ADR-0006 D3).

Output: the SAME column contract as silver_collector_event (the gated collector lane), so silver_settlement
reads it with ZERO change — `payload` is the reconstructed canonical settlement.live.v1 envelope
(event_name + properties.*), event_type='settlement.live.v1', brand_id server-trusted from the envelope.

CORRECTNESS: every field goes through the SHARED, GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py
(hash_salted_bytes, uuid_shaped — udf-wrapped) PLUS a few connector-local pure helpers that the framework
does not yet expose (paisa passthrough money, unix-seconds→ISO, the settlement event_id seeds). Those
locals are listed in the P4 report's new_framework_primitives_needed for later consolidation into the
shared framework, and are byte-verified against the real TS in _p4_golden/test_razorpay-golden.py.

MONEY: Razorpay amounts are ALREADY integer paisa (minor units) — a strict /^\\d+$/ passthrough, never a
float, never blended; emitted as bigint-minor-as-string with a sibling currency_code (I-S07).
PII (C1/DPDP): payment_id (pay_*) and utr are hashed in-Spark via hash_salted_bytes =
sha256( bytes.fromhex(salt) ++ utf8(lower(trim(value))) ) — the EXACT @brain/razorpay-mapper hashRazorpayId
convention. Raw identifiers are read only inside this job and NEVER stored. settlement_id / order_id are
opaque batch / native refs (not person-linkable) and pass through un-hashed.
PCI (C4/D4): card.* fields are NEVER selected off the raw item → they simply do not cross this boundary.
ISOLATION (MT-1): brand_id is the tenant key, first column, taken ONLY from the server-trusted envelope —
never the provider body.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against
the live canonical silver_collector_event settlement rows before the connector cutover.
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import coalesce, col, lit, struct, to_json, trim, udf, upper, when  # noqa: E402
from pyspark.sql.types import StringType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
import _raw_normalize as rn  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.razorpay_settlement_raw"
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at cutover (P3-for-settlement).
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_razorpay_shadow"
)
# The verbatim Razorpay settlement-recon item is nested under this envelope key (the connector wraps it,
# mirroring how the Shopify connector wraps the order under `order`).
NEST = os.environ.get("RAZORPAY_RAW_NEST", "settlement")

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

_ENTITY_TYPES = {"payment", "refund", "adjustment", "reserve_deduction"}


# ── Connector-local pure ports (NOT YET in _raw_normalize.py — see new_framework_primitives_needed) ───

def paisa_to_minor_string(value):
    """Port of @brain/razorpay-mapper paisaToMinorString. Razorpay sends amounts as INTEGER paisa
    (already minor units) — pure integer-string passthrough, NO float. null/'' → '0' (the TS default);
    a non-integer would THROW in TS, here we return None so the row is quarantined (the where-gate drops it)
    rather than crashing the batch or silently coercing a float."""
    if value is None:
        return "0"
    s = str(value).strip()
    if s == "":
        return "0"
    if not re.match(r"^\d+$", s):
        return None  # malformed → quarantine (never a float, never blended)
    return s


def razorpay_unix_to_iso(value):
    """Port of @brain/razorpay-mapper toIso. Razorpay created_at/settled_at are UNIX SECONDS (number or
    all-digit string) → new Date(v*1000).toISOString() (ms, 'Z'); a non-digit string is parsed as ISO.
    None/'' → None. Always the .mmm millisecond form so occurred_at parity is byte-exact."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    if re.match(r"^\d+$", s):
        dt = datetime.fromtimestamp(int(s), tz=timezone.utc)
    else:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def resolve_entity_type(raw):
    """Port of resolveEntityType: payment|refund|adjustment|reserve_deduction, default 'payment'."""
    v = (raw or "").strip().lower()
    return v if v in _ENTITY_TYPES else "payment"


def reconciliation_type(entity_type, raw_payment_id):
    """Port of the mapper's non-summary reconciliation path: no payment_id OR adjustment → 'brand_level',
    else 'per_order'. (isSummary is folded into the no-payment_id case for the recon lane.)"""
    if not raw_payment_id or entity_type == "adjustment":
        return "brand_level"
    return "per_order"


def settlement_event_id(brand_id, settlement_id, raw_payment_id, entity_type):
    """The server-side event_id the connector used to seed, re-derived from the server-trusted brand_id +
    the raw recon item. With a payment_id → the per-item seed (uuidV5FromSettlementItem); without one → the
    brand-level summary seed (uuidV5FromSettlementSummary). Both go through the SHARED, verified uuid_shaped
    port (sha256→16B→v5 nibble→RFC-4122 variant→8-4-4-4-12) so the dedup key is byte-identical to the TS."""
    if not (brand_id and settlement_id):
        return None
    if raw_payment_id:
        return rn.uuid_shaped(f"{brand_id}:{settlement_id}:{raw_payment_id}:{entity_type}:settlement.live.v1")
    return rn.uuid_shaped(f"{brand_id}:{settlement_id}:summary:settlement.live.v1")


# ── UDFs over the verified shared ports + the connector-local pure helpers ────────────────────────────
u_paisa = udf(lambda v: paisa_to_minor_string(v), StringType())
u_iso = udf(lambda v: razorpay_unix_to_iso(v), StringType())
u_entity = udf(lambda v: resolve_entity_type(v), StringType())
u_hash = udf(lambda v, salt: rn.hash_salted_bytes(v, salt) if v else None, StringType())  # shared port (C1)
u_eid = udf(lambda b, sid, pid, et: settlement_event_id(b, sid, pid, et), StringType())
u_recon = udf(lambda et, pid: reconciliation_type(et, pid), StringType())


def build(spark: SparkSession):
    create_iceberg_table(spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
                         partitioned_by="bucket(256, brand_id), days(occurred_at)")

    raw = spark.table(RAW_TABLE)
    s = NEST  # the verbatim Razorpay recon item is nested under `settlement` in the envelope

    # C4: only the allowlisted recon-item fields are selected; card.* is NEVER read → PCI boundary held.
    df = raw.select(
        col("brand_id").cast("string").alias("brand_id"),               # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        col(f"{s}.settlement_id").cast("string").alias("settlement_id"),
        col(f"{s}.payment_id").cast("string").alias("payment_id"),
        col(f"{s}.order_id").cast("string").alias("order_id"),
        col(f"{s}.amount").cast("string").alias("amount"),              # already integer paisa (minor)
        col(f"{s}.fee").cast("string").alias("fee"),
        col(f"{s}.tax").cast("string").alias("tax"),
        col(f"{s}.utr").cast("string").alias("utr"),
        col(f"{s}.status").cast("string").alias("status"),
        col(f"{s}.created_at").cast("string").alias("created_at"),
        col(f"{s}.settled_at").cast("string").alias("settled_at"),
        col(f"{s}.currency").cast("string").alias("currency"),
        col(f"{s}.entity_type").cast("string").alias("entity_type_raw"),
    )

    # Per-brand salt (the keystone) — broadcast join on brand_id. Re-uses the JDBC salt SoR (a single read);
    # hash_salted_bytes does bytes.fromhex(salt) — the EXACT hashRazorpayId convention.
    salts = _load_salts(spark)
    df = df.join(salts.hint("broadcast"), "brand_id", "left")

    canon = (
        df.withColumn("entity_type", u_entity(col("entity_type_raw")))
        .withColumn("settlement_at_iso", u_iso(col("settled_at")))
        .withColumn("occurred_at_iso", coalesce(u_iso(col("settled_at")), u_iso(col("created_at"))))
        .withColumn("amount_minor", u_paisa(col("amount")))
        .withColumn("fee_minor", u_paisa(col("fee")))
        .withColumn("tax_minor", u_paisa(col("tax")))
        .withColumn("currency_code", upper(trim(coalesce(col("currency"), lit("INR")))))
        .withColumn("payment_id_hash", u_hash(col("payment_id"), col("salt_hex")))
        .withColumn("utr_hash", u_hash(col("utr"), col("salt_hex")))
        .withColumn("reconciliation_type", u_recon(col("entity_type"), col("payment_id")))
        .withColumn("event_id", u_eid(col("brand_id"), col("settlement_id"), col("payment_id"), col("entity_type")))
        .where(
            col("event_id").isNotNull()
            & col("occurred_at_iso").isNotNull()
            & col("amount_minor").isNotNull()
            & col("fee_minor").isNotNull()
            & col("tax_minor").isNotNull()
        )
    )

    # Reconstruct the canonical settlement.live.v1 SettlementEventProperties as the `payload` JSON the
    # settlement marts get_json_object. Field order + names mirror the TS SettlementEventProperties exactly.
    props = struct(
        lit("razorpay").alias("source"),
        col("settlement_id").alias("settlement_id"),
        col("payment_id_hash").alias("payment_id_hash"),
        col("order_id").alias("order_id"),
        col("utr_hash").alias("utr_hash"),
        col("amount_minor").alias("amount_minor"),   # bigint-minor-as-string (I-S07)
        col("fee_minor").alias("fee_minor"),
        col("tax_minor").alias("tax_minor"),
        col("currency_code").alias("currency_code"),
        col("entity_type").alias("entity_type"),
        col("status").alias("status"),
        col("settlement_at_iso").alias("settlement_at"),
        col("occurred_at_iso").alias("occurred_at"),
        col("reconciliation_type").alias("reconciliation_type"),
    )
    envelope = to_json(struct(
        lit("settlement.live.v1").alias("event_name"),
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
        lit("settlement.live.v1").alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("partition_key"),
        envelope.alias("payload"),
    )

    out.createOrReplaceTempView("_razorpay_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _razorpay_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def _load_salts(spark: SparkSession):
    """(brand_id, salt_hex) for the C1 PII hash. Dev-derivable; prod reads the KMS-unwrapped per-brand salt.
    Mirrors the SoR @brain/razorpay-mapper used (saltProvider.saltHexForBrand) so the hash matches.
    Override SALT_QUERY for the exact prod fn (e.g. get_brand_identity_salt_all())."""
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

    spark = build_spark("silver-razorpay-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-razorpay-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-razorpay-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-razorpay-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
