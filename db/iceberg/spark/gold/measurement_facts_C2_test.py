"""
measurement_facts_C2_test.py — pure (no-Spark) contract test for the SPEC:C.2 measurement fact tables.

Asserts the invariant contract the Wave C fact tables MUST satisfy WITHOUT a Spark session (so it runs in CI
next to the other pure gold tests):

  C.2.1  refund reason_code taxonomy — RTO is FIRST-CLASS and matched before the generic 'return' bucket
         (the shared pure classifier _measurement_taxonomy.classify_reason_code).
  §1.2   MONEY — every *_minor money column is `bigint` AND its table carries a `currency_code` sibling
         (integer minor units + explicit currency, never a blended float).
  C.2    KEY — order-linked facts are keyed (brand_id, order_id, event_id); brand_id is the FIRST column.
  C.2    LINEAGE — every fact carries source_system/source_event_id (or, for the inventory movement fact,
         source/source_event_id).

Run: python3 db/iceberg/spark/gold/measurement_facts_C2_test.py   (exit 0 = green, 1 = failure)
"""
from __future__ import annotations

import os
import re
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
_SILVER_DIR = os.path.join(os.path.dirname(_GOLD_DIR), "silver")
sys.path.insert(0, _SILVER_DIR)

from _measurement_taxonomy import classify_reason_code  # noqa: E402

_FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        _FAILURES.append(msg)


# ── column parsing (regex, no pyspark) ────────────────────────────────────────────────────────────────
_COLUMNS_RE = re.compile(r'COLUMNS_SQL\s*=\s*"""(.*?)"""', re.DOTALL)


def _columns_of(job_file: str) -> list[tuple[str, str]]:
    """Return [(name, type_lower)] parsed from the job's COLUMNS_SQL block."""
    with open(os.path.join(_GOLD_DIR, job_file), "r", encoding="utf-8") as fh:
        m = _COLUMNS_RE.search(fh.read())
    assert m, f"{job_file}: no COLUMNS_SQL block found"
    cols: list[tuple[str, str]] = []
    for raw in m.group(1).splitlines():
        line = raw.strip().rstrip(",").strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        name, rest = parts[0], parts[1]
        col_type = rest.lower().replace("not null", "").strip()
        cols.append((name, col_type))
    return cols


MONEY_COLS = {"amount_minor", "gross_minor", "net_minor", "fees_minor", "fee_minor", "cost_minor"}

# job_file → (order_linked, lineage_cols)
FACTS = {
    "gold_measurement_refunds.py": (True, {"source_system", "source_event_id"}),
    "gold_measurement_settlements.py": (True, {"source_system", "source_event_id"}),
    "gold_measurement_fees.py": (True, {"source_system", "source_event_id"}),
    "gold_measurement_costs.py": (True, {"source_system", "source_event_id"}),
    "gold_product_costs.py": (False, {"source_system", "source_event_id"}),
    "gold_measurement_inventory.py": (False, {"source", "source_event_id"}),
}


def test_reason_code_taxonomy_rto_first_class() -> None:
    # SPEC:C.2.1 — RTO is first-class and beats the generic 'return' bucket.
    check(classify_reason_code("RTO initiated") == "rto", "reason_code: 'RTO initiated' != rto")
    check(classify_reason_code("Return to origin (undelivered)") == "rto", "reason_code: RTO-phrase != rto")
    check(classify_reason_code("customer wants a return") == "return", "reason_code: generic return misfiled")
    check(classify_reason_code("damaged in transit") == "damaged", "reason_code: damaged misfiled")
    check(classify_reason_code("order cancelled") == "cancellation", "reason_code: cancel misfiled")
    check(classify_reason_code("changed my mind") == "customer_request", "reason_code: noted default wrong")
    check(classify_reason_code("") == "other", "reason_code: empty note not 'other'")
    check(classify_reason_code(None) == "other", "reason_code: None not 'other'")
    # ordering: a note containing BOTH 'rto' and 'return' must resolve to rto (rto rule precedes return).
    check(classify_reason_code("RTO — return to origin") == "rto", "reason_code: rto must precede return")


def test_money_is_bigint_minor_with_currency() -> None:
    # §1.2 — money = integer minor units + explicit currency sibling; never a float.
    for job in FACTS:
        cols = _columns_of(job)
        names = {n for n, _ in cols}
        money_present = names & MONEY_COLS
        for name, typ in cols:
            if name in MONEY_COLS:
                check(typ.startswith("bigint"), f"{job}: money col {name} is '{typ}', must be bigint")
        if money_present:
            check("currency_code" in names, f"{job}: has money {money_present} but no currency_code sibling")


def test_key_and_lineage() -> None:
    for job, (order_linked, lineage) in FACTS.items():
        cols = _columns_of(job)
        names = [n for n, _ in cols]
        nameset = set(names)
        # brand_id FIRST (tenant key, §0.5 / MT-1).
        check(names[0] == "brand_id", f"{job}: first column is {names[0]!r}, must be brand_id")
        # order-linked facts keyed (brand_id, order_id, event_id).
        if order_linked:
            check("order_id" in nameset, f"{job}: order-linked fact missing order_id")
            check("event_id" in nameset, f"{job}: order-linked fact missing event_id")
        # lineage columns present.
        for lc in lineage:
            check(lc in nameset, f"{job}: missing lineage column {lc}")


def test_refunds_taxonomy_columns() -> None:
    # C.2.1 additive columns the extended fact must expose.
    cols = {n for n, _ in _columns_of("gold_measurement_refunds.py")}
    for required in ("order_line_id", "reason_code", "refund_method", "initiated_at", "settled_at"):
        check(required in cols, f"gold_measurement_refunds missing {required}")


def test_costs_has_reverse_logistics_lane() -> None:
    # C.2.4 — reverse logistics is a captured cost. The cost_type lane is asserted in the job SQL.
    with open(os.path.join(_GOLD_DIR, "gold_measurement_costs.py"), "r", encoding="utf-8") as fh:
        body = fh.read()
    check("shipping_reverse" in body, "gold_measurement_costs missing shipping_reverse (RTO) lane")
    check("shipping_forward" in body, "gold_measurement_costs missing shipping_forward lane")
    check("packaging" in body and "cogs" in body, "gold_measurement_costs missing packaging/cogs lanes")


def main() -> int:
    tests = [
        test_reason_code_taxonomy_rto_first_class,
        test_money_is_bigint_minor_with_currency,
        test_key_and_lineage,
        test_refunds_taxonomy_columns,
        test_costs_has_reverse_logistics_lane,
    ]
    for t in tests:
        try:
            t()
            print(f"  ✓ {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            _FAILURES.append(f"{t.__name__} raised: {exc}")
            print(f"  ✗ {t.__name__}: {exc}")
    if _FAILURES:
        print("\nFAIL — C.2 measurement-fact contract:")
        for f in _FAILURES:
            print(f"  - {f}")
        return 1
    print("\nPASS — SPEC:C.2 measurement-fact contract green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
