"""
_silver_technical_test.py — pure-python golden/unit coverage for the Stage-1 technical-processing ports.

Mirrors the _p4_golden suite style: NO Spark needed (the quarantine sink is the only Spark-touching part of
_silver_technical and is excluded here — the pure ports are what carry the data-correctness contract). Run:

    python3 db/iceberg/spark/silver/_silver_technical_test.py
  or: python3 -m pytest db/iceberg/spark/silver/_silver_technical_test.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _silver_technical import (  # noqa: E402
    ACTION_ACCEPT, ACTION_QUARANTINE, SCHEMA_MISSING, SCHEMA_OK, SCHEMA_UNKNOWN, SCHEMA_WRONG_TYPE,
    clean_name, clean_string, dq_check, event_category, event_order_key, event_order_key_str,
    inactive_campaign_conversion_flag, schema_policy, validate_payment_amount, validate_refund_timing,
    validate_schema,
)

# A fixed "now" so future-timestamp checks are deterministic: 2026-06-28T00:00:00Z in ms.
NOW_MS = 1_782_604_800_000

REQUIRED = ["order_id", "amount_minor", "currency_code"]
KNOWN = REQUIRED + ["occurred_at", "note"]
TYPES = {"order_id": "string", "amount_minor": "money", "currency_code": "currency", "occurred_at": "timestamp"}


def test_schema_ok():
    payload = {"order_id": "A1", "amount_minor": "1999", "currency_code": "INR"}
    status, reason = validate_schema(payload, REQUIRED, KNOWN, TYPES)
    assert status == SCHEMA_OK, (status, reason)
    assert schema_policy(status) == ACTION_ACCEPT


def test_schema_missing_required_quarantines():
    payload = {"order_id": "A1", "currency_code": "INR"}  # amount_minor missing
    status, reason = validate_schema(payload, REQUIRED, KNOWN, TYPES)
    assert status == SCHEMA_MISSING, (status, reason)
    assert "amount_minor" in reason
    assert schema_policy(status) == ACTION_QUARANTINE


def test_schema_unknown_field_accepts_and_logs():
    payload = {"order_id": "A1", "amount_minor": "1999", "currency_code": "INR", "surprise": 1}
    status, reason = validate_schema(payload, REQUIRED, KNOWN, TYPES)
    assert status == SCHEMA_UNKNOWN, (status, reason)
    assert "surprise" in reason
    assert schema_policy(status) == ACTION_ACCEPT  # accept + log, never silently dropped


def test_schema_wrong_type_quarantines():
    payload = {"order_id": 123, "amount_minor": "1999", "currency_code": "INR"}  # order_id should be string
    status, reason = validate_schema(payload, REQUIRED, KNOWN, TYPES)
    assert status == SCHEMA_WRONG_TYPE, (status, reason)
    assert schema_policy(status) == ACTION_QUARANTINE


def test_schema_severity_missing_beats_unknown():
    payload = {"order_id": "A1", "surprise": 1}  # missing amount+currency AND has unknown
    status, _ = validate_schema(payload, REQUIRED, KNOWN, TYPES)
    assert status == SCHEMA_MISSING  # most-severe wins


def test_dq_clean_is_empty():
    rec = {"amount_minor": 1999, "currency_code": "INR", "occurred_at": "2026-06-27T10:00:00Z", "quantity": 2}
    assert dq_check(rec, now_ms=NOW_MS) == []


def test_dq_negative_amount():
    rec = {"amount_minor": -5, "currency_code": "INR"}
    assert "negative_amount" in dq_check(rec, now_ms=NOW_MS)


def test_dq_float_amount_is_not_money():
    rec = {"amount_minor": 19.99, "currency_code": "INR"}
    assert "non_integer_amount" in dq_check(rec, now_ms=NOW_MS)


def test_dq_bad_currency():
    assert "invalid_currency" in dq_check({"amount_minor": 100, "currency_code": "usd"}, now_ms=NOW_MS)
    assert "invalid_currency" in dq_check({"amount_minor": 100, "currency_code": "US"}, now_ms=NOW_MS)
    assert "invalid_currency" in dq_check({"amount_minor": 100, "currency_code": "RUPEE"}, now_ms=NOW_MS)


def test_dq_money_without_currency():
    assert "missing_currency" in dq_check({"amount_minor": 100, "currency_code": ""}, now_ms=NOW_MS)


def test_dq_future_timestamp():
    rec = {"occurred_at": "2030-01-01T00:00:00Z"}
    assert "future_occurred_at" in dq_check(rec, now_ms=NOW_MS)
    # within skew is fine
    assert "future_occurred_at" not in dq_check({"occurred_at": NOW_MS + 1000}, now_ms=NOW_MS)


def test_dq_unparseable_timestamp():
    assert "unparseable_timestamp" in dq_check({"occurred_at": "not-a-date"}, now_ms=NOW_MS)
    assert "unparseable_timestamp" in dq_check({"occurred_at": None}, now_ms=NOW_MS)


def test_dq_impossible_quantity():
    assert "impossible_quantity" in dq_check({"quantity": -1}, now_ms=NOW_MS)
    assert "impossible_quantity" in dq_check({"quantity": 9_999_999}, now_ms=NOW_MS)


def test_dq_empty_required_identifier():
    v = dq_check({"order_id": ""}, now_ms=NOW_MS, required_ids=["order_id"])
    assert "empty_identifier:order_id" in v


def test_clean_string_trims_collapses_nfc():
    assert clean_string("  hello   world  ") == "hello world"
    assert clean_string(None) is None
    # NFC: composed é vs decomposed e + combining acute → identical output
    assert clean_string("é") == clean_string("é")


def test_clean_name_titlecase_safe():
    for variant in ("John", "JOHN", "john", "  john  ", "  JoHn "):
        assert clean_name(variant) == "John", variant
    assert clean_name("mary-jane o'neil") == "Mary-Jane O'Neil"
    assert clean_name(None) is None
    # an id/hash is NOT a name — clean_name is for display fields only; verify it doesn't mangle case of a
    # word it shouldn't (single lower passes through capitalized, which is the documented contract).


def test_event_order_key_orders_in_time():
    order = {"occurred_at": "2026-06-27T10:00:00Z"}
    payment = {"occurred_at": "2026-06-27T10:05:00Z"}
    shipment = {"occurred_at": "2026-06-28T09:00:00Z"}
    events = [shipment, order, payment]
    ordered = sorted(events, key=event_order_key)
    assert ordered == [order, payment, shipment]
    # tie on occurred_at broken by source_ts then sequence
    a = {"occurred_at": "2026-06-27T10:00:00Z", "source_ts": "2026-06-27T10:00:01Z", "sequence": 2}
    b = {"occurred_at": "2026-06-27T10:00:00Z", "source_ts": "2026-06-27T10:00:01Z", "sequence": 1}
    assert sorted([a, b], key=event_order_key) == [b, a]


def test_event_order_key_str_sorts_like_tuple():
    # The string key must impose the SAME total order as the tuple (it is the Spark-window-sortable form).
    order = {"occurred_at": "2026-06-27T10:00:00Z"}
    payment = {"occurred_at": "2026-06-27T10:05:00Z"}
    shipment = {"occurred_at": "2026-06-28T09:00:00Z"}
    by_str = sorted([shipment, order, payment], key=event_order_key_str)
    assert by_str == [order, payment, shipment]
    # missing components sort first (0-padded), never ahead of a real later event
    assert event_order_key_str({}) < event_order_key_str(order)


# ── Stage-2 BUSINESS-validation ports ──────────────────────────────────────────────────────────────
def test_validate_payment_amount_positive_ok():
    assert validate_payment_amount(1999) == []
    assert validate_payment_amount("1999") == []


def test_validate_payment_amount_negative_rejected():
    assert validate_payment_amount(-1) == ["negative_payment_amount"]
    assert validate_payment_amount("-50") == ["negative_payment_amount"]


def test_validate_payment_amount_zero_money_bearing_rejected():
    assert validate_payment_amount(0, is_money_bearing=True) == ["zero_payment_amount"]
    # a non-money-bearing marker (pixel) with 0 is allowed
    assert validate_payment_amount(0, is_money_bearing=False) == []


def test_validate_payment_amount_none_and_float():
    assert validate_payment_amount(None) == []  # behavioral marker, nothing to validate
    assert validate_payment_amount(19.99) == ["non_integer_amount"]  # money is never a float
    assert validate_payment_amount("12.5") == ["non_integer_amount"]


def test_validate_refund_timing_before_order_rejected():
    v, unresolved = validate_refund_timing("2026-06-25T00:00:00Z", "2026-06-26T00:00:00Z")
    assert v == ["refund_before_order"] and unresolved is False


def test_validate_refund_timing_after_order_ok():
    v, unresolved = validate_refund_timing("2026-06-27T00:00:00Z", "2026-06-26T00:00:00Z")
    assert v == [] and unresolved is False


def test_validate_refund_timing_unresolvable_order_flags_not_drops():
    v, unresolved = validate_refund_timing("2026-06-27T00:00:00Z", None)
    assert v == [] and unresolved is True  # flagged, never quarantined


def test_inactive_campaign_conversion_flag():
    assert inactive_campaign_conversion_flag(False, 3) is True       # explicitly inactive + conversions → flag
    assert inactive_campaign_conversion_flag(False, 0) is False      # inactive but no conversions
    assert inactive_campaign_conversion_flag(True, 9) is False       # active → never flagged
    assert inactive_campaign_conversion_flag(None, 9) is False       # unknown status → row unchanged
    assert inactive_campaign_conversion_flag(False, "2") is True     # int-coerced conversions


def test_event_category_maps_canonical_types():
    # transaction — money-moving
    assert event_category("order.placed.v1") == "transaction"
    assert event_category("refund.issued.v1") == "transaction"
    assert event_category("payment.captured.v1") == "transaction"
    assert event_category("settlement.live.v1") == "transaction"
    # marketing — ad spend + ad-entity metadata
    assert event_category("spend.live.v1") == "marketing"
    assert event_category("ad.entity.updated") == "marketing"
    # fulfillment — logistics / RTO
    assert event_category("shiprocket.shipment.v1") == "fulfillment"
    assert event_category("fulfillment.recorded.v1") == "fulfillment"
    assert event_category("gokwik.rto_predict.v1") == "fulfillment"
    # behaviour — browser + checkout-funnel signals
    assert event_category("page.viewed") == "behaviour"
    assert event_category("product.viewed") == "behaviour"
    assert event_category("cart.updated") == "behaviour"
    assert event_category("rage.click") == "behaviour"
    assert event_category("exit_intent") == "behaviour"
    assert event_category("identify") == "behaviour"
    assert event_category("checkout.abandoned.v1") == "behaviour"   # "checkout" substring
    # pixel account-funnel + engagement singletons (collector-emitted) → behaviour, NOT other
    assert event_category("user.logged_in") == "behaviour"
    assert event_category("user.signed_up") == "behaviour"
    assert event_category("coupon.applied") == "behaviour"
    assert event_category("download") == "behaviour"
    assert event_category("share") == "behaviour"
    # resource dims + unknowns/empty → other (and precedence: upsert beats the behaviour prefixes)
    assert event_category("product.upsert.v1") == "other"
    assert event_category("customer.upsert.v1") == "other"
    assert event_category("") == "other"
    assert event_category(None) == "other"
    assert event_category("totally.unknown.v1") == "other"
    # case/whitespace-insensitive
    assert event_category("  ORDER.Placed.v1  ") == "transaction"


def _run_all():
    fns = [g for n, g in sorted(globals().items()) if n.startswith("test_") and callable(g)]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"\nOK — all {len(fns)} Stage-1 technical-processing port tests passed "
          f"(schema validate/policy, DQ gate, string cleaning, event ordering).")


if __name__ == "__main__":
    _run_all()
