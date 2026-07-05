"""
silver_woocommerce_normalize.py — ADR-0006 P4: normalize RAW WooCommerce orders in Spark Silver.

Mirrors the PROVEN Shopify exemplar (silver_shopify_order_normalize.py) EXACTLY. Reads the RAW
WooCommerce order Bronze (brain_bronze.woocommerce_orders_raw, written by the Kafka Connect Iceberg
sink from {env}.woocommerce.orders.raw.v1) and produces the SHARED canonical order.live.v1 rows the
order marts consume — replacing the TS @brain/woocommerce-mapper::mapWooOrderToEvent normalization the
connector used to do before emitting a canonical event. The connector now emits the verbatim provider
order; ALL normalization happens HERE (ADR-0006 D3).

MULTI-SOURCE: WooCommerce SHARES the order.live.v1 contract with Shopify. The reconstructed payload
carries source='woocommerce' (vs 'shopify') so silver_order_state / silver_order_line can source-scope
while reading the IDENTICAL column contract — zero downstream change.

Output: the SAME column contract as silver_collector_event (the gated collector lane) — `payload` is the
reconstructed canonical order.live.v1 envelope, event_type='order.live.v1', brand_id server-trusted from
the envelope ONLY (MT-1).

CORRECTNESS: scalar/crypto/money fields go through the SHARED, GOLDEN-VECTOR-VERIFIED ports in
_raw_normalize.py (udf-wrapped → Spark output == verified Python == TS). The three WooCommerce-SPECIFIC
behaviours that the Shopify ports do not cover are LOCAL helpers here (and in the golden test), pending
later consolidation into the shared framework (see new_framework_primitives_needed):
  - woo_to_utc_iso     ← @brain/woocommerce-mapper toUtcIso: GMT `*_gmt` strings frequently lack a tz
                          suffix; append 'Z' (treat as UTC) before toISOString, else `new Date(naive)`
                          would be parsed as LOCAL time. iso_ms() alone does NOT append the Z.
  - classify_payment_woo ← @brain/woocommerce-mapper classifyPaymentMethod: COD set {cod,
                          cash_on_delivery, cheque} + payment_method_title contains 'cash on delivery'/'cod';
                          DIFFERENT from the Shopify gateway/financial_status classifier.
  - event_id seed        ← the Woo live lane (WooCommerceWebhookStrategy + repull) seeds
                          uuidV5FromOrderLive(brand, orderId, Date.parse(occurred_at)) — i.e. the seed ms
                          is the CANONICAL occurred_at epoch ms (Woo has no raw provider event ts), NOT a
                          raw updated_at field. So event_id = event_id_order_live(brand, id, epoch_ms(occurred)).

DUAL-RUN (P4): writes to a SHADOW table by default (TARGET_TABLE override) so parity can be checked against
the live canonical silver_collector_event order rows before the connector cutover. Money is bigint MINOR
units + a sibling currency_code (never blended, never float). PII is hashed-only; raw identifiers never
stored. brand_id is the tenant key, first column, taken ONLY from the server-trusted envelope (MT-1).

STAGE-1 GATE (Brain V4 two-stage): mirrors the Shopify exemplar — the inline drop gate
(`.where(event_id & amount_minor & occurred_at_iso isNotNull)`) is now ROUTED through
_silver_technical.write_quarantine (stage='dq') to brain_silver.silver_quarantine: un-seedable event_id →
empty_identifier:event_id, malformed money → non_integer_amount, un-derivable occurred_at →
unparseable_timestamp. The admitted set is IDENTICAL (good rows byte-identical / parity-faithful); the
quarantine payload carries only NON-PII source fields (raw email/phone never threaded — PII stays
hash-only), and Bronze keeps the untouched original (replay-safe).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import col, concat_ws, lit, lower, to_json, struct, udf, when  # noqa: E402
from pyspark.sql.types import LongType, StringType  # noqa: E402

from iceberg_base import CATALOG, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402
from job_log import emit_job_log  # noqa: E402
from _silver_technical import write_quarantine, event_category_udf  # noqa: E402
import _raw_normalize as rn
from _raw_normalize import iso_ms_assume_utc as woo_to_utc_iso  # consolidated primitives (ADR-0006)  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
RAW_TABLE = f"{CATALOG}.{BRONZE_NAMESPACE}.woocommerce_orders_raw"
# Shadow by default (dual-run parity). Set TARGET_TABLE=silver_collector_event at cutover (P3-for-orders).
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get("TARGET_TABLE", "silver_collector_event_woocommerce_shadow")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")

COLUMNS_SQL = """
  event_id          string  NOT NULL,
  brand_id          string  NOT NULL,
  occurred_at       timestamp NOT NULL,
  ingested_at       timestamp NOT NULL,
  schema_name       string  NOT NULL,
  schema_version    int     NOT NULL,
  event_type        string  NOT NULL,
  event_category    string,
  correlation_id    string,
  partition_key     string  NOT NULL,
  anonymous_id      string,
  device_id         string,
  silver_version    int,
  payload           string  NOT NULL
