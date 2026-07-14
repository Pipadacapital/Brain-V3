"""
_customer_360_enrich.py — the PURE (no-Spark) deterministic scalar transforms the Customer360
enrichment (gold_customer_360.py, Brain V4 B2) folds onto each (brand_id, brain_id) row.

These are factored out PURE so the exact thresholds/derivations are unit-tested WITHOUT a Spark
session (db/iceberg/spark/gold/_customer_360_enrich_test.py) — and the Spark job imports + applies
them (aov via native `div`; churn_score / lifecycle_stage via UDFs wrapping these very functions; the
mode tie-break mirrors pick_mode) so the executed logic IS the tested logic. No float, no money
blending: aov_minor is exact integer (minor-unit) division; churn_score is a pure INTEGER 0-100 risk
band (never money, never blended); lifecycle_stage is a closed deterministic label set.

INVARIANTS (V4):
  - aov_minor: bigint MINOR-unit integer division, per-currency (the caller carries the sibling
    currency_code verbatim) — truncate toward zero to match Spark's `div` (IntegralDivide). orders<=0
    → None (nullsafe; never a divide-by-zero, never a float).
  - churn_score: INTEGER 0-100 risk band projected from gold_customer_scores.churn_risk — its OWN seam,
    never blended with the money columns.
  - lifecycle_stage: closed set {new, active, at_risk, churned} derived deterministically from the
    gold_customer_health health_band + the lifetime order count. None when no health row exists.
"""
from __future__ import annotations

from typing import List, Optional

# churn_risk band (gold_customer_scores) → INTEGER 0-100 risk score (band representative).
# low = recent/healthy → small risk; high = >180d lapsed → large risk. Pure int, never money.
_CHURN_RISK_TO_SCORE = {"low": 15, "medium": 55, "high": 85}

# The closed lifecycle-stage label set (matches packages/contracts LifecycleStageSchema).
LIFECYCLE_STAGES = ("new", "active", "at_risk", "churned")


def aov_minor(lifetime_value_minor: Optional[int], lifetime_orders: Optional[int]) -> Optional[int]:
    """Average order value in bigint MINOR units = lifetime_value_minor / lifetime_orders.

    Exact INTEGER division truncated toward zero (matches Spark `div`/IntegralDivide). Nullsafe:
    lifetime_orders None or <= 0 → None (never a divide-by-zero, never a float). Per-currency — the
    caller pairs this with the SAME currency_code as lifetime_value_minor; never blended across
    currencies. Supports a negative lifetime_value (clawback).
    """
    if lifetime_value_minor is None or lifetime_orders is None or lifetime_orders <= 0:
        return None
    q = abs(lifetime_value_minor) // abs(lifetime_orders)
    return -q if lifetime_value_minor < 0 else q


def churn_score_from_risk(churn_risk: Optional[str]) -> Optional[int]:
    """Project gold_customer_scores.churn_risk (low/medium/high) onto an INTEGER 0-100 risk score.

    Own integer seam — never blended with money, never a confidence. Unknown/None band → None (no
    scores row yet for this customer).
    """
    if churn_risk is None:
        return None
    return _CHURN_RISK_TO_SCORE.get(churn_risk.lower())


def lifecycle_stage(health_band: Optional[str], lifetime_orders: Optional[int]) -> Optional[str]:
    """Deterministic customer lifecycle stage folded from gold_customer_health.health_band + order count.

    Closed set {new, active, at_risk, churned}:
      - no health row (health_band None)            → None
      - health_band 'churned'                       → 'churned'
      - health_band 'at_risk'                        → 'at_risk'
      - health_band 'healthy' AND <= 1 order        → 'new'      (just acquired)
      - health_band 'healthy' AND  > 1 order        → 'active'   (repeat, recent)
    """
    if health_band is None:
        return None
    if health_band == "churned":
        return "churned"
    if health_band == "at_risk":
        return "at_risk"
    if health_band == "healthy":
        return "new" if (lifetime_orders is None or lifetime_orders <= 1) else "active"
    return None


def pick_mode(values: List[Optional[str]]) -> Optional[str]:
    """Deterministic mode of a list of strings: the most-frequent value, tie-broken by the
    lexicographically smallest value. None / empty-string entries are ignored. Empty input → None.

    This is the PURE reference for the Spark window mode (preferred_channel / preferred_device /
    top_category): COUNT(*) per value, ORDER BY count DESC, value ASC, take the first.
    """
    counts: dict[str, int] = {}
    for v in values:
        if v is None or v == "":
            continue
        counts[v] = counts.get(v, 0) + 1
    if not counts:
        return None
    # max count, then lexicographically smallest value among the ties (count DESC, value ASC).
    return min(counts, key=lambda k: (-counts[k], k))
