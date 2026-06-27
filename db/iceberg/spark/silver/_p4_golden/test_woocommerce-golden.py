"""
test_woocommerce-golden.py — ADR-0006 P4 byte-exactness proof for the WooCommerce normalizer.

Asserts the PySpark-side reference ports — the SHARED ones in _raw_normalize.py PLUS the three
WooCommerce-LOCAL helpers (woo_to_utc_iso, classify_payment_woo, and the occurred_at-seeded event_id) —
reproduce, byte-for-byte, the canonical fields the REAL TypeScript @brain/woocommerce-mapper produced,
using golden vectors captured by running the actual TS (woocommerce-order-golden.json, generated from
mapWooOrderToEvent + uuidV5FromOrderLive in gen-woocommerce-golden.ts). This is the parity loop closure:
if these pass, the Spark normalizer (which udf-wraps the SAME functions) is identical to the connector's
old TS normalization, so Silver-from-raw == canonical Silver on money + PII + event_id + time.

The LOCAL helpers below are intentional copies of the ones in silver_woocommerce_normalize.py — kept here
so the test has no Spark dependency. They are LISTED for later consolidation into _raw_normalize.py.

Run:  python3 -m pytest "db/iceberg/spark/silver/_p4_golden/test_woocommerce-golden.py" -q
  or: python3 "db/iceberg/spark/silver/_p4_golden/test_woocommerce-golden.py"   (plain assert runner)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import (  # noqa: E402
    decimal_to_minor_strict, epoch_ms, event_id_order_live, hash_identifier, iso_ms,
    iso_ms_assume_utc as woo_to_utc_iso,
)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "woocommerce-order-golden.json")

# ── WooCommerce-LOCAL helpers (mirror silver_woocommerce_normalize.py) ────────────────────────────────
_WOO_TZ_RE = re.compile(r"([zZ]$)|([+-]\d{2}:?\d{2}$)")
_WOO_COD_METHODS = {"cod", "cash_on_delivery", "cheque"}




def classify_payment_woo(payment_method, payment_method_title):
    method = (payment_method or "").lower()
    title = (payment_method_title or "").lower()
    if method in _WOO_COD_METHODS:
        return "cod"
    if "cash on delivery" in title or "cod" in title:
        return "cod"
    return "prepaid"


def _normalize_order(v):
    """Reproduce the order-level canonical fields from the RAW Woo order using the shared + local ports."""
    o = v["raw_order"]
    salt = v["salt_hex"]
    brand = v["brand_id"]
    occurred = woo_to_utc_iso(o.get("date_modified_gmt") or o.get("date_created_gmt"))
    occurred_ms = epoch_ms(occurred)  # == Date.parse(occurred_at) in the Woo live lane
    status = (o.get("status") or "").lower()
    billing = o.get("billing") or {}
    cust_id = o.get("customer_id")
    return {
        "event_id": event_id_order_live(brand, str(o["id"]), occurred_ms),
        "occurred_at": occurred,
        "amount_minor": str(decimal_to_minor_strict(str(o.get("total") or "0"))),
        "currency_code": (o.get("currency") or "INR").upper(),
        "payment_method": classify_payment_woo(o.get("payment_method"), o.get("payment_method_title")),
        "financial_status": status or None,
        "fulfillment_status": status or None,
        "cancelled_at": occurred if status == "cancelled" else None,
        "hashed_customer_email": hash_identifier(billing["email"], "email", salt) if billing.get("email") else None,
        "hashed_customer_phone": hash_identifier(billing["phone"], "phone", salt) if billing.get("phone") else None,
        "storefront_customer_id": str(cust_id) if (cust_id is not None and str(cust_id) != "0") else None,
    }


def test_woocommerce_order_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize_order(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"order {v['raw_order']['id']} field {field}: port={got[field]!r} != ts={exp[field]!r}"
            )


if __name__ == "__main__":
    test_woocommerce_order_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(f"OK — all {n} woocommerce golden vectors match the PySpark ports byte-for-byte (money + PII + event_id + time).")
