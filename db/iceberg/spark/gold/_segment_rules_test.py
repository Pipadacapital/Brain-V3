"""
_segment_rules_test.py — PURE (no Spark) deterministic-rule proof for the gold_customer_segments
segmentation logic in _segment_rules.py.

It pins a table of golden fixtures (base signals) → expected segment, and proves the rules TWO ways,
both pure (no Spark, no external service) — the same "run the REAL string the job executes" pattern as
snap_identity_link_asof_test.py:
  1. SQL-via-sqlite — executes the EXACT CASE expression string the Spark job runs
     (value_tier_case_sql / lifecycle_segment_case_sql) against an in-memory sqlite row, so a drift
     between the rule SQL and the expectation is caught (not just a hand-rolled reference);
  2. pure-Python reference — assign_value_tier / assign_lifecycle_segment must agree with the SQL and
     the expectation (proof the reference and the SQL are the same ladder).

Plus coverage assertions: every documented lifecycle + value-tier label is exercised by at least one
fixture (so a label can never be silently dropped from the ladder).

Run: python3 db/iceberg/spark/gold/_segment_rules_test.py
Exit 0 = all green, exit 1 = one or more failures.
"""
from __future__ import annotations

import os
import sqlite3
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _GOLD_DIR)

from _segment_rules import (  # noqa: E402
    LIFECYCLE_LABELS,
    VALUE_TIER_LABELS,
    assign_lifecycle_segment,
    assign_value_tier,
    lifecycle_segment_case_sql,
    value_tier_case_sql,
)

# ── Golden fixtures ──────────────────────────────────────────────────────────────
# (label, recency_days, lifetime_orders, lifetime_value_minor, expected_lifecycle, expected_value_tier)
# Chosen to hit EVERY lifecycle label + every value tier AND the precedence boundaries (a churned VIP is
# churned; a high-value lapsing customer is at_risk; VIP needs all three of M5+freq>=5+recent).
_FIXTURES = [
    # churned outranks everything (recency_days > 180), even a would-be VIP by value/frequency.
    ("churned_lapsed_vip", 400, 12, 20_000_000, "churned", "high_value"),
    ("churned_recent_enough_no", 181, 1, 0, "churned", "no_realized_value"),
    # at_risk: 90 < recency_days <= 180, outranks value/frequency.
    ("at_risk_highvalue", 120, 8, 9_000_000, "at_risk", "high_value"),
    ("at_risk_boundary_91", 91, 2, 60_000, "at_risk", "mid_value"),
    # VIP: top monetary tier AND >=5 orders AND recent (<=60d).
    ("vip", 20, 10, 15_000_000, "VIP", "high_value"),
    ("vip_boundary_60d", 60, 5, 10_000_000, "VIP", "high_value"),
    # NOT VIP — fails one VIP leg each, falls through to the next matching rule.
    ("not_vip_recency_61", 61, 9, 12_000_000, "loyal", "high_value"),      # recent<=90 but >60 → loyal
    ("not_vip_low_freq", 30, 4, 12_000_000, "high_value", "high_value"),    # <5 orders → high_value
    ("not_vip_low_money", 30, 9, 4_000_000, "loyal", "high_value"),         # <1e7 but >=5 orders, recent → loyal
    # loyal: >=5 orders AND recent (<=90d), below VIP monetary.
    ("loyal", 45, 6, 3_000_000, "loyal", "high_value"),
    ("loyal_boundary_90d", 90, 5, 100_000, "loyal", "high_value"),
    # high_value: monetary tier >=5e6 but not VIP/loyal pattern (few orders).
    ("high_value_single_big", 40, 1, 8_000_000, "high_value", "high_value"),
    # first_time_buyer: exactly 1 order with positive value, below high_value monetary.
    ("first_time", 10, 1, 75_000, "first_time_buyer", "mid_value"),
    # cart_abandoner: zero realized value (orders placed, no recognized revenue).
    ("cart_abandoner_zero", 15, 3, 0, "cart_abandoner", "no_realized_value"),
    # window_shopper: the residual — recent-ish, multi-order, low value, not matching anything above.
    ("window_shopper_residual", 80, 2, 30_000, "window_shopper", "low_value"),
]


_FAILURES: list[str] = []


