"""
silver_woocommerce_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_woocommerce_normalize.py (ADR-0006 P4).

Reads the RAW WooCommerce order Bronze (the ADR-0010 Kafka-Connect `woocommerce_orders_raw_connect` lane — the
verbatim provider order nested under `order`), reconstructs the SHARED canonical order.live.v1 envelope in
`payload` (source='woocommerce' for multi-source scoping — it shares the contract with Shopify), and MERGEs
the silver_collector_event 14-column contract into the SHADOW table silver_collector_event_woocommerce_shadow
(dual-run parity; TARGET_TABLE / MIGRATION_TABLE_SUFFIX override). silver_order_state / silver_order_line read
the shadow with ZERO change.

CORRECTNESS: scalar/crypto/money fields go through the VENDORED ports (_raw_normalize_ports.decimal_to_minor_strict /
epoch_ms / event_id_order_live / hash_identifier / iso_ms_assume_utc); the WooCommerce-SPECIFIC payment
classifier is ported HERE byte-for-byte with the Spark job. Money is bigint MINOR + a sibling currency_code;
PII is hashed-only. The event_id seed ms is the CANONICAL occurred_at epoch (Woo has no raw provider event ts).

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (un-seedable event_id / malformed money / un-derivable occurred_at) to silver_quarantine
(stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals (replay-safe). The
ADMITTED (good-row) set is IDENTICAL: the same `event_id & amount_minor & occurred_at_iso IS NOT NULL`
predicate is applied before the MERGE.

Parity target: brain_silver.silver_collector_event_woocommerce_shadow (empty lane today → 0 rows, HONEST-EMPTY).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    advance_lane_watermark, connect_source_table, ensure_shadow, lane_window, lane_window_predicate,
    merge_collector_event, register_salts, run_normalize_job, source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _raw_normalize_ports import iso_ms_assume_utc as woo_to_utc_iso  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

LANE = "woocommerce_orders_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_woocommerce_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")

_WOO_COD_METHODS = {"cod", "cash_on_delivery", "cheque"}


def classify_payment_woo(payment_method, payment_method_title):
    """classifyPaymentMethod — COD if payment_method ∈ {cod,cash_on_delivery,cheque} OR the title contains
    'cash on delivery'/'cod'; else 'prepaid'. (No financial_status==pending heuristic, unlike Shopify.)"""
    method = (payment_method or "").lower()
    title = (payment_method_title or "").lower()
    if method in _WOO_COD_METHODS:
        return "cod"
    if "cash on delivery" in title or "cod" in title:
        return "cod"
    return "prepaid"


def _register_udfs(con) -> None:
    con.create_function("rn_minor", rn.decimal_to_minor_strict, ["VARCHAR"], "BIGINT", null_handling="special")
    con.create_function("rn_woo_iso", lambda mod, cre: woo_to_utc_iso(mod if mod else cre),
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_epoch", lambda iso: rn.epoch_ms(iso) if iso else None, ["VARCHAR"], "BIGINT",
                        null_handling="special")
    con.create_function("rn_classify", classify_payment_woo, ["VARCHAR", "VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_hash_email",
                        lambda v, salt: rn.hash_identifier(v, "email", salt, REGION) if v else None,
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_hash_phone",
                        lambda v, salt: rn.hash_identifier(v, "phone", salt, REGION) if v else None,
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_storefront",
                        lambda cid: str(cid) if (cid is not None and str(cid) != "0") else None,
                        ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_eid_order",
                        lambda brand, oid, ms: rn.event_id_order_live(brand, oid, ms)
                        if (brand and oid and ms is not None) else None,
                        ["VARCHAR", "VARCHAR", "BIGINT"], "VARCHAR", null_handling="special")
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def build(con):
    ensure_shadow(con, TARGET)
    if not source_present(con, LANE):
        print(f"[silver-woocommerce-normalize] {connect_source_table(LANE)} absent/empty — skipping "
              f"(empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    _register_udfs(con)
    register_salts(con)
    src = connect_source_table(LANE)

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   Per-event grain: each raw Woo order row → 0..1 silver row via the idempotent MERGE on
    #   (brand_id, event_id), so windowing the source read is safe. Raw lanes have no lifted ingested_at;
    #   the physical arrival clock is kafka_timestamp (watermark keyed per (job, lane)). Default OFF →
    #   lo=None → predicate is "" → BYTE-IDENTICAL full scan.
    lo_woo, hi_woo = lane_window(con, "silver-woocommerce-order-normalize", LANE)

    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                        AS brand_id,
        CAST(fetched_at AS VARCHAR)                      AS fetched_at,
        CAST("order".id AS VARCHAR)                      AS order_id,
        CAST("order".status AS VARCHAR)                  AS status,
        CAST("order".currency AS VARCHAR)                AS currency_raw,
        CAST("order".total AS VARCHAR)                   AS price_str,
        CAST("order".payment_method AS VARCHAR)          AS payment_method,
        CAST("order".payment_method_title AS VARCHAR)    AS payment_method_title,
        CAST("order".date_modified_gmt AS VARCHAR)       AS date_modified_gmt,
        CAST("order".date_created_gmt AS VARCHAR)        AS date_created_gmt,
        CAST("order".customer_id AS VARCHAR)             AS customer_id,
        CAST("order".billing.email AS VARCHAR)           AS cust_email,
        CAST("order".billing.phone AS VARCHAR)           AS cust_phone
      FROM {src}
      {lane_window_predicate(lo_woo, hi_woo)}
    """

    joined = f"SELECT d.*, sl.salt_hex FROM ({df}) d LEFT JOIN _salts sl ON d.brand_id = sl.brand_id"

    canon = f"""
      SELECT *,
        lower(status)                                            AS status_lc,
        rn_woo_iso(date_modified_gmt, date_created_gmt)          AS occurred_at_iso,
        rn_epoch(rn_woo_iso(date_modified_gmt, date_created_gmt)) AS occurred_ms,
        rn_minor(price_str)                                      AS amount_minor,
        upper(coalesce(currency_raw, 'INR'))                     AS currency_code,
        rn_classify(payment_method, payment_method_title)        AS payment_method_c,
        rn_hash_email(cust_email, salt_hex)                      AS hashed_customer_email,
        rn_hash_phone(cust_phone, salt_hex)                      AS hashed_customer_phone,
        rn_storefront(customer_id)                               AS storefront_customer_id,
        rn_eid_order(brand_id, order_id,
                     rn_epoch(rn_woo_iso(date_modified_gmt, date_created_gmt))) AS event_id
      FROM ({joined})
    """

    # status || undefined → empty status becomes NULL; a 'cancelled' status drives the rto_reversal.
    derived = f"""
      SELECT *,
        CASE WHEN status_lc = '' THEN NULL ELSE status_lc END    AS financial_status,
        CASE WHEN status_lc = '' THEN NULL ELSE status_lc END    AS fulfillment_status,
        CASE WHEN status_lc = 'cancelled' THEN occurred_at_iso ELSE NULL END AS cancelled_at_iso
      FROM ({canon})
    """

    # Reconstruct the canonical order.live.v1 envelope. json_object drops NULL keys (Spark parity).
    props = (
        "json_object("
        "'source','woocommerce',"
        "'order_id', order_id,"
        "'woocommerce_order_id', order_id,"
        "'amount_minor', CAST(amount_minor AS VARCHAR),"
        "'currency_code', currency_code,"
        "'payment_method', payment_method_c,"
        "'financial_status', financial_status,"
        "'fulfillment_status', fulfillment_status,"
        "'cancelled_at', cancelled_at_iso,"
        "'hashed_customer_email', hashed_customer_email,"
        "'hashed_customer_phone', hashed_customer_phone,"
        "'storefront_customer_id', storefront_customer_id)"
    )
    payload = (
        "json_object('event_name','order.live.v1','occurred_at', occurred_at_iso, 'properties', "
        f"{props})"
    )

    good = f"""
      SELECT
        event_id,
        brand_id,
        CAST(occurred_at_iso AS TIMESTAMP)               AS occurred_at,
        CAST(fetched_at AS TIMESTAMP)                    AS ingested_at,
        'brain.collector.event.v1'                       AS schema_name,
        CAST(1 AS INTEGER)                               AS schema_version,
        'order.live.v1'                                  AS event_type,
        rn_event_category('order.live.v1')               AS event_category,
        CAST(NULL AS VARCHAR)                            AS correlation_id,
        brand_id                                         AS partition_key,
        CAST(NULL AS VARCHAR)                            AS anonymous_id,
        CAST(NULL AS VARCHAR)                            AS device_id,
        CAST(1 AS INTEGER)                               AS silver_version,
        {payload}                                        AS payload
      FROM ({derived})
      WHERE event_id IS NOT NULL AND amount_minor IS NOT NULL AND occurred_at_iso IS NOT NULL
    """

    n = merge_collector_event(con, TARGET, good)
    advance_lane_watermark(con, "silver-woocommerce-order-normalize", LANE, hi_woo)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-woocommerce-order-normalize", build,
                      target_table="silver_collector_event_woocommerce_shadow")
