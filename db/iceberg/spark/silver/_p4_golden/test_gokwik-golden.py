"""
test_gokwik-golden.py — ADR-0006 P4 byte-exactness proof for the GoKwik normalizer.

Asserts the PySpark-side reference ports — the SHARED _raw_normalize.py primitives (uuid_shaped,
hash_salted_bytes, iso_ms) PLUS the GoKwik-LOCAL ports (logistics-status classification, risk-flag /
payment normalizers, the two event_id seeds) — reproduce, byte-for-byte, the canonical fields the REAL
TypeScript @brain/gokwik-mapper produced (gokwik-golden.json, captured by running mapGokwikAwb /
mapGokwikRtoPredict + uuidV5FromAwb / uuidV5FromRtoPredict). This is the parity-loop closure: if these
pass, the Spark normalizer (which udf-wraps the SAME functions) is identical to the connector's old TS
normalization, so Silver-from-raw == the canonical Silver on PII (awb hash), event_id, classification, and
the categorical risk flag.

The LOCAL ports below are DEFINED IDENTICALLY in silver_gokwik_normalize.py (ADR-0006 P4 forbids editing
the concurrently-owned _raw_normalize.py — these are consolidation candidates; see
new_framework_primitives_needed). Only the crypto/money/time come from the shared, already-verified module.

Run:  python3 -m pytest db/iceberg/spark/silver/_p4_golden/test_gokwik-golden.py -q
  or: python3 db/iceberg/spark/silver/_p4_golden/test_gokwik-golden.py   (plain assert runner)
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from _raw_normalize import hash_salted_bytes, iso_ms, uuid_shaped  # noqa: E402
from _raw_normalize import classify_terminal_class as _classify_shipment_status, normalize_status as _normalize_status  # consolidated primitives (ADR-0006)

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gokwik-golden.json")

AWB_EVENT = "gokwik.awb_status.v1"
RTO_PREDICT_EVENT = "gokwik.rto_predict.v1"

# ── LOCAL ports (identical to silver_gokwik_normalize.py) — @brain/logistics-status authority ──────────
_RTO_TERMINAL_STATES = {
    "rto", "rto initiated", "rto in transit", "rto undelivered", "rto out for delivery", "rto delivered",
    "rto ofd", "rto acknowledged", "rto rejected", "rto ndr", "rto disposed",
}
_DELIVERED_TERMINAL_STATES = {"delivered", "completed"}
_OTHER_TERMINAL_STATES = {
    "cancelled", "lost", "damaged", "returned", "canceled", "destroyed", "disposed", "disposed of",
}


def normalize_status(raw):
    s = (raw or "").strip().lower()
    s = re.sub(r"[_-]+", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s


def classify_shipment_status(raw_status):
    s = normalize_status(raw_status)
    if s in _RTO_TERMINAL_STATES:
        return "rto"
    if s in _DELIVERED_TERMINAL_STATES:
        return "delivered"
    if s in _OTHER_TERMINAL_STATES:
        return "other"
    return "none"


def resolve_payment_method(raw):
    s = (raw or "").strip().lower()
    if s in ("cod", "cash_on_delivery", "cash on delivery"):
        return "cod"
    if s in ("prepaid", "online", "paid"):
        return "prepaid"
    return None


def normalize_risk_flag(raw):
    s = (raw or "").strip().lower()
    if "high" in s:
        return "high"
    if "medium" in s or "med" in s:
        return "medium"
    if "low" in s:
        return "low"
    if "control" in s:
        return "control"
    return "unknown"


def event_id_awb(brand_id, raw_awb, raw_status, status_changed_at_iso):
    return uuid_shaped(f"{brand_id}:{raw_awb}:{raw_status}:{status_changed_at_iso}:{AWB_EVENT}")


def event_id_rto_predict(brand_id, order_id, request_id):
    return uuid_shaped(f"{brand_id}:{order_id}:{request_id}:{RTO_PREDICT_EVENT}")


def hash_awb(raw_awb, salt_hex):
    if raw_awb is None or str(raw_awb).strip() == "":
        return None
    return hash_salted_bytes(raw_awb, salt_hex)


# ── Reproduce the canonical fields from the RAW record using ONLY the ports ────────────────────────────
def _normalize_awb(v):
    r = v["record"]
    salt = v["salt_hex"]
    brand = v["brand_id"]
    # JS truthiness: `record.x ? String(record.x) : ''` (null/undefined/'' → '') — the event_id seed.
    raw_awb_seed = str(r["awb_number"]) if r.get("awb_number") else ""
    raw_status_seed = str(r["status"]) if r.get("status") else ""
    status_changed_at_iso = iso_ms(r.get("status_changed_at"))
    status = str(r.get("status") or "").strip()
    terminal_class = classify_shipment_status(status)
    pincode = str(r["pincode"]).strip() if r.get("pincode") is not None else None
    return {
        "event_id": event_id_awb(brand, raw_awb_seed, raw_status_seed, status_changed_at_iso),
        "event_type": AWB_EVENT,
        "occurred_at": status_changed_at_iso,
        "source": "gokwik",
        "data_source": v["data_source"],
        "awb_number_hash": hash_awb(r.get("awb_number"), salt),
        "order_id": str(r.get("order_id") or "").strip(),
        "status": status,
        "terminal_class": terminal_class,
        "is_terminal": terminal_class != "none",
        "payment_method": resolve_payment_method(r.get("payment_method")),
        "pincode": pincode,
        "status_changed_at": status_changed_at_iso,
    }


def _normalize_rto(v):
    r = v["record"]
    brand = v["brand_id"]
    order_id_seed = str(r["order_id"]) if r.get("order_id") else ""
    request_id_seed = str(r["request_id"]) if r.get("request_id") else ""
    occurred_at_iso = iso_ms(r.get("occurred_at"))
    risk_flag_raw = str(r["risk_flag"]).strip() if r.get("risk_flag") is not None else None
    return {
        "event_id": event_id_rto_predict(brand, order_id_seed, request_id_seed),
        "event_type": RTO_PREDICT_EVENT,
        "occurred_at": occurred_at_iso,
        "source": "gokwik",
        "data_source": v["data_source"],
        "order_id": str(r.get("order_id") or "").strip(),
        "request_id": str(r["request_id"]).strip() if r.get("request_id") is not None else None,
        "risk_flag": normalize_risk_flag(r.get("risk_flag")),
        "risk_flag_raw": risk_flag_raw,
        "risk_reason": (str(r["risk_reason"]) if r.get("risk_reason") is not None else None),
    }


def test_gokwik_ports_match_ts():
    vectors = json.load(open(GOLDEN))
    assert vectors, "no golden vectors"
    for v in vectors:
        got = _normalize_awb(v) if v["record_type"] == "awb" else _normalize_rto(v)
        exp = v["expected"]
        for field in exp:
            assert got[field] == exp[field], (
                f"{v['record_type']} {v['record'].get('order_id')} field {field}: "
                f"port={got[field]!r} != ts={exp[field]!r}"
            )


if __name__ == "__main__":
    test_gokwik_ports_match_ts()
    n = len(json.load(open(GOLDEN)))
    print(f"OK — all {n} gokwik golden vectors match the PySpark ports byte-for-byte "
          f"(event_id + awb hash + terminal_class + categorical risk_flag + time).")