def _fail(test: str, msg: str) -> None:
    _FAILURES.append(f"[{test}] {msg}")
    print(f"  FAIL ({test}): {msg}", file=sys.stderr)


def _pass(test: str, detail: str) -> None:
    print(f"  PASS ({test}): {detail}")


def _eval_case_sql(case_sql: str, recency_days: int, lifetime_orders: int, lifetime_value_minor: int) -> str:
    """Execute the EXACT CASE expression string the Spark job runs, against one in-memory sqlite row."""
    con = sqlite3.connect(":memory:")
    try:
        cur = con.execute(
            f"SELECT {case_sql} FROM (SELECT ? AS recency_days, ? AS lifetime_orders, ? AS lifetime_value_minor)",
            (recency_days, lifetime_orders, lifetime_value_minor),
        )
        return str(cur.fetchone()[0])
    finally:
        con.close()


def test_lifecycle_sql_sqlite() -> None:
    """The real lifecycle CASE SQL (run in sqlite) matches every fixture's expected lifecycle segment."""
    case_sql = lifecycle_segment_case_sql()
    for label, rd, lo, lv, exp_life, _exp_vt in _FIXTURES:
        actual = _eval_case_sql(case_sql, rd, lo, lv)
        if actual != exp_life:
            _fail("lifecycle_sql_sqlite", f"{label}: expected {exp_life}, got {actual}")
    _pass("lifecycle_sql_sqlite", f"real CASE SQL matches all {len(_FIXTURES)} fixtures")


def test_lifecycle_reference() -> None:
    """The pure-Python reference matches every fixture's expected lifecycle segment."""
    for label, rd, lo, lv, exp_life, _exp_vt in _FIXTURES:
        actual = assign_lifecycle_segment(rd, lo, lv)
        if actual != exp_life:
            _fail("lifecycle_reference", f"{label}: expected {exp_life}, got {actual}")
    _pass("lifecycle_reference", f"pure-Python reference matches all {len(_FIXTURES)} fixtures")


def test_value_tier_sql_and_reference() -> None:
    """The value-tier CASE SQL (sqlite) AND the pure reference both match every fixture's value tier."""
    case_sql = value_tier_case_sql()
    for label, _rd, _lo, lv, _exp_life, exp_vt in _FIXTURES:
        sql_actual = _eval_case_sql(case_sql, 0, 0, lv)
        ref_actual = assign_value_tier(lv)
        if sql_actual != exp_vt:
            _fail("value_tier_sql", f"{label}: expected {exp_vt}, got {sql_actual}")
        if ref_actual != exp_vt:
            _fail("value_tier_reference", f"{label}: expected {exp_vt}, got {ref_actual}")
    _pass("value_tier_sql_and_reference", f"value-tier SQL + reference match all {len(_FIXTURES)} fixtures")


def test_label_coverage() -> None:
    """Every documented lifecycle + value-tier label is exercised by at least one fixture."""
    seen_life = {f[4] for f in _FIXTURES}
    seen_vt = {f[5] for f in _FIXTURES}
    missing_life = set(LIFECYCLE_LABELS) - seen_life
    missing_vt = set(VALUE_TIER_LABELS) - seen_vt
    if missing_life:
        _fail("label_coverage", f"lifecycle labels never exercised: {sorted(missing_life)}")
    if missing_vt:
        _fail("label_coverage", f"value-tier labels never exercised: {sorted(missing_vt)}")
    if not missing_life and not missing_vt:
        _pass("label_coverage", f"all {len(LIFECYCLE_LABELS)} lifecycle + {len(VALUE_TIER_LABELS)} value-tier labels covered")


def main() -> None:
    tests = [
        test_lifecycle_sql_sqlite,
        test_lifecycle_reference,
        test_value_tier_sql_and_reference,
        test_label_coverage,
    ]
    print(f"_segment_rules_test — {len(tests)} test groups over {len(_FIXTURES)} golden fixtures")
    for t in tests:
        try:
            t()
        except Exception as exc:  # noqa: BLE001
            _fail(t.__name__, f"unexpected exception: {exc}")

    failed = len(_FAILURES)
    if failed:
        print(f"\n{len(tests) - 0} test groups ran, {failed} FAILED", file=sys.stderr)
        sys.exit(1)
    print(f"\nALL GREEN — {len(tests)} test groups passed")
    sys.exit(0)


if __name__ == "__main__":
    main()
