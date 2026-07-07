# SPEC: B.5.4 — attribution-consumes-journey seam (Wave B) / AMD-13 R1.
"""
b5_4_attribution_parity_test.py — the B.5.4 PARITY proof (test name: B5-4.parity).

CLAIM (AMD-13 R1): switching the attribution touchpoint INPUT from silver_touchpoint to the
Journey-domain output (iceberg.brain_gold.journey_events / mv_journey_events_current, is_current +
deterministic-only) is a REFACTOR OF THE INPUT PLUMBING, not a semantics change. With the identity
input held constant (journey.engine OFF at journey CONSTRUCTION → journey_events.brain_id equals the
legacy silver_touchpoint.stitched_brain_id per touch), the two sources project into the SAME per-touch
shape the credit fold consumes, so the attribution credit ledger is BYTE-IDENTICAL.

This guard proves that claim two ways, PySpark-free (same posture as b1_canonical_journey_test.py —
`_attribution_math` is a pure module, and the driver SQL projections are reproduced in Python 1:1):
  1. PROJECTION PARITY — the silver_touchpoint row projection (`_read_silver_touchpoint`/`_touch_dict`)
     and the journey_events row projection (`_read_journey_touchpoints`) yield IDENTICAL touch dicts
     for an identity-held-constant fixture (incl. the anonymous_ placeholder → NULL stitched mapping,
     the source_event_ref split back to (brain_anon_id, touch_seq), and campaign/attribution_signals).
  2. LEDGER PARITY — feeding each projected touch set through the SAME apportionment fold
     (`_attribution_math` — every per-journey model + the data-driven Markov model + the deterministic
     credit_id) yields a BYTE-IDENTICAL credit-row list (credit_id, weight_fraction, credited minor,
     confidence — the full row tuple).
  3. STATIC SEAM GUARDS — both drivers (`gold_attribution_credit.py` Spark + `reconcile-attribution.ts`
     TS) carry the flag-gated switch, default OFF (byte-identical pre-wave), and the journey branch
     filters is_current + identity_basis='deterministic' (§1.4 / invariant 5 — zero probabilistic rows
     ever reach attribution).

Run:  python3 -m pytest db/iceberg/spark/gold/b5_4_attribution_parity_test.py -q
  or: python3 db/iceberg/spark/gold/b5_4_attribution_parity_test.py
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# _attribution_math is the PURE (no pyspark) fold both drivers reproduce — import it directly. The
# Spark job module itself imports pyspark at top, so (like b1) we never import it; we reproduce its two
# tiny SQL projections in Python and assert they agree, then run the shared pure fold.
import _attribution_math as M  # noqa: E402

GOLD_DIR = Path(__file__).resolve().parent
SPARK_JOB = GOLD_DIR / "gold_attribution_credit.py"
TS_DRIVER = (
    GOLD_DIR.parents[3]
    / "apps" / "core" / "src" / "modules" / "attribution" / "internal" / "reconcile-attribution.ts"
)


# ── The two SOURCE projections, reproduced 1:1 from the drivers ───────────────────────────────────────
def _silver_project(row: dict) -> dict:
    """`_read_silver_touchpoint` columns → `_touch_dict` (gold_attribution_credit.py). The legacy
    source: brain_anon_id/touch_seq are native columns; stitched_brain_id is the resolved identity."""
    return {
        "brand_id": row["brand_id"],
        "brain_anon_id": row["brain_anon_id"],
        "touch_seq": int(row["touch_seq"]),
        "channel": row["channel"],
        "campaign_id": row["utm_campaign"],
        "utm_medium": row["utm_medium"],
        "fbclid": row["fbclid"],
        "gclid": row["gclid"],
        "ttclid": row["ttclid"],
        "stitched_brain_id": row["stitched_brain_id"],
    }


def _journey_project(jrow: dict) -> dict:
    """`_read_journey_touchpoints` SELECT (gold_attribution_credit.py) reproduced in Python:
      brain_anon_id/touch_seq ← split(source_event_ref, '||')[1]/[2]
      campaign_id             ← campaign
      utm_medium/fbclid/gclid/ttclid ← attribution_signals[...] (missing key → None)
      stitched_brain_id       ← brain_id, with the 'anonymous_' placeholder mapped back to NULL.
    Only is_current=true AND identity_basis='deterministic' rows are read (filter asserted separately)."""
    parts = jrow["source_event_ref"].split("||")
    sig = jrow.get("attribution_signals") or {}
    brain_id = jrow["brain_id"]
    stitched = None if brain_id[:10] == "anonymous_" else brain_id
    return {
        "brand_id": jrow["brand_id"],
        "brain_anon_id": parts[1],
        "touch_seq": int(parts[2]),
        "channel": jrow["channel"],
        "campaign_id": jrow["campaign"],
        "utm_medium": sig.get("utm_medium"),
        "fbclid": sig.get("fbclid"),
        "gclid": sig.get("gclid"),
        "ttclid": sig.get("ttclid"),
        "stitched_brain_id": stitched,
    }


# ── The shared pure fold — the per-touch credit rows for ONE recognized order (mirrors the exact
# per-model + data-driven apportionment `_compute_brand_rows` runs; both SOURCES feed it identically). ─
def _credit_rows_for_order(brand_id, order, touches, channel_weights):
    rows = []
    anon = touches[0]["brain_anon_id"]
    stitched = any(t["stitched_brain_id"] is not None for t in touches)
    signals = [M.is_deterministic_channel(t) for t in touches]
    grade, confidence = M.grade_journey_confidence(stitched, signals)
    realized = int(order["amount_minor"])
    n = len(touches)
    for model in list(M.PER_JOURNEY_MODEL_IDS):
        wunits = M.compute_weight_units(model, n)
        credited = M.apportion_minor(wunits, realized)
        for i, t in enumerate(touches):
            rows.append((
                brand_id, M.compute_credit_id(brand_id, order["order_id"], anon, t["touch_seq"], model),
                order["order_id"], anon, t["touch_seq"], t["channel"], t["campaign_id"],
                model, M.weight_fraction_string(wunits[i]), credited[i], grade, confidence,
            ))
    if channel_weights:
        dd_units = M.data_driven_touch_weight_units([t["channel"] for t in touches], channel_weights)
        dd_credited = M.apportion_minor(dd_units, realized)
        for i, t in enumerate(touches):
            rows.append((
                brand_id, M.compute_credit_id(brand_id, order["order_id"], anon, t["touch_seq"], "data_driven"),
                order["order_id"], anon, t["touch_seq"], t["channel"], t["campaign_id"],
                "data_driven", M.weight_fraction_string(dd_units[i]), dd_credited[i], grade, confidence,
            ))
    return rows


# ── The identity-held-constant golden fixture ─────────────────────────────────────────────────────────
# One stitched journey (brain_anon 'ax1' → the resolved brain_id 'brn-1'), 3 touches across paid + direct;
# a recognized (finalized) order on brn-1. The journey_events rows carry the SAME identity resolution
# (brain_id = 'brn-1'), so the two projections MUST agree column-for-column.
BRAND = "b0b0b0b0-0002-4000-8000-000000000b02"
RESOLVED = "brn-1"
ANON = "ax1"

_SILVER = [
    {"brand_id": BRAND, "brain_anon_id": ANON, "touch_seq": 1, "channel": "google",
     "utm_campaign": "spring", "utm_medium": "cpc", "fbclid": None, "gclid": "g123",
     "ttclid": None, "stitched_brain_id": RESOLVED},
    {"brand_id": BRAND, "brain_anon_id": ANON, "touch_seq": 2, "channel": "meta",
     "utm_campaign": "retgt", "utm_medium": None, "fbclid": "f456", "gclid": None,
     "ttclid": None, "stitched_brain_id": RESOLVED},
    {"brand_id": BRAND, "brain_anon_id": ANON, "touch_seq": 3, "channel": "direct",
     "utm_campaign": None, "utm_medium": None, "fbclid": None, "gclid": None,
     "ttclid": None, "stitched_brain_id": RESOLVED},
]

# The SAME touches as journey_events rows (identity held constant: brain_id == the silver stitch). The
# build's map_filter drops empty/NULL signal keys, so a missing key reads None on projection (parity).
_JOURNEY = [
    {"brand_id": BRAND, "brain_id": RESOLVED, "is_current": True, "identity_basis": "deterministic",
     "source_event_ref": f"{BRAND}||{ANON}||1", "channel": "google", "campaign": "spring",
     "attribution_signals": {"utm_medium": "cpc", "gclid": "g123", "utm_campaign": "spring"}},
    {"brand_id": BRAND, "brain_id": RESOLVED, "is_current": True, "identity_basis": "deterministic",
     "source_event_ref": f"{BRAND}||{ANON}||2", "channel": "meta", "campaign": "retgt",
     "attribution_signals": {"fbclid": "f456", "utm_campaign": "retgt"}},
    {"brand_id": BRAND, "brain_id": RESOLVED, "is_current": True, "identity_basis": "deterministic",
     "source_event_ref": f"{BRAND}||{ANON}||3", "channel": "direct", "campaign": None,
     "attribution_signals": {}},
]

_ORDER = {"order_id": "ORD-1", "amount_minor": 149900}


# ── Checks ────────────────────────────────────────────────────────────────────────────────────────────
def check_projection_parity():
    sv = [_silver_project(r) for r in _SILVER]
    jv = [_journey_project(r) for r in _JOURNEY]
    assert sv == jv, (
        "projection parity FAILED — journey_events projection must equal silver_touchpoint projection "
        f"with identity held constant.\n  silver : {sv}\n  journey: {jv}"
    )


def _channel_weights(touches):
    # single stitched (converted) journey — the corpus the Markov weights train on.
    corpus = [([t["channel"] for t in touches], True)]
    return M.compute_markov_channel_weights(corpus)


def check_ledger_parity():
    sv = [_silver_project(r) for r in _SILVER]
    jv = [_journey_project(r) for r in _JOURNEY]
    sv_rows = _credit_rows_for_order(BRAND, _ORDER, sv, _channel_weights(sv))
    jv_rows = _credit_rows_for_order(BRAND, _ORDER, jv, _channel_weights(jv))
    assert sv_rows, "fixture produced no credit rows — the parity proof is vacuous"
    assert sv_rows == jv_rows, (
        "LEDGER parity FAILED — attribution credit rows differ between silver and journey sources "
        "with identity held constant (this is a semantics change, not a refactor)."
    )
    # closed-sum sanity per model (Σ credited == realized), so the parity isn't of two broken ledgers.
    by_model = {}
    for r in jv_rows:
        by_model.setdefault(r[7], 0)  # r[7]=model_id, r[9]=credited_revenue_minor
        by_model[r[7]] += r[9]
    for model, tot in by_model.items():
        assert tot == int(_ORDER["amount_minor"]), f"{model}: Σ credited {tot} != realized {_ORDER['amount_minor']}"


def check_anonymous_placeholder_maps_to_null():
    j = _journey_project({
        "brand_id": BRAND, "brain_id": f"anonymous_{ANON}", "is_current": True,
        "identity_basis": "deterministic", "source_event_ref": f"{BRAND}||{ANON}||1",
        "channel": "google", "campaign": None, "attribution_signals": {},
    })
    assert j["stitched_brain_id"] is None, (
        "journey projection must map the 'anonymous_' placeholder brain_id back to NULL (unstitched), "
        "matching silver_touchpoint.stitched_brain_id IS NULL"
    )


def check_spark_seam_static():
    flat = re.sub(r"\s+", " ", SPARK_JOB.read_text()).lower()
    assert "attribution_source" in flat and "journey_events" in flat, (
        "Spark job must carry the ATTRIBUTION_SOURCE switch reading journey_events (B.5.4)"
    )
    # default OFF — anything but 'journey' → legacy silver_touchpoint.
    assert '"journey"' in SPARK_JOB.read_text() or "'journey'" in SPARK_JOB.read_text()
    assert "is_current = true and identity_basis = 'deterministic'" in flat, (
        "journey branch must filter is_current + identity_basis='deterministic' (§1.4 / invariant 5)"
    )
    assert "_read_silver_touchpoint" in SPARK_JOB.read_text(), "default OFF path must keep silver_touchpoint"


def check_ts_seam_static():
    text = TS_DRIVER.read_text()
    flat = re.sub(r"\s+", " ", text).lower()
    assert "mv_journey_events_current" in text, "TS journey branch must read mv_journey_events_current (B.5.4)"
    assert "resolveattributiontouchpointsource" in flat, "TS must resolve the flag-gated touchpoint source"
    assert "journey.engine" in text, "TS switch must key on the per-brand journey.engine flag (AMD-13)"
    assert "identity_basis = 'deterministic'" in text, (
        "TS journey branch must filter identity_basis='deterministic' (§1.4 / invariant 5)"
    )
    # default OFF / fail-closed: the legacy silver_touchpoint view remains the default return.
    assert "mv_silver_touchpoint" in text, "default OFF path must keep mv_silver_touchpoint"
    assert "return 'silver_touchpoint'" in text, "source resolution must default OFF to silver_touchpoint"


_CHECKS = [
    ("projection_parity", check_projection_parity),
    ("ledger_parity", check_ledger_parity),
    ("anonymous_placeholder_maps_to_null", check_anonymous_placeholder_maps_to_null),
    ("spark_seam_static", check_spark_seam_static),
    ("ts_seam_static", check_ts_seam_static),
]


def test_projection_parity():
    check_projection_parity()


def test_ledger_parity():
    check_ledger_parity()


def test_anonymous_placeholder_maps_to_null():
    check_anonymous_placeholder_maps_to_null()


def test_spark_seam_static():
    check_spark_seam_static()


def test_ts_seam_static():
    check_ts_seam_static()


def main() -> int:
    failures = []
    for name, fn in _CHECKS:
        try:
            fn()
            print(f"[b5-4-attribution-parity] PASS  {name}")
        except AssertionError as exc:
            failures.append(name)
            print(f"[b5-4-attribution-parity] FAIL  {name}\n{exc}\n")
    if failures:
        print(f"[b5-4-attribution-parity] FAILED ({len(failures)}): {', '.join(failures)}")
        return 1
    print("[b5-4-attribution-parity] OK — B.5.4 flag ON==OFF byte-identical (identity held constant).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
