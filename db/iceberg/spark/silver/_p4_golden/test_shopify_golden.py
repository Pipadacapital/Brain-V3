"""
test_shopify_golden.py — ADR-0006 P4 byte-exactness proof for the Shopify exemplar.

Asserts the PySpark-side reference ports in _raw_normalize.py reproduce, byte-for-byte, the canonical
fields the REAL TypeScript @brain/shopify-mapper produced — using golden vectors captured by running the
actual TS (shopify-order-golden.json, generated from mapOrderToEvent + uuidV5FromOrderLive). This is the
parity loop closure: if these pass, the Spark normalizer (which udf-wraps the SAME functions) is identical
to the connector's old TS normalization, so Silver-from-raw == canonical Silver on money + PII + event_id.

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_shopify_golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_shopify_golden.py   (plain assert runner)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import (  # noqa: E402
    classify_payment, decimal_to_minor_strict, epoch_ms, event_id_order_live, hash_identifier, iso_ms,
)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shopify-order-golden.json")


def _normalize_order(v):
    """Reproduce the order-level canonical fields from the RAW order using ONLY the shared ports."""
    o = v["raw_order"]
    salt = v["salt_hex"]
    brand = v["brand_id"]
    updated_ms = epoch_ms(o["updated_at"])
    cust = o.get("customer") or {}
    return {
        "event_id": event_id_order_live(brand, str(o["id"]), updated_ms),
        "occurred_at": iso_ms(o.get("updated_at"), o.get("processed_at"), o.get("created_at")),
        "amount_minor": str(decimal_to_minor_strict(o["current_total_price"])),
        "currency_code": o["currency"],
        "payment_method": classify_payment(o.get("gateway"), o.get("payment_gateway_names"), o.get("financial_status")),
        "financial_status": o.get("financial_status"),
        "cancelled_at": iso_ms(o["cancelled_at"]) if o.get("cancelled_at") else None,
        "hashed_customer_email": hash_identifier(cust["email"], "email", salt) if cust.get("email") else None,
        "hashed_customer_phone": hash_identifier(cust["phone"], "phone", salt) if cust.get("phone") else None,
    }


def test_shopify_order_ports_match_ts():
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
    test_shopify_order_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(f"OK — all {n} shopify golden vectors match the PySpark ports byte-for-byte (money + PII + event_id + time).")
