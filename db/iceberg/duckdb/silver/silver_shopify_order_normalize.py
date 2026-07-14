"""
silver_shopify_order_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_shopify_order_normalize.py (ADR-0006 P4 EXEMPLAR).

Reads the RAW Shopify order Bronze (the ADR-0010 Kafka-Connect `shopify_orders_raw_connect` lane — the
verbatim provider order nested under `order`), reconstructs the canonical order.live.v1 envelope in `payload`,
and MERGEs the silver_collector_event 14-column contract into the SHADOW table
silver_collector_event_shopify_shadow (dual-run parity; TARGET_TABLE / MIGRATION_TABLE_SUFFIX override).
Downstream silver_order_state / silver_order_line read the shadow with ZERO change.

CORRECTNESS: every field goes through the VENDORED, golden-verified pure ports (_raw_normalize_ports) —
udf-wrapped as DuckDB scalar functions, so the DuckDB output == the verified Python == the TS == the Spark
port. PK is (brand_id, event_id); money is BIGINT minor + currency_code; PII is hashed-only.

SALT / PII PARITY: the per-brand salt LEFT-join (register_salts → PG tenancy.brand). A brand NOT in PG (e.g.
the smoke fixture 'brand-smoke-1') MISSES → salt_hex NULL → hash_identifier renders it as the literal 'None'
(sha256("None||smoke@example.com")) — verified byte-exact against the 2-row live shadow oracle.

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (un-seedable event_id / malformed money / unparseable ts) to silver_quarantine
(stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals (replay-safe) so it
can be rebuilt separately. The ADMITTED (good-row) set is IDENTICAL: the same `event_id IS NOT NULL AND
amount_minor IS NOT NULL AND occurred_at_iso IS NOT NULL` predicate is applied before the MERGE.

Parity target: brain_silver.silver_collector_event_shopify_shadow (Spark oracle = 2 rows from 292 raw).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    connect_source_table, ensure_shadow, merge_collector_event, register_salts, run_normalize_job,
    source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

LANE = "shopify_orders_raw"
# Shadow by default (dual-run parity). TARGET_TABLE cuts to the live silver_collector_event at cutover;
# MIGRATION_TABLE_SUFFIX writes a *_duckdb_test twin for the parallel-run parity harness.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_shopify_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")


def _register_udfs(con) -> None:
    con.create_function("rn_minor", rn.decimal_to_minor_strict, ["VARCHAR"], "BIGINT", null_handling="special")
    con.create_function("rn_classify", rn.classify_payment, ["VARCHAR", "VARCHAR[]", "VARCHAR"], "VARCHAR",
                        null_handling="special")
    con.create_function("rn_hash_email",
                        lambda v, salt: rn.hash_identifier(v, "email", salt, REGION) if v else None,
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_hash_phone",
                        lambda v, salt: rn.hash_identifier(v, "phone", salt, REGION) if v else None,
                        ["VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_iso3", lambda a, b, c: rn.iso_ms(a, b, c),
                        ["VARCHAR", "VARCHAR", "VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_iso1", lambda a: rn.iso_ms(a) if a else None,
                        ["VARCHAR"], "VARCHAR", null_handling="special")
    con.create_function("rn_epoch", lambda a: rn.epoch_ms(a) if a else None,
                        ["VARCHAR"], "BIGINT", null_handling="special")
    con.create_function("rn_eid_order",
                        lambda brand, oid, ms: rn.event_id_order_live(brand, oid, ms)
                        if (brand and oid and ms is not None) else None,
                        ["VARCHAR", "VARCHAR", "BIGINT"], "VARCHAR", null_handling="special")
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def build(con):
    ensure_shadow(con, TARGET)
    if not source_present(con, LANE):
        print(f"[silver-shopify-order-normalize] {connect_source_table(LANE)} absent/empty — skipping "
              f"(empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    _register_udfs(con)
    register_salts(con)
    src = connect_source_table(LANE)

    # Project the fields the order marts need off the nested `order` struct (a reserved word → quoted).
    df = f"""
      SELECT
        CAST(brand_id AS VARCHAR)                       AS brand_id,
        CAST(fetched_at AS VARCHAR)                     AS fetched_at,
        CAST("order".id AS VARCHAR)                     AS order_id,
        CAST("order".currency AS VARCHAR)               AS currency_code,
        CAST("order".current_total_price AS VARCHAR)    AS price_str,
        CAST("order".financial_status AS VARCHAR)       AS financial_status,
        CAST("order".fulfillment_status AS VARCHAR)     AS fulfillment_status,
        CAST("order".gateway AS VARCHAR)                AS gateway,
        "order".payment_gateway_names                   AS gateway_names,
        CAST("order".updated_at AS VARCHAR)             AS updated_at,
        CAST("order".processed_at AS VARCHAR)           AS processed_at,
        CAST("order".created_at AS VARCHAR)             AS created_at,
        CAST("order".cancelled_at AS VARCHAR)           AS cancelled_at,
        CAST("order".customer.email AS VARCHAR)         AS cust_email,
        CAST("order".customer.phone AS VARCHAR)         AS cust_phone
      FROM {src}
    """

    # Per-brand salt LEFT join (NULL salt on a miss → literal "None" in the hash — Spark parity).
    joined = f"SELECT d.*, sl.salt_hex FROM ({df}) d LEFT JOIN _salts sl ON d.brand_id = sl.brand_id"

    gated = f"""
      SELECT *,
        rn_iso3(updated_at, processed_at, created_at)                    AS occurred_at_iso,
        rn_minor(price_str)                                             AS amount_minor,
        rn_classify(gateway, gateway_names, financial_status)          AS payment_method,
        rn_hash_email(cust_email, salt_hex)                             AS hashed_customer_email,
        rn_hash_phone(cust_phone, salt_hex)                             AS hashed_customer_phone,
        rn_iso1(cancelled_at)                                          AS cancelled_at_iso,
        rn_eid_order(brand_id, order_id, rn_epoch(updated_at))         AS event_id
      FROM ({joined})
    """

    # Reconstruct the canonical order.live.v1 envelope as `payload`. json_object drops NULL fields (Spark
    # to_json(struct(...)) also omits null struct fields) — so an absent fulfillment_status / cancelled_at /
    # hashed_customer_phone is OMITTED, matching the oracle payloads exactly.
    props = (
        "json_object("
        "'source','shopify',"
        "'order_id', order_id,"
        "'shopify_order_id', order_id,"
        "'amount_minor', CAST(amount_minor AS VARCHAR),"
        "'currency_code', currency_code,"
        "'payment_method', payment_method,"
        "'financial_status', financial_status,"
        "'fulfillment_status', fulfillment_status,"
        "'cancelled_at', cancelled_at_iso,"
        "'hashed_customer_email', hashed_customer_email,"
        "'hashed_customer_phone', hashed_customer_phone)"
    )
    payload = (
        "json_object('event_name','order.live.v1','occurred_at', occurred_at_iso, 'properties', "
        f"{props})"
    )

    good = f"""
      SELECT
        event_id,
        brand_id,
        CAST(occurred_at_iso AS TIMESTAMP)              AS occurred_at,
        CAST(fetched_at AS TIMESTAMP)                   AS ingested_at,
        'brain.collector.event.v1'                      AS schema_name,
        CAST(1 AS INTEGER)                              AS schema_version,
        'order.live.v1'                                 AS event_type,
        rn_event_category('order.live.v1')             AS event_category,
        CAST(NULL AS VARCHAR)                           AS correlation_id,
        brand_id                                        AS partition_key,
        CAST(NULL AS VARCHAR)                           AS anonymous_id,
        CAST(NULL AS VARCHAR)                           AS device_id,
        CAST(1 AS INTEGER)                              AS silver_version,
        {payload}                                       AS payload
      FROM ({gated})
      WHERE event_id IS NOT NULL AND amount_minor IS NOT NULL AND occurred_at_iso IS NOT NULL
    """

    n = merge_collector_event(con, TARGET, good)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-shopify-order-normalize", build,
                      target_table="silver_collector_event_shopify_shadow")
