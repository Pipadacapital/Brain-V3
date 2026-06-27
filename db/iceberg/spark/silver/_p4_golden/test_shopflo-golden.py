"""
test_shopflo-golden.py — ADR-0006 P4 byte-exactness proof for the Shopflo normalizer.

Asserts the PySpark-side reference ports (the SHARED _raw_normalize.py primitives + the connector-LOCAL
ports that mirror @brain/shopflo-mapper where its semantics differ from the order exemplar) reproduce,
byte-for-byte, the canonical fields the REAL TypeScript @brain/shopflo-mapper produced — using golden
vectors captured by running the actual TS (shopflo-checkout-golden.json, generated from
mapShopfloCheckoutAbandoned + uuidV5FromShopfloCheckout). This closes the parity loop: if these pass, the
Spark normalizer (whose build UDF folds the SAME ports) is identical to the connector's old TS
normalization, so Silver-from-raw == canonical Silver on money + hashed-PII + the uuid-shaped event_id.

The LOCAL ports below are kept byte-identical to silver_shopflo_normalize.py (the build UDF body). They are
re-declared here rather than imported because the normalizer module imports pyspark at load; this test must
run as plain Python. (This mirrors the order exemplar's test, which re-declares _normalize_order.)

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_shopflo-golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_shopflo-golden.py   (plain assert runner)
"""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import hash_identifier, iso_ms, normalize_phone_in, uuid_shaped  # noqa: E402
from _raw_normalize import money_to_minor_string  # consolidated primitives (ADR-0006)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shopflo-checkout-golden.json")
SHOPFLO_EVENT_NAME = "shopflo.checkout_abandoned.v1"

# ── Connector-LOCAL ports — byte-identical to silver_shopflo_normalize.py ─────────────────────────────
_MONEY_RE = re.compile(r"^\d+(\.\d{1,2})?$")




def to_quantity(value):
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        n = float(value)
    else:
        m = re.match(r"^[+-]?\d+", str(value).strip())
        if not m:
            return 0
        n = float(m.group())
    if math.isfinite(n) and n > 0:
        return int(math.floor(n))
    return 0


def has_address_from(shipping, billing):
    def non_empty(a):
        return isinstance(a, dict) and len(a) > 0

    return non_empty(shipping) or non_empty(billing)


def event_id_shopflo_checkout(brand_id, checkout_id, occurred_at_raw):
    return uuid_shaped(f"{brand_id}:{checkout_id}:{occurred_at_raw}:{SHOPFLO_EVENT_NAME}")


def hash_phone_shopflo(raw_phone, salt_hex, region):
    return hash_identifier(normalize_phone_in(raw_phone, region), "phone", salt_hex, region)


def _coalesce_nullish(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def _normalize_checkout(v):
    """Reproduce the canonical checkout fields from the RAW webhook body using ONLY the ports."""
    p = v["raw"]
    salt = v["salt_hex"]
    brand = v["brand_id"]
    region = v.get("region", "IN")

    checkout_id = str(_coalesce_nullish(p.get("checkout_id"), p.get("cart_token"), "")).strip()
    occ_iso = iso_ms(p.get("occurred_at"), p.get("created_at"))

    eid_cid = p.get("checkout_id") if isinstance(p.get("checkout_id"), str) else ""
    eid_occ = p.get("occurred_at") if isinstance(p.get("occurred_at"), str) else ""
    event_id = event_id_shopflo_checkout(brand, eid_cid, eid_occ)

    customer = p.get("customer")
    if not isinstance(customer, dict):
        customer = {}
    raw_email = _coalesce_nullish(customer.get("email"), p.get("email"))
    raw_phone = _coalesce_nullish(customer.get("phone"), p.get("phone"))
    email_hash = hash_identifier(raw_email, "email", salt, region) if raw_email else None
    phone_hash = hash_phone_shopflo(raw_phone, salt, region) if raw_phone else None
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
    data_source = p.get("data_source") if p.get("data_source") in ("real", "synthetic") else "real"

    return {
        "event_id": event_id,
        "occurred_at": occ_iso,
        "source": "shopflo",
        "data_source": data_source,
        "checkout_id": checkout_id,
        "cart_token": str(p.get("cart_token")) if p.get("cart_token") is not None else None,
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
    }


def test_shopflo_checkout_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize_checkout(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"checkout {v['raw'].get('checkout_id')} field {field}: "
                f"port={got[field]!r} != ts={exp[field]!r}"
            )


if __name__ == "__main__":
    test_shopflo_checkout_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(f"OK — all {n} shopflo golden vectors match the PySpark ports byte-for-byte "
          f"(money + hashed-PII + event_id + time + line_items).")
