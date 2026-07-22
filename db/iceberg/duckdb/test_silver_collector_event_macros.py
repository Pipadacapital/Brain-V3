"""
test_silver_collector_event_macros.py — P3 keystone perf: prove the VECTORIZED SQL macros
(sce_event_category / sce_identify_consent_denied) are BYTE-IDENTICAL to the pure Python ports they
replace (_silver_technical_ports.event_category / identify_consent_denied).

The macros exist ONLY to remove the Python-scalar-UDF vectorization break on the 78k-rows/window keystone
(silver_collector_event, ~18.5min/tick). Correctness must be unchanged — event_category feeds every
downstream category read and identify_consent_denied gates the R3 consent drop, so a single divergence is a
truth regression. This test runs a comprehensive corpus through BOTH paths (the port is the oracle) and
asserts equality for every input.

Pure/in-memory (DuckDB only, no Iceberg/PG). Carries a __main__ assert-runner so it gates with plain
`python test_silver_collector_event_macros.py` in the transform venv (same pattern as
test_parity_gold_incremental.py), and is also a normal pytest module.
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SILVER = os.path.join(HERE, "silver")
sys.path.insert(0, HERE)      # _base / _catalog (silver_collector_event self-inserts this too)
sys.path.insert(0, SILVER)    # _silver_technical_ports + silver_collector_event

import duckdb  # noqa: E402

from _silver_technical_ports import event_category, identify_consent_denied  # noqa: E402 — the ORACLE
import silver_collector_event as sce  # noqa: E402 — the module under test (brings in _register_udfs + macros)


# ── Corpus: every branch of event_category (realistic canonical event names + case/space variants) ────────
EVENT_TYPE_CORPUS = [
    # empty / null → 'other'
    None, "", "   ", "\n ",
    # .upsert.v1 decided BEFORE the prefixes (product.upsert.v1 → other, product.viewed → behaviour)
    "product.upsert.v1", "coupon.upsert.v1", "customer.upsert.v1", "PRODUCT.UPSERT.V1",
    # transaction (money-moving)
    "order.live.v1", "order.backfill.v1", "refund.created.v1", "payment.captured.v1", "settlement.paid.v1",
    "  order.live.v1  ", "ORDER.LIVE.V1",
    # marketing
    "spend.daily.v1", "ad.insight.v1",
    # fulfillment
    "shiprocket.shipment_status.v1", "fulfillment.updated.v1", "gokwik.rto_predict.v1",
    # support (reserved)
    "ticket.opened.v1", "call.logged.v1", "support.reply.v1",
    # behaviour — exacts
    "dead.click", "rage.click", "exit_intent", "video", "identify", "pixel.identify.v1",
    "coupon.applied", "download", "share",
    # behaviour — prefixes
    "page.view", "product.viewed", "collection.viewed", "cart.add", "session.start", "scroll.depth",
    "element.click", "search.query", "form.submit", "user.login", "user.signup",
    # behaviour — 'checkout' anywhere in the name
    "shopflo.checkout_abandoned.v1", "checkout.started", "cart.checkout.begin",
    # other (unknown / dims that fall through)
    "random.event.v1", "unknown", "gokwik.other.v1", "adx", "orders", "settlementx",
]

# ── Corpus: identify_consent_denied — (event_type, consent_state, analytics_flag) ─────────────────────────
CONSENT_CORPUS = [
    ("order.live.v1", None, None),                # not identify → False
    ("identify", None, None),                     # identify, no signals → False
    ("identify", "granted", None),                # granted → False
    ("identify", "denied", None),                 # denied → True
    ("identify", "GRANTED", None),                # case-insensitive → False
    ("identify", "  granted  ", None),            # trimmed → False
    ("identify", "revoked", None),                # present-not-granted → True (fail-closed)
    ("identify", None, "false"),                  # analytics false → True
    ("identify", None, "FALSE"),                  # case → True
    ("identify", None, "true"),                   # analytics true → False
    ("identify", None, "  false  "),              # trimmed → True
    ("identify", "granted", "false"),             # consent_state precedence (granted) → False
    ("pixel.identify.v1", "denied", None),        # the WA-07 identify alias → True
    ("pixel.identify.v1", None, "false"),         # → True
    ("Identify", "denied", None),                 # RAW case-sensitive event match → not identify → False
    (None, "denied", None),                       # null event_type → not identify → False
    ("identify", "", None),                       # empty string present (not None) → not 'granted' → True
]


def _make_con() -> "duckdb.DuckDBPyConnection":
    con = duckdb.connect(":memory:")
    sce._register_udfs(con)  # registers the two macros exactly as the live build() does
    return con


def test_event_category_macro_matches_port():
    con = _make_con()
    mismatches = []
    for et in EVENT_TYPE_CORPUS:
        got = con.execute("SELECT sce_event_category(?)", [et]).fetchone()[0]
        want = event_category(et)
        if got != want:
            mismatches.append((repr(et), got, want))
    con.close()
    assert not mismatches, "event_category macro≠port:\n" + "\n".join(
        f"  {e}: macro={g!r} port={w!r}" for e, g, w in mismatches
    )


def test_identify_consent_denied_macro_matches_port():
    con = _make_con()
    mismatches = []
    for et, cs, af in CONSENT_CORPUS:
        got = con.execute("SELECT sce_identify_consent_denied(?, ?, ?)", [et, cs, af]).fetchone()[0]
        want = identify_consent_denied(et, cs, af)
        if got != want:
            mismatches.append((repr((et, cs, af)), got, want))
    con.close()
    assert not mismatches, "identify_consent_denied macro≠port:\n" + "\n".join(
        f"  {i}: macro={g!r} port={w!r}" for i, g, w in mismatches
    )


def test_every_event_category_bucket_is_exercised():
    """Guard: the corpus must actually hit all six buckets (so a green parity run means something)."""
    buckets = {event_category(et) for et in EVENT_TYPE_CORPUS}
    assert buckets == {"transaction", "behaviour", "fulfillment", "support", "marketing", "other"}, buckets


if __name__ == "__main__":
    test_event_category_macro_matches_port()
    test_identify_consent_denied_macro_matches_port()
    test_every_event_category_bucket_is_exercised()
    print("✓ silver_collector_event macro↔port parity: event_category + identify_consent_denied byte-exact")