"""

# ── WooCommerce-LOCAL helpers (NOT yet in the shared framework — see module docstring) ────────────────
_WOO_TZ_RE = re.compile(r"([zZ]$)|([+-]\d{2}:?\d{2}$)")
_WOO_COD_METHODS = {"cod", "cash_on_delivery", "cheque"}




def classify_payment_woo(payment_method, payment_method_title):
    """@brain/woocommerce-mapper classifyPaymentMethod — DISTINCT from the Shopify classifier: COD if the
    payment_method ∈ {cod, cash_on_delivery, cheque} OR the payment_method_title contains 'cash on delivery'
    / 'cod'; else 'prepaid'. (No financial_status==pending heuristic, unlike Shopify.)"""
    method = (payment_method or "").lower()
    title = (payment_method_title or "").lower()
    if method in _WOO_COD_METHODS:
        return "cod"
    if "cash on delivery" in title or "cod" in title:
        return "cod"
    return "prepaid"


# ── UDFs over the verified shared ports + the Woo-local helpers ────────────────────────────────────────
u_minor = udf(lambda s: rn.decimal_to_minor_strict(s), LongType())
u_woo_iso = udf(lambda mod, cre: woo_to_utc_iso(mod if mod else cre), StringType())
u_epoch = udf(lambda iso: rn.epoch_ms(iso) if iso else None, LongType())
u_classify_woo = udf(lambda m, t: classify_payment_woo(m, t), StringType())
u_hash_email = udf(lambda v, salt: rn.hash_identifier(v, "email", salt, REGION) if v else None, StringType())
u_hash_phone = udf(lambda v, salt: rn.hash_identifier(v, "phone", salt, REGION) if v else None, StringType())
u_currency = udf(lambda c: (c or "INR").upper(), StringType())
u_storefront = udf(lambda cid: str(cid) if (cid is not None and str(cid) != "0") else None, StringType())
u_eid = udf(
    lambda brand, oid, ms: rn.event_id_order_live(brand, oid, ms) if (brand and oid and ms is not None) else None,
    StringType(),
)


def build(spark: SparkSession):
    create_iceberg_table(spark, SILVER_NAMESPACE, TARGET.rsplit(".", 1)[1], COLUMNS_SQL,
                         partitioned_by="bucket(256, brand_id), days(occurred_at)")

    raw = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, "woocommerce_orders_raw", "woocommerce")
    # Skip-guard: empty-lane skip — the woocommerce_orders_raw_connect table auto-creates on the
    # lane's first record (ADR-0010). No source rows → nothing to normalize; return cleanly instead of
    # failing the struct-column select on the empty placeholder frame.
    if raw.limit(1).count() == 0:
        print(f"[silver-woocommerce-normalize] {rn.connect_source_table(CATALOG, BRONZE_NAMESPACE, 'woocommerce_orders_raw')} has 0 rows — skipping (empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    o = "order"  # the verbatim Woo order is nested under `order` in the envelope (the connector wraps it)

    df = raw.select(
        col("brand_id").cast("string").alias("brand_id"),               # MT-1: server-trusted envelope ONLY
        col("fetched_at").cast("string").alias("fetched_at"),
        col(f"{o}.id").cast("string").alias("order_id"),
        col(f"{o}.status").cast("string").alias("status"),
        col(f"{o}.currency").cast("string").alias("currency_raw"),
        col(f"{o}.total").cast("string").alias("price_str"),
        col(f"{o}.payment_method").cast("string").alias("payment_method"),
        col(f"{o}.payment_method_title").cast("string").alias("payment_method_title"),
        col(f"{o}.date_modified_gmt").cast("string").alias("date_modified_gmt"),
        col(f"{o}.date_created_gmt").cast("string").alias("date_created_gmt"),
        col(f"{o}.customer_id").cast("string").alias("customer_id"),
        col(f"{o}.billing.email").cast("string").alias("cust_email"),
        col(f"{o}.billing.phone").cast("string").alias("cust_phone"),
    )

    # Per-brand salt (the keystone) — broadcast join on brand_id. (Re-uses the JDBC salt SoR; a single read.)
    salts = _load_salts(spark)
    df = df.join(salts.hint("broadcast"), "brand_id", "left")

    canon = (
        df.withColumn("status_lc", lower(col("status")))
        # occurred_at = toUtcIso(date_modified_gmt ?? date_created_gmt); seed ms = Date.parse(occurred_at)
        .withColumn("occurred_at_iso", u_woo_iso(col("date_modified_gmt"), col("date_created_gmt")))
        .withColumn("occurred_ms", u_epoch(col("occurred_at_iso")))
        .withColumn("amount_minor", u_minor(col("price_str")))
        .withColumn("currency_code", u_currency(col("currency_raw")))
        .withColumn("payment_method", u_classify_woo(col("payment_method"), col("payment_method_title")))
        .withColumn("hashed_customer_email", u_hash_email(col("cust_email"), col("salt_hex")))
        .withColumn("hashed_customer_phone", u_hash_phone(col("cust_phone"), col("salt_hex")))
        .withColumn("storefront_customer_id", u_storefront(col("customer_id")))
        # status || undefined / status || null → empty status becomes NULL
        .withColumn("financial_status", when(col("status_lc") == "", lit(None).cast("string")).otherwise(col("status_lc")))
        .withColumn("fulfillment_status", when(col("status_lc") == "", lit(None).cast("string")).otherwise(col("status_lc")))
        # Woo has no separate cancelled ts; a 'cancelled' status AT occurred_at drives the rto_reversal.
        .withColumn("cancelled_at_iso", when(col("status_lc") == "cancelled", col("occurred_at_iso")).otherwise(lit(None).cast("string")))
        .withColumn("event_id", u_eid(col("brand_id"), col("order_id"), col("occurred_ms")))
    )

    # ── Stage-1 DQ gate: route the inline drops to brain_silver.silver_quarantine (stage='dq') instead of
    #    silently dropping. Same admission set; good rows byte-identical; NON-PII diagnostic payload only.
    _ok = col("event_id").isNotNull() & col("amount_minor").isNotNull() & col("occurred_at_iso").isNotNull()
    _reason = concat_ws(
        ",",
        when(col("event_id").isNull(), lit("empty_identifier:event_id")),
        when(col("amount_minor").isNull(), lit("non_integer_amount")),
        when(col("occurred_at_iso").isNull(), lit("unparseable_timestamp")),
    )
    write_quarantine(
        spark,
        canon.where(~_ok).select(
            col("brand_id"),
            lit("woocommerce").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TARGET.rsplit(".", 1)[1]).alias("canonical_target"),
            _reason.alias("reason"),
            to_json(struct(
                col("order_id"), col("status"), col("currency_raw"), col("price_str"),
                col("payment_method"), col("payment_method_title"), col("date_modified_gmt"),
                col("date_created_gmt"), col("customer_id"),
            )).alias("payload"),
        ),
        stage="dq",
    )
    canon = canon.where(_ok)

    # Reconstruct the canonical order.live.v1 envelope as the `payload` JSON the order marts get_json_object.
    # Mirrors the Shopify exemplar's scalar payload; source='woocommerce' for multi-source scoping.
    props = struct(
        lit("woocommerce").alias("source"),
        col("order_id").alias("order_id"),
        col("order_id").alias("woocommerce_order_id"),
        col("amount_minor").cast("string").alias("amount_minor"),
        col("currency_code").alias("currency_code"),
        col("payment_method").alias("payment_method"),
        col("financial_status").alias("financial_status"),
        col("fulfillment_status").alias("fulfillment_status"),
        col("cancelled_at_iso").alias("cancelled_at"),
        col("hashed_customer_email").alias("hashed_customer_email"),
        col("hashed_customer_phone").alias("hashed_customer_phone"),
        col("storefront_customer_id").alias("storefront_customer_id"),
    )
    envelope = to_json(struct(
        lit("order.live.v1").alias("event_name"),
        col("occurred_at_iso").alias("occurred_at"),
        props.alias("properties"),
    ))

    _event_category = event_category_udf()  # SAME SoT as the keystone collector gate (Gap A port)
    out = canon.select(
        col("event_id"),
        col("brand_id"),
        col("occurred_at_iso").cast("timestamp").alias("occurred_at"),
        col("fetched_at").cast("timestamp").alias("ingested_at"),
        lit("brain.collector.event.v1").alias("schema_name"),
        lit(1).alias("schema_version"),
        lit("order.live.v1").alias("event_type"),
        _event_category(lit("order.live.v1")).alias("event_category"),
        lit(None).cast("string").alias("correlation_id"),
        col("brand_id").alias("partition_key"),
        lit(None).cast("string").alias("anonymous_id"),  # pixel-only identifiers — connector-derived rows have none
        lit(None).cast("string").alias("device_id"),
        lit(1).alias("silver_version"),  # seed; bumped only on a REAL payload change by the MERGE below
        envelope.alias("payload"),
    )

    # ADR-0010: the append-only Connect Bronze can carry redelivered duplicates — collapse to one row
    # per (brand_id, event_id) or the MERGE below aborts on a source-cardinality violation.
    out = rn.dedupe_latest(out, ["brand_id", "event_id"], "ingested_at")
    out.createOrReplaceTempView("_woo_canon")
    spark.sql(
        f"""
        MERGE INTO {TARGET} t USING _woo_canon s
        ON t.brand_id = s.brand_id AND t.event_id = s.event_id
        -- Keystone-mirrored idempotency (silver_collector_event.py Gap C): overwrite only on a REAL
        -- payload change; bump silver_version (coalesce so pre-widening 10-col rows start from 1, never NULL+1).
        WHEN MATCHED AND s.payload <> t.payload THEN UPDATE SET
          occurred_at = s.occurred_at, ingested_at = s.ingested_at,
          schema_name = s.schema_name, schema_version = s.schema_version,
          event_type = s.event_type, event_category = s.event_category,
          correlation_id = s.correlation_id, partition_key = s.partition_key,
          anonymous_id = s.anonymous_id, device_id = s.device_id,
          payload = s.payload,
          silver_version = coalesce(t.silver_version, 1) + 1
        -- One-time widen-backfill: pre-widening 10-col rows (payload unchanged, so the clause above
        -- no-ops forever) get the ALTER-ADDed columns populated WITHOUT counting it as a revision.
        WHEN MATCHED AND t.silver_version IS NULL THEN UPDATE SET
          event_category = s.event_category, anonymous_id = s.anonymous_id,
          device_id = s.device_id, silver_version = 1
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

    spark = build_spark("silver-woocommerce-order-normalize")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("silver-woocommerce-order-normalize", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
        print(f"[silver-woocommerce-order-normalize] DONE — {fqtn} now has {n} rows", flush=True)
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-woocommerce-order-normalize", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
