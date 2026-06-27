"""
silver_shopflo_normalize.py — ADR-0006 P4: normalize RAW Shopflo checkout_abandoned in Spark Silver.

Reads the RAW Shopflo webhook Bronze (brain_bronze.shopflo_checkout_raw — the verbatim HMAC-verified
checkout_abandoned webhook body, server-stamped with a trusted brand_id envelope) and produces the
canonical shopflo.checkout_abandoned.v1 collector rows that silver_checkout_signal consumes (source=shopflo,
sharing the mart with gokwik.rto_predict.v1) — replacing the TS @brain/shopflo-mapper::mapShopfloCheckoutAbandoned
normalization the connector used to do before emitting a canonical event (ADR-0006 D3). The connector now
lands the verbatim provider webhook; ALL normalization happens HERE.

Output: the SAME column contract as silver_collector_event (the gated collector lane), so silver_checkout_signal
reads it with ZERO change — `payload` is the reconstructed canonical shopflo.checkout_abandoned.v1 envelope
(event_name + properties.*), event_type='shopflo.checkout_abandoned.v1', brand_id server-trusted from the
envelope column ONLY (MT-1) — never from the webhook body (a forged merchant_id/brand_id in the body cannot
re-target a tenant).

CORRECTNESS: every field goes through the SHARED, GOLDEN-VECTOR-VERIFIED ports in _raw_normalize.py
(rn.hash_identifier / rn.normalize_phone_in / rn.iso_ms / rn.uuid_shaped) plus a few connector-LOCAL ports
that mirror @brain/shopflo-mapper exactly where its semantics differ from the order exemplar (money_to_minor_string
— null→'0' not None; the checkout-namespaced event_id seed over the RAW envelope checkout_id+occurred_at as the
webhook handler stamps it; has_address; to_quantity; the phone double-normalize the mapper performs). These
LOCAL ports are proven byte-for-byte against the real TS in _p4_golden/test_shopflo-golden.py, so the Spark
output == the verified Python == the TS — money (bigint minor + currency), hashed-PII, and the uuid-shaped
event_id are all identical to the old canonical Silver.

WHY A SINGLE BUILD UDF (not per-column like the order exemplar): a Shopflo checkout carries a nested
line_items array (per-item money) and arbitrary address objects whose has_address flag counts null-valued
keys — a per-column struct reconstruction would lose those (Spark to_json drops null struct fields). Reading
the verbatim webhook body as a JSON STRING and folding it in ONE port that internally calls the shared rn.*
primitives preserves the exact provider structure (null keys, number forms) and keeps the parity loop intact.

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against the
live canonical silver_collector_event shopflo rows before the connector cutover. MONEY: bigint MINOR units,
never float, paired with currency_code, never blended. PII: hashed-only (email/phone) — raw never stored.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import coalesce, col, current_timestamp, lit, udf  # noqa: E402
from pyspark.sql.types import StringType, StructField, StructType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
import _raw_normalize as rn  # noqa: E402

SHOPFLO_EVENT_NAME = "shopflo.checkout_abandoned.v1"

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}." + os.environ.get("RAW_TABLE", "shopflo_checkout_raw")
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at the checkout-lane cutover.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_shopflo_shadow"
)
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")

# Envelope column names (server-trusted brand_id ONLY from here — MT-1 — never from the webhook body).
BRAND_COL = os.environ.get("RAW_BRAND_COL", "brand_id")
INGESTED_COL = os.environ.get("RAW_INGESTED_COL", "fetched_at")
RAW_PAYLOAD_COL = os.environ.get("RAW_PAYLOAD_COL", "payload")  # verbatim Shopflo webhook body, JSON string

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


# ── Connector-LOCAL ports — mirror @brain/shopflo-mapper EXACTLY where it diverges from the order exemplar.
#    (Listed in new_framework_primitives_needed for later consolidation into _raw_normalize.py.) ──────────

_MONEY_RE = re.compile(r"^\d+(\.\d{1,2})?$")


def money_to_minor_string(value):
    """@brain/shopflo-mapper moneyToMinorString — decimal/number major units → BIGINT-as-string minor units.
    null/undefined → '0' (NOT None — this differs from the shared decimal_to_minor_strict). Integer-only
    (no parseFloat): split on '.'. Raises on an invalid value (>2 dp / negative / non-numeric), exactly like
    the TS throws; the build wrapper catches it → row quarantined."""
    if value is None:
        return "0"
    if isinstance(value, bool):  # JS: typeof boolean !== number → String(true) → invalid → throw
        raise ValueError(f"invalid money value {value!r}")
    if isinstance(value, float):
        s = str(int(value)) if value.is_integer() else repr(value)  # JS Number.toString drops a trailing .0
    elif isinstance(value, int):
        s = str(value)
    else:
        s = str(value).strip()
    if s == "":
        return "0"
    if not _MONEY_RE.match(s):
        raise ValueError(f"invalid money value {s!r} (I-S07)")
    if "." not in s:
        return str(int(s) * 100)
    whole, frac = s.split(".", 1)
    frac = (frac + "00")[:2]  # padEnd(2, '0')
    return str(int(whole) * 100 + int(frac))


def to_quantity(value):
    """@brain/shopflo-mapper toQuantity — number passthrough; else parseInt(trim,10); finite & >0 → floor; else 0."""
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        n = float(value)
    else:
        m = re.match(r"^[+-]?\d+", str(value).strip())  # JS parseInt: leading integer run
        if not m:
            return 0
        n = float(m.group())
    if math.isfinite(n) and n > 0:
        return int(math.floor(n))
    return 0


def has_address_from(shipping, billing):
    """@brain/shopflo-mapper hasAddress — a non-empty shipping OR billing object (counts null-valued keys)."""
    def non_empty(a):
        return isinstance(a, dict) and len(a) > 0

    return non_empty(shipping) or non_empty(billing)


def event_id_shopflo_checkout(brand_id, checkout_id, occurred_at_raw):
    """uuidV5FromShopfloCheckout(brandId, checkoutId, occurredAt) — the webhook handler stamps the Bronze
    event_id (= dedup key) from the brand + the RAW envelope checkout_id + the RAW envelope occurred_at
    string (NOT the trimmed/re-ISO'd mapper values). Distinct namespace from order/settlement events."""
    return rn.uuid_shaped(f"{brand_id}:{checkout_id}:{occurred_at_raw}:{SHOPFLO_EVENT_NAME}")


def hash_phone_shopflo(raw_phone, salt_hex, region):
    """The mapper normalizes the phone FIRST (normalizePhone) then hashes via hashIdentifier('phone'), which
    re-normalizes — so the hashed input is normalize(normalize(raw)). normalize is idempotent for valid E.164
    IN numbers; we mirror the double pass byte-for-byte to be safe."""
    normalized = rn.normalize_phone_in(raw_phone, region)
    return rn.hash_identifier(normalized, "phone", salt_hex, region)


def _coalesce_nullish(*vals):
    """JS `??` chain — first value that is not None (null/undefined)."""
    for v in vals:
        if v is not None:
            return v
    return None


def build_shopflo_canonical(payload_json, brand_id, salt_hex, region):
    """Fold mapShopfloCheckoutAbandoned + the handler's event_id stamp from the verbatim webhook body.
    Returns (event_id, occurred_at_iso, payload_json) — the canonical shopflo.checkout_abandoned.v1 envelope.
    On any failure (missing checkout_id / un-parseable money / no timestamp) returns NULLs → row quarantined."""
    try:
        p = json.loads(payload_json) if isinstance(payload_json, str) else (payload_json or {})
        if not isinstance(p, dict):
            return (None, None, None)

        # properties.checkout_id = String(checkout_id ?? cart_token ?? '').trim() — throw (→quarantine) if empty.
        raw_cid = p.get("checkout_id")
        raw_cart = p.get("cart_token")
        checkout_id = str(_coalesce_nullish(raw_cid, raw_cart, "")).strip()
        if not checkout_id:
            return (None, None, None)

        # occurred_at = new Date(occurred_at ?? created_at).toISOString() (.mmmZ form).
        occ_iso = rn.iso_ms(p.get("occurred_at"), p.get("created_at"))
        if occ_iso is None:
            return (None, None, None)

        # event_id seed — the HANDLER path: RAW envelope checkout_id + RAW envelope occurred_at (typeof-string).
        eid_cid = p.get("checkout_id") if isinstance(p.get("checkout_id"), str) else ""
        eid_occ = p.get("occurred_at") if isinstance(p.get("occurred_at"), str) else ""
        event_id = event_id_shopflo_checkout(brand_id, eid_cid, eid_occ)

        # PII — hashed at the boundary; raw email/phone DROPPED (I-S02). customer.* with top-level fallback.
        customer = p.get("customer")
        if not isinstance(customer, dict):
            customer = {}
        raw_email = _coalesce_nullish(customer.get("email"), p.get("email"))
        raw_phone = _coalesce_nullish(customer.get("phone"), p.get("phone"))
        email_hash = rn.hash_identifier(raw_email, "email", salt_hex, region) if raw_email else None
        phone_hash = hash_phone_shopflo(raw_phone, salt_hex, region) if raw_phone else None

        marketing = bool(_coalesce_nullish(customer.get("marketing_consent"), p.get("marketing_consent"), False))

        line_items = []
        for li in (p.get("line_items") or []):
            if not isinstance(li, dict):
                continue
            line_items.append({
                "id": str(li.get("id")) if li.get("id") is not None else None,
                "title": str(li.get("title")) if li.get("title") is not None else None,
                "quantity": to_quantity(li.get("quantity")),
                "price_minor": money_to_minor_string(li.get("price")),
            })

        currency = p.get("currency")
        currency_code = (str(currency).strip().upper() if currency is not None else "INR") or "INR"

        data_source = p.get("data_source")
        if data_source not in ("real", "synthetic"):
            data_source = "real"  # the live HMAC-verified webhook is REAL (documented payload)

        properties = {
            "source": "shopflo",
            "data_source": data_source,
            "checkout_id": checkout_id,
            "cart_token": str(raw_cart) if raw_cart is not None else None,
            "customer_email_hash": email_hash,
            "customer_phone_hash": phone_hash,
            "marketing_consent": marketing,
            "has_address": has_address_from(p.get("shipping_address"), p.get("billing_address")),
            "line_items": line_items,
            "subtotal_minor": money_to_minor_string(p.get("subtotal_price")),
            "total_discount_minor": money_to_minor_string(p.get("total_discount")),
            "total_shipping_minor": money_to_minor_string(p.get("total_shipping")),
            "total_tax_minor": money_to_minor_string(p.get("total_tax")),
            "total_price_minor": money_to_minor_string(p.get("total_price")),
            "currency_code": currency_code,
            "occurred_at": occ_iso,
        }
        envelope = {"event_name": SHOPFLO_EVENT_NAME, "occurred_at": occ_iso, "properties": properties}
        return (event_id, occ_iso, json.dumps(envelope, ensure_ascii=False, separators=(",", ":")))
    except Exception:  # noqa: BLE001 — any mapper-throw (bad money) → quarantine the row, never crash the batch
        return (None, None, None)


# ── UDF over the build port (Spark output == verified python == TS) ───────────────────────────────────
_BUILD_SCHEMA = StructType([
    StructField("event_id", StringType()),
    StructField("occurred_at", StringType()),
    StructField("payload", StringType()),
])
u_build = udf(lambda payload, brand, salt: build_shopflo_canonical(payload, brand, salt, REGION), _BUILD_SCHEMA)


def build(spark: SparkSession):
    create_iceberg_table(spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
                         partitioned_by="bucket(256, brand_id), days(occurred_at)")

    raw = spark.table(RAW_TABLE)
    df = raw.select(
        col(BRAND_COL).cast("string").alias("brand_id"),                 # MT-1: server-trusted envelope ONLY
        col(INGESTED_COL).cast("timestamp").alias("ingested_at_raw"),
        col(RAW_PAYLOAD_COL).cast("string").alias("payload_raw"),        # verbatim webhook body (JSON string)
    )

    # Per-brand salt (the keystone) — broadcast join on brand_id. Re-uses the JDBC salt SoR so the hash matches.
    salts = _load_salts(spark)
    df = df.join(salts.hint("broadcast"), "brand_id", "left")

    built = df.withColumn("c", u_build(col("payload_raw"), col("brand_id"), col("salt_hex")))
    canon = built.where(col("c.event_id").isNotNull() & col("c.payload").isNotNull() & col("c.occurred_at").isNotNull())

    out = canon.select(
        col("c.event_id").alias("event_id"),
        col("brand_id"),
        col("c.occurred_at").cast("timestamp").alias("occurred_at"),
        coalesce(col("ingested_at_raw"), current_timestamp()).alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit(SHOPFLO_EVENT_NAME).alias("event_type"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("partition_key"),
        col("c.payload").alias("payload"),
    )

    out.createOrReplaceTempView("_shopflo_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _shopflo_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.sql(f"SELECT COUNT(*) AS n FROM {TARGET}").collect()[0]["n"]
    return TARGET, n


def _load_salts(spark: SparkSession):
    """(brand_id, salt_hex) for the PII hash. Dev-derivable; prod reads the KMS-unwrapped per-brand salt.
    Mirrors the SoR the connector used so the hash matches. Override SALT_QUERY for the exact prod fn.
    (Identical to the order exemplar — resolveDevSaltHex = sha256('brain-dev-identity-salt-v1||'||lower(id)).)"""
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

    spark = build_spark("silver-shopflo-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-shopflo-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-shopflo-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-shopflo-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
