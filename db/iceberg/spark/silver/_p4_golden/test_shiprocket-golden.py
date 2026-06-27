"""
test_shiprocket-golden.py — ADR-0006 P4 byte-exactness proof for the Shiprocket normalizer.

Asserts the PySpark-side reference ports reproduce, byte-for-byte, the canonical fields the REAL
TypeScript @brain/shiprocket-mapper produced — using golden vectors captured by running the actual TS
(shiprocket-shipment-golden.json, generated from mapShiprocketShipment + uuidV5FromShipment). This is
the parity-loop closure: if these pass, the Spark normalizer (which udf-wraps the SAME functions) is
identical to the connector's old TS normalization, so Silver-from-raw == canonical Silver on the AWB
hash (hash_salted_bytes — salt-hex convention), the uuid-shaped event_id, and the terminal_class.

Logistics is MONEY-FREE: the parity analogue is the terminal_class multiset (rto/delivered/other/none),
the revenue-bearing outcome the cod/rto ledger keys on. The status->terminal_class authority is the
3 FROZEN label sets from @brain/logistics-status, ported LOCALLY here (not in _raw_normalize.py — it is
a connector-local helper pending shared-framework consolidation; see new_framework_primitives_needed).

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_shiprocket-golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_shiprocket-golden.py   (plain assert runner)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import hash_salted_bytes, iso_ms, uuid_shaped  # noqa: E402
from _raw_normalize import classify_terminal_class as _classify_shipment_status, normalize_status as _normalize_status  # consolidated primitives (ADR-0006)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shiprocket-shipment-golden.json")

# ── Connector-local port of @brain/logistics-status (the FROZEN authority — keep in lockstep) ──────────
# These 3 label sets are byte-copied from packages/logistics-status/src/index.ts. If that frozen set
# changes (Architect sign-off), update here AND in silver_shiprocket_normalize.py.
_RTO_TERMINAL = {
    "rto", "rto initiated", "rto in transit", "rto undelivered", "rto out for delivery",
    "rto delivered", "rto ofd", "rto acknowledged", "rto rejected", "rto ndr", "rto disposed",
}
_DELIVERED_TERMINAL = {"delivered", "completed"}
_OTHER_TERMINAL = {
    "cancelled", "lost", "damaged", "returned", "canceled", "destroyed", "disposed", "disposed of",
}


def normalize_status(raw):
    """@brain/logistics-status normalizeStatus — lower(trim), fold [_-]+ -> ' ', collapse spaces."""
    s = (raw or "").strip().lower()
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s


def classify_shipment_status(raw):
    """@brain/logistics-status classifyShipmentStatus — deterministic terminal_class, no model."""
    s = normalize_status(raw)
    if s in _RTO_TERMINAL:
        return "rto"
    if s in _DELIVERED_TERMINAL:
        return "delivered"
    if s in _OTHER_TERMINAL:
        return "other"
    return "none"


def resolve_payment_method(raw):
    """@brain/shiprocket-mapper resolvePaymentMethod — cod | prepaid | None."""
    s = (raw or "").strip().lower()
    if s in ("cod", "cash_on_delivery", "cash on delivery"):
        return "cod"
    if s in ("prepaid", "online", "paid"):
        return "prepaid"
    return None


def event_id_shipment(brand_id, awb, status, status_changed_at_iso):
    """uuidV5FromShipment(brand, awb, status, statusChangedAt) — uuid_shaped over the seed. Mirrors the
    shiprocket-shipment-repull path: raw (untrimmed) awb/status; ISO-normalized status_changed_at."""
    return uuid_shaped(f"{brand_id}:{awb}:{status}:{status_changed_at_iso}:shiprocket.shipment_status.v1")


def _normalize_shipment(v):
    """Reproduce the canonical shipment fields from the RAW record using ONLY the shared ports
    (_raw_normalize) + the connector-local logistics-status port above."""
    r = v["raw_shipment"]
    salt = v["salt_hex"]
    brand = v["brand_id"]

    raw_awb = str(r["awb"]) if r.get("awb") else ""          # untrimmed — event_id seed component
    raw_status = str(r["status"]) if r.get("status") else ""  # untrimmed — event_id seed component
    status_changed_at = iso_ms(r.get("status_changed_at"))

    awb_trim = str(r["awb"]).strip() if r.get("awb") is not None else ""
    awb_hash = hash_salted_bytes(awb_trim, salt) if awb_trim else None

    tc = classify_shipment_status(raw_status)
    return {
        "event_id": event_id_shipment(brand, raw_awb, raw_status, status_changed_at),
        "occurred_at": status_changed_at,
        "status_changed_at": status_changed_at,
        "awb_number_hash": awb_hash,
        "order_id": str(r["order_id"]).strip(),
        "status": raw_status.strip(),
        "terminal_class": tc,
        "is_terminal": tc != "none",
        "payment_method": resolve_payment_method(r.get("payment_method")),
        "pincode": str(r["pincode"]).strip() if r.get("pincode") is not None else None,
        "courier": (str(r["courier"]).strip() or None) if r.get("courier") is not None else None,
    }


def test_shiprocket_shipment_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize_shipment(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"shipment {v['raw_shipment']['order_id']} field {field}: "
                f"port={got[field]!r} != ts={exp[field]!r}"
            )


def test_shiprocket_terminal_class_multiset_parity():
    """MONEY-FREE parity analogue: the terminal_class multiset the ports derive must equal the TS one."""
    vectors = json.load(open(GOLDEN))
    got = sorted(_normalize_shipment(v)["terminal_class"] for v in vectors)
    exp = sorted(v["expected"]["terminal_class"] for v in vectors)
    assert got == exp, f"terminal_class multiset drift: port={got} != ts={exp}"


if __name__ == "__main__":
    test_shiprocket_shipment_ports_match_ts()
    test_shiprocket_terminal_class_multiset_parity()
    n = len(json.load(open(GOLDEN)))
    print(
        f"OK — all {n} shiprocket golden vectors match the PySpark ports byte-for-byte "
        f"(AWB hash + event_id + time + terminal_class multiset)."
    )
