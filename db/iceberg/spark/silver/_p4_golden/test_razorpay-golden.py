"""
test_razorpay-golden.py — ADR-0006 P4 byte-exactness proof for the Razorpay normalizer.

Asserts the PySpark-side reference ports — the SHARED _raw_normalize.py primitives (uuid_shaped,
hash_salted_bytes) PLUS the Razorpay-LOCAL ports (paisa-passthrough money, unix-seconds→ISO, the entity_type
/ reconciliation resolvers, the two settlement event_id seeds) — reproduce, byte-for-byte, the canonical
settlement.live.v1 fields the REAL TypeScript @brain/razorpay-mapper produced (razorpay-settlement-golden.json,
captured by running mapSettlementItemToEvent + uuidV5FromSettlementItem / uuidV5FromSettlementSummary). This
is the parity-loop closure: if these pass, the Spark normalizer (which udf-wraps the SAME functions) is
identical to the connector's old TS normalization, so Silver-from-raw == the canonical Silver on money
(bigint paisa minor + currency), C1 hashed-PII (payment_id_hash / utr_hash), and the uuid-shaped event_id.

The LOCAL ports below are DEFINED IDENTICALLY in silver_razorpay_normalize.py (ADR-0006 P4 forbids editing
the concurrently-owned _raw_normalize.py — these are consolidation candidates; see
new_framework_primitives_needed). Only the crypto (hash_salted_bytes) + the uuid shaping (uuid_shaped) come
from the shared, already-verified module — the EXACT @brain/razorpay-mapper hashRazorpayId convention is
hash_salted_bytes = sha256( bytes.fromhex(salt) ++ utf8(lower(trim(value))) ).

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_razorpay-golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_razorpay-golden.py   (plain assert runner)
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import hash_salted_bytes, uuid_shaped  # noqa: E402

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "razorpay-settlement-golden.json")

_ENTITY_TYPES = {"payment", "refund", "adjustment", "reserve_deduction"}


# ── LOCAL ports (identical to silver_razorpay_normalize.py) ────────────────────────────────────────────
def paisa_to_minor_string(value):
    if value is None:
        return "0"
    s = str(value).strip()
    if s == "":
        return "0"
    if not re.match(r"^\d+$", s):
        return None
    return s


def razorpay_unix_to_iso(value):
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
    v = (raw or "").strip().lower()
    return v if v in _ENTITY_TYPES else "payment"


def reconciliation_type(entity_type, raw_payment_id):
    if not raw_payment_id or entity_type == "adjustment":
        return "brand_level"
    return "per_order"


def settlement_event_id(brand_id, settlement_id, raw_payment_id, entity_type):
    if not (brand_id and settlement_id):
        return None
    if raw_payment_id:
        return uuid_shaped(f"{brand_id}:{settlement_id}:{raw_payment_id}:{entity_type}:settlement.live.v1")
    return uuid_shaped(f"{brand_id}:{settlement_id}:summary:settlement.live.v1")


# ── Reproduce the canonical fields from the RAW recon item using ONLY the ports ────────────────────────
def _normalize_item(v):
    it = v["raw_item"]
    salt = v["salt_hex"]
    brand = v["brand_id"]
    settlement_id = str(it.get("settlement_id") or "")
    raw_pid = str(it["payment_id"]) if it.get("payment_id") is not None else None
    raw_utr = str(it["utr"]) if it.get("utr") is not None else None
    order_id = str(it["order_id"]) if it.get("order_id") is not None else None
    entity = resolve_entity_type(it.get("entity_type"))
    # currency: (currency ?? 'INR').trim().toUpperCase() — '??' is null-only, so a provided value passes through.
    currency = str(it["currency"]).strip().upper() if it.get("currency") is not None else "INR"
    settled = razorpay_unix_to_iso(it.get("settled_at"))
    occurred = settled or razorpay_unix_to_iso(it.get("created_at"))
    return {
        "event_id": settlement_event_id(brand, settlement_id, raw_pid, entity),
        "occurred_at": occurred,
        "source": "razorpay",
        "settlement_id": settlement_id,
        "payment_id_hash": hash_salted_bytes(raw_pid, salt) if raw_pid else None,
        "order_id": order_id,
        "utr_hash": hash_salted_bytes(raw_utr, salt) if raw_utr else None,
        "amount_minor": paisa_to_minor_string(it.get("amount")),
        "fee_minor": paisa_to_minor_string(it.get("fee")),
        "tax_minor": paisa_to_minor_string(it.get("tax")),
        "currency_code": currency,
        "entity_type": entity,
        "status": str(it["status"]) if it.get("status") is not None else None,
        "settlement_at": settled,
        "reconciliation_type": reconciliation_type(entity, raw_pid),
    }


def test_razorpay_settlement_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize_item(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"settlement {v['raw_item'].get('settlement_id')} field {field}: "
                f"port={got[field]!r} != ts={exp[field]!r}"
            )


if __name__ == "__main__":
    test_razorpay_settlement_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(f"OK — all {n} razorpay golden vectors match the PySpark ports byte-for-byte "
          f"(event_id + payment_id/utr hash + paisa-minor money + entity_type/reconciliation + time).")
