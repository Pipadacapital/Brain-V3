"""
a12_identify_consent_denied_test.py — SPEC A.1.2 (WA-08, AMD-04): the Silver denied-VALUE drop for
identify events.

The pre-existing R3 gate is PRESENCE-only (consent_flags absent → silver_consent_rejected); a denied
consent VALUE passed. AMD-04 (BINDING) adds the strictly-stronger denied-VALUE drop for IDENTIFY
events. This suite covers:

  1. the pure port `identify_consent_denied` (_silver_technical.py) — the full truth table the
     silver_collector_event gate applies via identify_consent_denied_udf();
  2. static guards that silver_collector_event.py actually WIRES the drop (routes 'consent_denied'
     through write_consent_rejected, lifts the two consent-VALUE signals, and excludes denied rows
     from consent_ok) — same static-guard style as gate_admission_guard_test.py.

Run:  python3 -m pytest db/iceberg/spark/silver/a12_identify_consent_denied_test.py -q
  or: python3 db/iceberg/spark/silver/a12_identify_consent_denied_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _silver_technical import IDENTIFY_EVENT_TYPES, identify_consent_denied  # noqa: E402

GATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "silver_collector_event.py")


# ── A1.2 — pure-port truth table ─────────────────────────────────────────────────────────────────

def test_a12_new_identify_denied_consent_state_is_dropped():
    # WA-07 envelope: consent_state='denied' → consent_rejected, for BOTH identify event types.
    for et in IDENTIFY_EVENT_TYPES:
        assert identify_consent_denied(et, "denied", None) is True, et
        assert identify_consent_denied(et, "denied", "true") is True, et  # consent_state wins


def test_a12_granted_consent_state_passes():
    for et in IDENTIFY_EVENT_TYPES:
        assert identify_consent_denied(et, "granted", None) is False, et
        assert identify_consent_denied(et, "granted", "true") is False, et


def test_a12_present_but_garbage_consent_state_fails_closed():
    # Anything present-but-not-'granted' is DENIED (fail-closed) — a malformed/unknown value can
    # never smuggle an identity capture through.
    assert identify_consent_denied("pixel.identify.v1", "maybe", None) is True
    assert identify_consent_denied("pixel.identify.v1", "", None) is True
    assert identify_consent_denied("pixel.identify.v1", "GRANTED ", None) is False  # case/space-tolerant


def test_a12_legacy_identify_analytics_false_value_is_dropped():
    # AMD-04 ground truth: `analytics:false` previously PASSED the presence-only gate. Now, for
    # identify events, the denied VALUE drops.
    assert identify_consent_denied("identify", None, "false") is True
    assert identify_consent_denied("identify", None, "true") is False
    assert identify_consent_denied("identify", None, None) is False  # absent VALUE → presence gate owns it


def test_a12_non_identify_events_are_never_value_gated():
    # Unchanged posture for behavioural events: consent VALUES gate downstream use, not capture.
    for et in ("page.viewed", "cart.item_added", "order.placed", "user.logged_in"):
        assert identify_consent_denied(et, "denied", "false") is False, et


def test_a12_identify_event_type_set_is_exactly_the_two_identify_shapes():
    # Pin the set: legacy 'identify' + the WA-07 'pixel.identify.v1' envelope — nothing else.
    assert set(IDENTIFY_EVENT_TYPES) == {"identify", "pixel.identify.v1"}


# ── A1.2 — static wiring guards (the gate actually applies the port) ─────────────────────────────

def _gate_source() -> str:
    with open(GATE_FILE, encoding="utf-8") as f:
        return f.read()


def test_a12_gate_routes_consent_denied_to_consent_rejected():
    src = _gate_source()
    assert 'lit("consent_denied")' in src, (
        "silver_collector_event.py must route the AMD-04 denied-VALUE identifies to "
        "write_consent_rejected with reason='consent_denied'"
    )
    assert "identify_consent_denied_udf" in src, (
        "silver_collector_event.py must apply the identify_consent_denied port (single source of truth)"
    )


def test_a12_gate_lifts_both_consent_value_signals():
    src = _gate_source()
    assert "$.properties.consent_state" in src, "gate must lift the WA-07 envelope consent_state"
    assert "$.consent_flags.analytics" in src, "gate must lift the legacy consent_flags analytics VALUE"


def test_a12_denied_rows_are_excluded_from_consent_ok():
    src = _gate_source()
    assert "consent_ok = consent_present.where(~_identify_denied)" in src, (
        "consent_ok must exclude denied identifies (they land ONLY in silver_consent_rejected)"
    )


# ── plain-script runner (mirrors the sibling suites) ─────────────────────────────────────────────
if __name__ == "__main__":
    failures = 0
    for name, fn in sorted((k, v) for k, v in globals().items() if k.startswith("test_") and callable(v)):
        try:
            fn()
            print(f"  ok    {name}")
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL  {name}: {exc}")
    if failures:
        sys.exit(1)
    print("a12_identify_consent_denied_test: all checks passed")
