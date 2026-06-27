"""
_customer_360_enrich_test.py — PURE (no Spark) self-test of the Customer360 enrichment scalar
transforms the gold_customer_360 B2 fold applies (aov_minor, churn_score_from_risk, lifecycle_stage,
pick_mode). Proves the V4 money/confidence invariants at the unit level: aov is EXACT integer
minor-unit division (the 123450/3 = 41150 the Customer360 contract fixture asserts), churn_score is an
INTEGER 0-100 band (never money), lifecycle_stage is a closed set, mode is deterministic (count desc,
value asc).

Run: python3 db/iceberg/spark/gold/_customer_360_enrich_test.py
Exit 0 = all green, exit 1 = one or more failures.
"""
from __future__ import annotations

import os
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _GOLD_DIR)

from _customer_360_enrich import (  # noqa: E402
    LIFECYCLE_STAGES,
    aov_minor,
    churn_score_from_risk,
    lifecycle_stage,
    pick_mode,
)

_failures: list[str] = []


def check(name: str, got, want) -> None:
    if got != want:
        _failures.append(f"{name}: got {got!r}, want {want!r}")
        print(f"  ✗ {name}: got {got!r}, want {want!r}")
    else:
        print(f"  ✓ {name}")


print("== aov_minor (exact integer minor-unit division, truncate toward zero, nullsafe) ==")
check("aov 123450/3 = 41150 (matches Customer360 contract fixture)", aov_minor(123450, 3), 41150)
check("aov 100/3 truncates to 33", aov_minor(100, 3), 33)
check("aov 0 orders → None (nullsafe, no divide-by-zero)", aov_minor(50000, 0), None)
check("aov None orders → None", aov_minor(50000, None), None)
check("aov None value → None", aov_minor(None, 2), None)
check("aov single order = full value", aov_minor(50000, 1), 50000)
check("aov negative clawback truncates toward zero", aov_minor(-100, 3), -33)

print("== churn_score_from_risk (INTEGER 0-100 band, never money) ==")
check("low → 15", churn_score_from_risk("low"), 15)
check("medium → 55", churn_score_from_risk("medium"), 55)
check("high → 85", churn_score_from_risk("high"), 85)
check("HIGH case-insensitive", churn_score_from_risk("HIGH"), 85)
check("None → None", churn_score_from_risk(None), None)
check("unknown band → None", churn_score_from_risk("bogus"), None)
for band in ("low", "medium", "high"):
    s = churn_score_from_risk(band)
    check(f"{band} score in 0..100", 0 <= s <= 100, True)

print("== lifecycle_stage (closed set, deterministic) ==")
check("no health row → None", lifecycle_stage(None, 5), None)
check("churned → churned", lifecycle_stage("churned", 9), "churned")
check("at_risk → at_risk", lifecycle_stage("at_risk", 3), "at_risk")
check("healthy + 1 order → new", lifecycle_stage("healthy", 1), "new")
check("healthy + 0 orders → new", lifecycle_stage("healthy", 0), "new")
check("healthy + 5 orders → active", lifecycle_stage("healthy", 5), "active")
check("healthy + None orders → new", lifecycle_stage("healthy", None), "new")
for band in ("healthy", "at_risk", "churned"):
    st = lifecycle_stage(band, 3)
    check(f"{band} maps into closed set", st in LIFECYCLE_STAGES, True)

print("== pick_mode (deterministic: count desc, then value asc) ==")
check("clear majority", pick_mode(["paid", "paid", "organic"]), "paid")
check("tie → lexicographically smallest", pick_mode(["organic", "paid"]), "organic")
check("ignores None / empty", pick_mode([None, "", "direct", "direct", None]), "direct")
check("all empty → None", pick_mode([None, "", None]), None)
check("empty input → None", pick_mode([]), None)

if _failures:
    print(f"\nFAILED ({len(_failures)}):")
    for f in _failures:
        print(f"  - {f}")
    sys.exit(1)
print("\nAll _customer_360_enrich tests passed ✓")
