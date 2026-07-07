# SPEC:C.2.1
"""
_measurement_taxonomy.py — the PURE (no-Spark) refund reason_code taxonomy shared by silver_refund's Spark
CASE and the C.2 unit test. Single source of truth so the Spark expression and the Python classifier can
NEVER drift.

reason_code taxonomy (SPEC:C.2.1) — RTO ("return to origin") is a FIRST-CLASS reason_code and is matched
before the generic 'return' bucket because an RTO is economically distinct (drives reverse-logistics cost
in gold_measurement_costs + a revenue reversal in the ledger). Rules are ordered; first match wins.
"""
from __future__ import annotations

# Ordered (substring-tuple, reason_code) rules — first match wins. Applied to the lowercased refund note.
REASON_CODE_RULES = (
    (("rto", "return to origin", "undelivered"), "rto"),
    (("damage", "defect", "broken"), "damaged"),
    (("cancel",), "cancellation"),
    (("return", "exchange"), "return"),
)
DEFAULT_WITH_NOTE = "customer_request"  # a note exists but matches no rule
DEFAULT_EMPTY = "other"                 # no note at all


def classify_reason_code(reason):
    """Map a free-text refund note → the normalized reason_code taxonomy. Pure + deterministic."""
    if reason is None:
        return DEFAULT_EMPTY
    r = str(reason).strip().lower()
    if r == "":
        return DEFAULT_EMPTY
    for substrings, code in REASON_CODE_RULES:
        if any(s in r for s in substrings):
            return code
    return DEFAULT_WITH_NOTE
