"""
silver_shopflo_normalize.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_shopflo_normalize.py (ADR-0006 P4; SHADOW-ONLY parity oracle).

Reads the RAW Shopflo checkout_abandoned webhook Bronze (the ADR-0010 Kafka-Connect `shopflo_checkout_raw_connect`
lane — the verbatim HMAC-verified webhook body as a JSON string in `payload`, server-stamped with a trusted
brand_id envelope), reconstructs the canonical shopflo.checkout_abandoned.v1 envelope in `payload`, and MERGEs
the silver_collector_event 14-column contract into the SHADOW table silver_collector_event_shopflo_shadow
(dual-run parity; TARGET_TABLE / MIGRATION_TABLE_SUFFIX override). The LIVE boundary is the TS webhook mapper
— this is a SHADOW-ONLY parity tool and MUST NOT be cut to the live silver_collector_event.

CORRECTNESS: the whole mapper (mapShopfloCheckoutAbandoned + the handler's event_id stamp) is folded in ONE
build port that reads the verbatim webhook body as a JSON string and internally calls the shared VENDORED
primitives (_raw_normalize_ports.hash_identifier / normalize_phone_in / iso_ms / uuid_shaped / money_to_minor_string)
— preserving the exact provider structure (null keys, number forms). Money is bigint MINOR + currency_code;
PII (email/phone) is hashed-only. brand_id is server-trusted from the envelope column ONLY (MT-1).

STAGE-1 QUARANTINE SKIPPED (parity-preserving, per the migration rule): the Spark job routes the inline
drop-gate complement (build returns NULLs on missing checkout_id / un-parseable money / no timestamp) to
silver_quarantine (stage='dq'). This port does NOT write that diagnostic ledger — Bronze keeps the originals
(replay-safe). The ADMITTED (good-row) set is IDENTICAL: the same `event_id & payload & occurred_at IS NOT
NULL` predicate is applied before the MERGE.

Parity target: brain_silver.silver_collector_event_shopflo_shadow (empty lane today → 0 rows, HONEST-EMPTY).
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _normalize_base import (  # noqa: E402
    connect_source_table, ensure_shadow, merge_collector_event, register_salts, run_normalize_job,
    source_present,
)
import _raw_normalize_ports as rn  # noqa: E402
from _raw_normalize_ports import money_to_minor_string  # noqa: E402
from _silver_technical_ports import event_category  # noqa: E402

SHOPFLO_EVENT_NAME = "shopflo.checkout_abandoned.v1"

LANE = "shopflo_checkout_raw"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}." + os.environ.get(
    "TARGET_TABLE", "silver_collector_event_shopflo_shadow"
) + os.environ.get("MIGRATION_TABLE_SUFFIX", "")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")

# Envelope column names (server-trusted brand_id ONLY from here — MT-1 — never from the webhook body).
BRAND_COL = os.environ.get("RAW_BRAND_COL", "brand_id")
INGESTED_COL = os.environ.get("RAW_INGESTED_COL", "fetched_at")
RAW_PAYLOAD_COL = os.environ.get("RAW_PAYLOAD_COL", "payload")


# ── Connector-LOCAL ports — mirror @brain/shopflo-mapper EXACTLY (byte-verified in test_shopflo-golden.py). ─
def to_quantity(value):
    """toQuantity — number passthrough; else parseInt(trim,10); finite & >0 → floor; else 0."""
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        n = float(value)
    else:
        import re
        m = re.match(r"^[+-]?\d+", str(value).strip())
        if not m:
            return 0
        n = float(m.group())
    if math.isfinite(n) and n > 0:
        return int(math.floor(n))
    return 0


def has_address_from(shipping, billing):
    """hasAddress — a non-empty shipping OR billing object (counts null-valued keys)."""
    def non_empty(a):
        return isinstance(a, dict) and len(a) > 0
    return non_empty(shipping) or non_empty(billing)


def event_id_shopflo_checkout(brand_id, checkout_id, occurred_at_raw):
    return rn.uuid_shaped(f"{brand_id}:{checkout_id}:{occurred_at_raw}:{SHOPFLO_EVENT_NAME}")


def hash_phone_shopflo(raw_phone, salt_hex, region):
    """The mapper normalizes the phone FIRST then hashes via hashIdentifier('phone') (re-normalizes) —
    hashed input is normalize(normalize(raw)). Mirrored byte-for-byte."""
    normalized = rn.normalize_phone_in(raw_phone, region)
    return rn.hash_identifier(normalized, "phone", salt_hex, region)


def _coalesce_nullish(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def build_shopflo_canonical(payload_json, brand_id, salt_hex, region):
    """Fold mapShopfloCheckoutAbandoned + the handler's event_id stamp. Returns (event_id, occurred_at_iso,
    payload_json). On any failure (missing checkout_id / un-parseable money / no timestamp) → (None, None, None)."""
    try:
        p = json.loads(payload_json) if isinstance(payload_json, str) else (payload_json or {})
        if not isinstance(p, dict):
            return (None, None, None)

        raw_cid = p.get("checkout_id")
        raw_cart = p.get("cart_token")
        checkout_id = str(_coalesce_nullish(raw_cid, raw_cart, "")).strip()
        if not checkout_id:
            return (None, None, None)

        occ_iso = rn.iso_ms(p.get("occurred_at"), p.get("created_at"))
        if occ_iso is None:
            return (None, None, None)

        eid_cid = p.get("checkout_id") if isinstance(p.get("checkout_id"), str) else ""
        eid_occ = p.get("occurred_at") if isinstance(p.get("occurred_at"), str) else ""
        event_id = event_id_shopflo_checkout(brand_id, eid_cid, eid_occ)

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
            data_source = "real"

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


def _register_udfs(con) -> None:
    build_type = "STRUCT(event_id VARCHAR, occurred_at VARCHAR, payload VARCHAR)"
    con.create_function(
        "rn_build",
        lambda payload, brand, salt: (lambda t: {"event_id": t[0], "occurred_at": t[1], "payload": t[2]})(
            build_shopflo_canonical(payload, brand, salt, REGION)
        ),
        ["VARCHAR", "VARCHAR", "VARCHAR"], build_type, null_handling="special",
    )
    con.create_function("rn_event_category", event_category, ["VARCHAR"], "VARCHAR", null_handling="special")


def build(con):
    ensure_shadow(con, TARGET)
    if not source_present(con, LANE):
        print(f"[silver-shopflo-normalize] {connect_source_table(LANE)} absent/empty — skipping "
              f"(empty lane; table auto-creates on first record, ADR-0010)", flush=True)
        return TARGET, 0
    _register_udfs(con)
    register_salts(con)
    src = connect_source_table(LANE)

    df = f"""
      SELECT
        CAST({BRAND_COL} AS VARCHAR)                     AS brand_id,
        CAST({INGESTED_COL} AS TIMESTAMP)                AS ingested_at_raw,
        CAST({RAW_PAYLOAD_COL} AS VARCHAR)               AS payload_raw
      FROM {src}
    """

    joined = f"SELECT d.*, sl.salt_hex FROM ({df}) d LEFT JOIN _salts sl ON d.brand_id = sl.brand_id"

    built = f"""
      SELECT brand_id, ingested_at_raw,
             rn_build(payload_raw, brand_id, salt_hex) AS c
      FROM ({joined})
    """

    good = f"""
      SELECT
        c.event_id                                       AS event_id,
        brand_id,
        CAST(c.occurred_at AS TIMESTAMP)                 AS occurred_at,
        coalesce(ingested_at_raw, now())                 AS ingested_at,
        'brain.collector.event.v1'                       AS schema_name,
        CAST(1 AS INTEGER)                               AS schema_version,
        '{SHOPFLO_EVENT_NAME}'                           AS event_type,
        rn_event_category('{SHOPFLO_EVENT_NAME}')        AS event_category,
        CAST(NULL AS VARCHAR)                            AS correlation_id,
        brand_id                                         AS partition_key,
        CAST(NULL AS VARCHAR)                            AS anonymous_id,
        CAST(NULL AS VARCHAR)                            AS device_id,
        CAST(1 AS INTEGER)                               AS silver_version,
        c.payload                                        AS payload
      FROM ({built})
      WHERE c.event_id IS NOT NULL AND c.payload IS NOT NULL AND c.occurred_at IS NOT NULL
    """

    n = merge_collector_event(con, TARGET, good)
    return TARGET, n


if __name__ == "__main__":
    run_normalize_job("silver-shopflo-normalize", build,
                      target_table="silver_collector_event_shopflo_shadow")
